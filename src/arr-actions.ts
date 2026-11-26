import type { ActionDef, PlanDraft } from "./actions";
import { WriteError } from "./errors";
import { arrAccess, type ArrService } from "./services/arr";
import type { PlanChange } from "./store";
import { getJson, request } from "./upstream";
import type { Ctx } from "./types";

/**
 * Modifiche a Radarr e Sonarr: profili di ritardo, flag di indexer e client di download, profili di qualità e punteggi dei formati.
 * Come per le altre azioni: si cambiano SOLO i campi elencati, con i loro limiti; il resto dell'oggetto (comprese le credenziali di
 * indexer e client) passa dal gateway al servizio e non esce mai; dopo la scrittura si rilegge e si verifica.
 */

const SERVICES = ["radarr", "sonarr"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Field = { type: "bool" } | { type: "int"; min: number; max: number } | { type: "enum"; values: readonly string[] };
type Fields = Record<string, Field>;

const fieldSchema = (field: Field) =>
  field.type === "bool" ? { type: "boolean" } : field.type === "int" ? { type: "integer", minimum: field.min, maximum: field.max } : { type: "string", enum: field.values };

const describeFields = (fields: Fields) =>
  Object.entries(fields).map(([key, f]) => (f.type === "int" ? `${key} (${f.min}..${f.max})` : f.type === "enum" ? `${key} (${f.values.join("|")})` : `${key} (vero/falso)`)).join(", ");

function parseServiceAndId(input: unknown, extraKeys: readonly string[]): { service: ArrService; id: number; raw: Record<string, unknown> } {
  if (!isRecord(input)) throw new WriteError("invalid_input", "Input non valido");
  const unknown = Object.keys(input).filter((key) => !["service", "id", ...extraKeys].includes(key));
  if (unknown.length) throw new WriteError("invalid_input", `Campi non ammessi: ${unknown.join(", ")}`);
  if (input.service !== "radarr" && input.service !== "sonarr") throw new WriteError("invalid_input", "service deve essere radarr o sonarr");
  if (typeof input.id !== "number" || !Number.isInteger(input.id) || input.id < 1 || input.id > 1_000_000) throw new WriteError("invalid_input", "id deve essere un intero positivo");
  return { service: input.service, id: input.id, raw: input };
}

function parseChanges(raw: unknown, fields: Fields): Record<string, unknown> {
  if (!isRecord(raw)) throw new WriteError("invalid_input", "Serve un oggetto `changes`");
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = fields[key];
    if (!field) throw new WriteError("invalid_input", `Impostazione non modificabile: ${key}`);
    if (field.type === "bool") {
      if (typeof value !== "boolean") throw new WriteError("invalid_input", `${key} deve essere true o false`);
    } else if (field.type === "int") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) throw new WriteError("invalid_input", `${key} deve essere un intero tra ${field.min} e ${field.max}`);
    } else if (typeof value !== "string" || !field.values.includes(value)) {
      throw new WriteError("invalid_input", `${key} deve essere uno tra: ${field.values.join(", ")}`);
    }
    out[key] = value;
  }
  return out;
}

async function readObject(ctx: Ctx, service: ArrService, resource: string, id: number): Promise<Record<string, unknown>> {
  const { base, headers } = arrAccess(ctx, service);
  try {
    return await getJson<Record<string, unknown>>(ctx, `${base}/api/v3/${resource}/${id}`, { headers });
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) throw new WriteError("not_found", `${resource} ${id} non trovato in ${service}`);
    throw error;
  }
}

async function putObject(ctx: Ctx, service: ArrService, resource: string, id: number, body: unknown, forceSave: boolean): Promise<void> {
  const { base, headers } = arrAccess(ctx, service);
  await request(ctx, `${base}/api/v3/${resource}/${id}${forceSave ? "?forceSave=true" : ""}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

interface ObjectActionDef {
  name: string;
  label: string;
  resource: string;
  description: string;
  fields: Fields;
  forceSave: boolean;
  nameOf: (object: Record<string, unknown>, id: number) => string;
}

function objectAction(def: ObjectActionDef): ActionDef {
  const target = (service: ArrService, object: Record<string, unknown>, id: number) => `${service}: ${def.label} "${def.nameOf(object, id)}" (id ${id})`;
  return {
    name: def.name,
    services: [...SERVICES],
    description: `${def.description} Campi ammessi in changes: ${describeFields(def.fields)}. L'id si legge da get_config_radarr / get_config_sonarr.`,
    scope: "config:write",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", enum: [...SERVICES] },
        id: { type: "integer", minimum: 1 },
        changes: { type: "object", properties: Object.fromEntries(Object.entries(def.fields).map(([key, f]) => [key, fieldSchema(f)])), additionalProperties: false },
      },
      required: ["service", "id", "changes"],
      additionalProperties: false,
    },
    parse(input) {
      const { service, id, raw } = parseServiceAndId(input, ["changes"]);
      const changes = parseChanges(raw.changes, def.fields);
      if (Object.keys(changes).length === 0) throw new WriteError("invalid_input", "Nessuna impostazione indicata");
      return { service, id, changes };
    },
    async plan(ctx, input): Promise<PlanDraft> {
      const service = input.service as ArrService;
      const id = input.id as number;
      const wanted = input.changes as Record<string, unknown>;
      const object = await readObject(ctx, service, def.resource, id);
      const changes: PlanChange[] = [];
      const before: Record<string, unknown> = {};
      for (const [field, to] of Object.entries(wanted)) {
        const from = object[field];
        if (from === to) continue;
        changes.push({ target: target(service, object, id), field, from, to });
        if (typeof from === "boolean" || typeof from === "number" || typeof from === "string") before[field] = from;
      }
      if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
      return {
        summary: `${service}: cambia ${changes.map((change) => change.field).join(", ")} di ${def.label} "${def.nameOf(object, id)}"`,
        changes,
        undo: Object.keys(before).length === changes.length ? { action: def.name, input: { service, id, changes: before } } : null,
      };
    },
    async stillValid(ctx, input, changes) {
      const object = await readObject(ctx, input.service as ArrService, def.resource, input.id as number);
      return changes.every((change) => object[change.field] === change.from);
    },
    async apply(ctx, input) {
      const service = input.service as ArrService;
      const id = input.id as number;
      const wanted = input.changes as Record<string, unknown>;
      // L'oggetto completo (con eventuali credenziali) passa solo da qui, dal gateway al servizio.
      const full = await readObject(ctx, service, def.resource, id);
      await putObject(ctx, service, def.resource, id, { ...full, ...wanted }, def.forceSave);
      const after = await readObject(ctx, service, def.resource, id);
      if (Object.entries(wanted).some(([key, value]) => after[key] !== value)) throw new Error(`Verifica fallita: ${service} non riporta i nuovi valori`);
      return `Applicato e verificato: ${def.label} "${def.nameOf(full, id)}" (${service}): ${Object.entries(wanted).map(([key, value]) => `${key}=${value}`).join(", ")}`;
    },
  };
}

const nameOrId = (object: Record<string, unknown>, id: number) => (typeof object.name === "string" && object.name ? object.name : `#${id}`);

export const arrDelayProfile = objectAction({
  name: "arr_delay_profile",
  label: "profilo di ritardo",
  resource: "delayprofile",
  description: "Radarr/Sonarr: cambia un profilo di ritardo (protocollo preferito, attese, bypass).",
  fields: {
    enableUsenet: { type: "bool" },
    enableTorrent: { type: "bool" },
    preferredProtocol: { type: "enum", values: ["usenet", "torrent"] },
    usenetDelay: { type: "int", min: 0, max: 10_080 }, // minuti, fino a 7 giorni
    torrentDelay: { type: "int", min: 0, max: 10_080 },
    bypassIfHighestQuality: { type: "bool" },
    bypassIfAboveCustomFormatScore: { type: "bool" },
    minimumCustomFormatScore: { type: "int", min: 0, max: 10_000 },
  },
  forceSave: false,
  nameOf: (_object, id) => `#${id}`,
});

export const arrIndexerFlags = objectAction({
  name: "arr_indexer_flags",
  label: "indexer",
  resource: "indexer",
  description: "Radarr/Sonarr: attiva o disattiva la ricerca di un indexer e ne cambia la priorità. Le credenziali dell'indexer non vengono toccate.",
  fields: {
    enableRss: { type: "bool" },
    enableAutomaticSearch: { type: "bool" },
    enableInteractiveSearch: { type: "bool" },
    priority: { type: "int", min: 1, max: 50 },
  },
  forceSave: true,
  nameOf: nameOrId,
});

export const arrDownloadClientFlags = objectAction({
  name: "arr_download_client_flags",
  label: "client di download",
  resource: "downloadclient",
  description: "Radarr/Sonarr: attiva o disattiva un client di download, ne cambia la priorità e se rimuove i download completati o falliti. Le credenziali non vengono toccate.",
  fields: {
    enable: { type: "bool" },
    priority: { type: "int", min: 1, max: 50 },
    removeCompletedDownloads: { type: "bool" },
    removeFailedDownloads: { type: "bool" },
  },
  forceSave: true,
  nameOf: nameOrId,
});

// --- Profili di qualità: soglie e punteggi dei formati personalizzati --------------------------------------------------

const QUALITY_FIELDS: Fields = {
  upgradeAllowed: { type: "bool" },
  minFormatScore: { type: "int", min: -10_000, max: 10_000 },
  cutoffFormatScore: { type: "int", min: 0, max: 10_000 },
  minUpgradeFormatScore: { type: "int", min: 1, max: 10_000 },
};
const SCORE_RANGE: [number, number] = [-10_000, 10_000];
const MAX_SCORES = 30;

interface FormatItem {
  format?: number;
  name?: string;
  score?: number;
}

const formatItems = (profile: Record<string, unknown>): FormatItem[] => (Array.isArray(profile.formatItems) ? (profile.formatItems as FormatItem[]) : []);

export const arrQualityProfile: ActionDef = {
  name: "arr_quality_profile",
  services: [...SERVICES],
  description:
    `Radarr/Sonarr: cambia un profilo di qualità. In changes: ${describeFields(QUALITY_FIELDS)}. ` +
    `In scores: punteggio (${SCORE_RANGE[0]}..${SCORE_RANGE[1]}) di formati personalizzati già presenti nel profilo, con chiave l'id del formato (max ${MAX_SCORES}). ` +
    "Gli id si leggono da get_config_radarr / get_config_sonarr (qualityProfiles).",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string", enum: [...SERVICES] },
      id: { type: "integer", minimum: 1 },
      changes: { type: "object", properties: Object.fromEntries(Object.entries(QUALITY_FIELDS).map(([key, f]) => [key, fieldSchema(f)])), additionalProperties: false },
      scores: { type: "object", description: "{ \"<id formato>\": punteggio }", additionalProperties: { type: "integer", minimum: SCORE_RANGE[0], maximum: SCORE_RANGE[1] } },
    },
    required: ["service", "id"],
    additionalProperties: false,
  },
  parse(input) {
    const { service, id, raw } = parseServiceAndId(input, ["changes", "scores"]);
    const changes = raw.changes === undefined ? {} : parseChanges(raw.changes, QUALITY_FIELDS);
    const scores: Record<string, number> = {};
    if (raw.scores !== undefined) {
      if (!isRecord(raw.scores)) throw new WriteError("invalid_input", "scores deve essere un oggetto { id formato: punteggio }");
      const entries = Object.entries(raw.scores);
      if (entries.length > MAX_SCORES) throw new WriteError("invalid_input", `Al massimo ${MAX_SCORES} punteggi per volta`);
      for (const [formatId, score] of entries) {
        if (!/^\d{1,9}$/.test(formatId)) throw new WriteError("invalid_input", `Id formato non valido: ${formatId}`);
        if (typeof score !== "number" || !Number.isInteger(score) || score < SCORE_RANGE[0] || score > SCORE_RANGE[1]) throw new WriteError("invalid_input", `Il punteggio del formato ${formatId} deve essere un intero tra ${SCORE_RANGE[0]} e ${SCORE_RANGE[1]}`);
        scores[formatId] = score;
      }
    }
    if (Object.keys(changes).length === 0 && Object.keys(scores).length === 0) throw new WriteError("invalid_input", "Nessuna modifica indicata");
    return { service, id, changes, scores };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const service = input.service as ArrService;
    const id = input.id as number;
    const wantedChanges = input.changes as Record<string, unknown>;
    const wantedScores = input.scores as Record<string, number>;
    const profile = await readObject(ctx, service, "qualityprofile", id);
    const label = `${service}: profilo di qualità "${nameOrId(profile, id)}" (id ${id})`;
    const changes: PlanChange[] = [];
    const beforeChanges: Record<string, unknown> = {};
    const beforeScores: Record<string, number> = {};

    for (const [field, to] of Object.entries(wantedChanges)) {
      const from = profile[field];
      if (from === to) continue;
      changes.push({ target: label, field, from, to });
      if (typeof from === "boolean" || typeof from === "number") beforeChanges[field] = from;
    }
    for (const [formatId, to] of Object.entries(wantedScores)) {
      const item = formatItems(profile).find((candidate) => String(candidate.format) === formatId);
      if (!item) throw new WriteError("invalid_input", `Il formato ${formatId} non è nel profilo: i punteggi si possono cambiare solo per i formati già presenti`);
      if (item.score === to) continue;
      changes.push({ target: label, field: `score[${formatId}] ${item.name ?? ""}`.trim(), from: item.score, to });
      if (typeof item.score === "number") beforeScores[formatId] = item.score;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    const scoreChanges = changes.filter((change) => change.field.startsWith("score[")).length;
    const reversible = Object.keys(beforeChanges).length === changes.length - scoreChanges && Object.keys(beforeScores).length === scoreChanges;
    return {
      summary: `${service}: cambia il profilo di qualità "${nameOrId(profile, id)}" (${changes.length} ${changes.length === 1 ? "modifica" : "modifiche"})`,
      changes,
      undo: reversible ? { action: "arr_quality_profile", input: { service, id, changes: beforeChanges, scores: beforeScores } } : null,
    };
  },
  async stillValid(ctx, input, changes) {
    const profile = await readObject(ctx, input.service as ArrService, "qualityprofile", input.id as number);
    return changes.every((change) => {
      const match = /^score\[(\d+)\]/.exec(change.field);
      if (match) return formatItems(profile).find((item) => String(item.format) === match[1])?.score === change.from;
      return profile[change.field] === change.from;
    });
  },
  async apply(ctx, input) {
    const service = input.service as ArrService;
    const id = input.id as number;
    const wantedChanges = input.changes as Record<string, unknown>;
    const wantedScores = input.scores as Record<string, number>;
    const full = await readObject(ctx, service, "qualityprofile", id);
    const items = formatItems(full).map((item) => (String(item.format) in wantedScores ? { ...item, score: wantedScores[String(item.format)] } : item));
    const body = { ...full, ...wantedChanges, ...(Object.keys(wantedScores).length ? { formatItems: items } : {}) };
    await putObject(ctx, service, "qualityprofile", id, body, false);
    const after = await readObject(ctx, service, "qualityprofile", id);
    const wrongField = Object.entries(wantedChanges).some(([key, value]) => after[key] !== value);
    const wrongScore = Object.entries(wantedScores).some(([formatId, value]) => formatItems(after).find((item) => String(item.format) === formatId)?.score !== value);
    if (wrongField || wrongScore) throw new Error(`Verifica fallita: ${service} non riporta i nuovi valori`);
    return `Applicato e verificato: profilo di qualità "${nameOrId(full, id)}" (${service})`;
  },
};

export const ARR_ACTIONS: ActionDef[] = [arrDelayProfile, arrIndexerFlags, arrDownloadClientFlags, arrQualityProfile];
