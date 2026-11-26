import { ARR_ACTIONS } from "./arr-actions";
import { CLEANUPARR_ACTIONS } from "./cleanuparr-actions";
import { WriteError } from "./errors";
import { login } from "./services/qbittorrent";
import type { PlanChange } from "./store";
import { baseUrl, getJson, request, requireSecret, type ServiceName } from "./upstream";
import type { Ctx } from "./types";

/**
 * Le uniche modifiche possibili: un elenco chiuso, ognuna con i suoi limiti.
 * Ogni azione sa: validare l'input, calcolare cosa cambierebbe (senza cambiare nulla), verificare che lo stato
 * sia ancora quello del piano e infine applicarlo. Tutte sono reversibili con un'altra azione.
 */

export interface PlanDraft {
  summary: string;
  changes: PlanChange[];
  undo: { action: string; input: Record<string, unknown> } | null;
}

export interface ActionDef {
  name: string;
  /** Servizi che l'azione modifica. Proxmox è escluso dal tipo: si modifica solo a mano. */
  services: Array<Exclude<ServiceName, "proxmox">>;
  description: string;
  scope: string;
  inputSchema: Record<string, unknown>;
  /** Valida e normalizza l'input, oppure solleva WriteError. */
  parse(input: unknown): Record<string, unknown>;
  /** Cosa cambierebbe. NON modifica nulla. */
  plan(ctx: Ctx, input: Record<string, unknown>): Promise<PlanDraft>;
  /** Il valore attuale è ancora quello su cui è stato calcolato il piano? */
  stillValid(ctx: Ctx, input: Record<string, unknown>, changes: PlanChange[]): Promise<boolean>;
  /** Applica e verifica. Restituisce un messaggio breve. */
  apply(ctx: Ctx, input: Record<string, unknown>): Promise<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// --- qBittorrent: limiti di coda e di banda -------------------------------------------------------------------

/** Impostazioni ammesse: interi con limiti, oppure vero/falso. Niente percorsi, credenziali, rete o azioni al raggiungimento del rapporto. */
type QbtField = { type: "int"; min: number; max: number } | { type: "bool" };
const QBT_FIELDS: Record<string, QbtField> = {
  max_active_downloads: { type: "int", min: 1, max: 100 },
  max_active_uploads: { type: "int", min: 1, max: 100 },
  max_active_torrents: { type: "int", min: 1, max: 200 },
  max_active_checking_torrents: { type: "int", min: 1, max: 10 },
  dl_limit: { type: "int", min: 0, max: 2_000_000_000 }, // byte/secondo, 0 = illimitato
  up_limit: { type: "int", min: 0, max: 2_000_000_000 },
  alt_dl_limit: { type: "int", min: 0, max: 2_000_000_000 }, // limiti della modalità alternativa
  alt_up_limit: { type: "int", min: 0, max: 2_000_000_000 },
  max_connec: { type: "int", min: 1, max: 5000 },
  max_connec_per_torrent: { type: "int", min: 1, max: 1000 },
  max_uploads: { type: "int", min: 1, max: 500 },
  max_uploads_per_torrent: { type: "int", min: 1, max: 100 },
  queueing_enabled: { type: "bool" },
  dont_count_slow_torrents: { type: "bool" },
  slow_torrent_dl_rate_threshold: { type: "int", min: 1, max: 100_000 }, // KiB/s
  slow_torrent_ul_rate_threshold: { type: "int", min: 1, max: 100_000 },
  slow_torrent_inactive_timer: { type: "int", min: 1, max: 3600 }, // secondi
};
const qbtLabel = (field: QbtField) => (field.type === "bool" ? "vero/falso" : `${field.min}-${field.max}`);

async function readQbtPreferences(ctx: Ctx): Promise<{ base: string; headers: Record<string, string>; prefs: Record<string, unknown> }> {
  const base = baseUrl(ctx.env, "qbittorrent");
  const headers = { Cookie: await login(ctx, base), Referer: base };
  const prefs = await getJson<Record<string, unknown>>(ctx, `${base}/api/v2/app/preferences`, { headers });
  return { base, headers, prefs };
}

const qbittorrentPreferences: ActionDef = {
  name: "qbittorrent_preferences",
  services: ["qbittorrent"],
  description:
    "qBittorrent: cambia i limiti di coda, di connessioni e di banda e come si contano i torrent lenti. Chiavi ammesse: " +
    Object.entries(QBT_FIELDS).map(([key, field]) => `${key} (${qbtLabel(field)})`).join(", ") + ".",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      changes: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(QBT_FIELDS).map(([key, field]) => [key, field.type === "bool" ? { type: "boolean" } : { type: "integer", minimum: field.min, maximum: field.max }]),
        ),
        additionalProperties: false,
      },
    },
    required: ["changes"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || !isRecord(input.changes)) throw new WriteError("invalid_input", "Serve un oggetto `changes` con le impostazioni da cambiare");
    const out: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(input.changes)) {
      const field = QBT_FIELDS[key];
      if (!field) throw new WriteError("invalid_input", `Impostazione non modificabile: ${key}`);
      if (field.type === "bool") {
        if (typeof value !== "boolean") throw new WriteError("invalid_input", `${key} deve essere true o false`);
      } else if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) {
        throw new WriteError("invalid_input", `${key} deve essere un intero tra ${field.min} e ${field.max}`);
      }
      out[key] = value;
    }
    if (Object.keys(out).length === 0) throw new WriteError("invalid_input", "Nessuna impostazione indicata");
    return { changes: out };
  },
  async plan(ctx, input) {
    const wanted = input.changes as Record<string, number | boolean>;
    const { prefs } = await readQbtPreferences(ctx);
    const changes: PlanChange[] = [];
    const before: Record<string, number | boolean> = {};
    for (const [key, to] of Object.entries(wanted)) {
      const from = prefs[key];
      if (from === to) continue;
      changes.push({ target: "qBittorrent", field: key, from, to });
      if (typeof from === "number" || typeof from === "boolean") before[key] = from;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    return {
      summary: `qBittorrent: cambia ${changes.map((change) => change.field).join(", ")}`,
      changes,
      undo: Object.keys(before).length === changes.length ? { action: "qbittorrent_preferences", input: { changes: before } } : null,
    };
  },
  async stillValid(ctx, _input, changes) {
    const { prefs } = await readQbtPreferences(ctx);
    return changes.every((change) => prefs[change.field] === change.from);
  },
  async apply(ctx, input) {
    const wanted = input.changes as Record<string, number | boolean>;
    const { base, headers } = await readQbtPreferences(ctx);
    await request(ctx, `${base}/api/v2/app/setPreferences`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ json: JSON.stringify(wanted) }),
    });
    const after = await readQbtPreferences(ctx);
    const wrong = Object.entries(wanted).filter(([key, value]) => after.prefs[key] !== value);
    if (wrong.length) throw new Error("Verifica fallita: qBittorrent non riporta i nuovi valori");
    return `Applicato e verificato: ${Object.entries(wanted).map(([key, value]) => `${key}=${value}`).join(", ")}`;
  },
};

// --- Prowlarr: attiva/disattiva un indexer ----------------------------------------------------------------------

interface ProwlarrIndexer {
  id?: number;
  name?: string;
  enable?: boolean;
  [key: string]: unknown;
}

async function prowlarrAccess(ctx: Ctx): Promise<{ base: string; headers: Record<string, string> }> {
  const key = requireSecret(ctx.env.PROWLARR_API_KEY, "prowlarr");
  return { base: baseUrl(ctx.env, "prowlarr"), headers: { "X-Api-Key": key } };
}

async function readIndexer(ctx: Ctx, id: number): Promise<ProwlarrIndexer> {
  const { base, headers } = await prowlarrAccess(ctx);
  try {
    return await getJson<ProwlarrIndexer>(ctx, `${base}/api/v1/indexer/${id}`, { headers });
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) throw new WriteError("not_found", `Indexer ${id} non trovato`);
    throw error;
  }
}

const prowlarrIndexerEnabled: ActionDef = {
  name: "prowlarr_indexer_enabled",
  services: ["prowlarr"],
  description: "Prowlarr: attiva o disattiva un indexer (l'`id` si legge da get_config_prowlarr).",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: { indexerId: { type: "integer", minimum: 1 }, enable: { type: "boolean" } },
    required: ["indexerId", "enable"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input)) throw new WriteError("invalid_input", "Input non valido");
    const unknown = Object.keys(input).filter((key) => key !== "indexerId" && key !== "enable");
    if (unknown.length) throw new WriteError("invalid_input", `Campi non ammessi: ${unknown.join(", ")}`);
    if (typeof input.indexerId !== "number" || !Number.isInteger(input.indexerId) || input.indexerId < 1) throw new WriteError("invalid_input", "indexerId deve essere un intero positivo");
    if (typeof input.enable !== "boolean") throw new WriteError("invalid_input", "enable deve essere true o false");
    return { indexerId: input.indexerId, enable: input.enable };
  },
  async plan(ctx, input) {
    const id = input.indexerId as number;
    const to = input.enable as boolean;
    const indexer = await readIndexer(ctx, id);
    const from = indexer.enable === true;
    if (from === to) throw new WriteError("no_change", `L'indexer "${indexer.name ?? id}" è già ${to ? "attivo" : "disattivato"}`);
    return {
      summary: `Prowlarr: ${to ? "attiva" : "disattiva"} l'indexer "${indexer.name ?? id}"`,
      changes: [{ target: `Prowlarr: indexer "${indexer.name ?? id}" (id ${id})`, field: "enable", from, to }],
      undo: { action: "prowlarr_indexer_enabled", input: { indexerId: id, enable: from } },
    };
  },
  async stillValid(ctx, input, changes) {
    return (await readIndexer(ctx, input.indexerId as number)).enable === changes[0]?.from;
  },
  async apply(ctx, input) {
    const id = input.indexerId as number;
    const to = input.enable as boolean;
    const { base, headers } = await prowlarrAccess(ctx);
    // L'oggetto completo (con le credenziali dell'indexer) passa solo da qui, dal gateway a Prowlarr: non esce mai.
    const full = await readIndexer(ctx, id);
    await request(ctx, `${base}/api/v1/indexer/${id}?forceSave=true`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...full, enable: to }),
    });
    const after = await readIndexer(ctx, id);
    if ((after.enable === true) !== to) throw new Error("Verifica fallita: Prowlarr non riporta il nuovo stato");
    return `Applicato e verificato: indexer "${full.name ?? id}" ${to ? "attivo" : "disattivato"}`;
  },
};

// --- Prowlarr: obiettivi di semina di un indexer -----------------------------------------------------------------------

/** Voci di `fields` che si possono cambiare: solo queste tre, per nome esatto. Il resto dell'array (chiavi, cookie, indirizzi) passa intatto. */
const SEED_FIELD_NAMES: Record<string, string> = {
  seedRatio: "torrentBaseSettings.seedRatio",
  seedTimeMinutes: "torrentBaseSettings.seedTime",
  packSeedTimeMinutes: "torrentBaseSettings.packSeedTime",
};

const prowlarrSeedGoals: ActionDef = {
  name: "prowlarr_indexer_seed_goals",
  services: ["prowlarr"],
  description:
    "Prowlarr: imposta gli obiettivi di semina di un indexer, cioè il rapporto (seedRatio, 0-100) e i minuti di semina per i singoli torrent (seedTimeMinutes) e per i pacchetti di stagione (packSeedTimeMinutes), 0-525600 (1 anno). " +
    "Radarr, Sonarr e qBittorrent li usano per non rimuovere i torrent prima del tempo richiesto dal tracker. L'`id` si legge da get_config_prowlarr.",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      indexerId: { type: "integer", minimum: 1 },
      changes: {
        type: "object",
        properties: {
          seedRatio: { type: "number", minimum: 0, maximum: 100 },
          seedTimeMinutes: { type: "integer", minimum: 0, maximum: 525_600 },
          packSeedTimeMinutes: { type: "integer", minimum: 0, maximum: 525_600 },
        },
        additionalProperties: false,
      },
    },
    required: ["indexerId", "changes"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "indexerId" && key !== "changes")) throw new WriteError("invalid_input", "Input non valido");
    if (typeof input.indexerId !== "number" || !Number.isInteger(input.indexerId) || input.indexerId < 1) throw new WriteError("invalid_input", "indexerId deve essere un intero positivo");
    if (!isRecord(input.changes)) throw new WriteError("invalid_input", "Serve un oggetto `changes`");
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(input.changes)) {
      if (!(key in SEED_FIELD_NAMES)) throw new WriteError("invalid_input", `Impostazione non modificabile: ${key}`);
      if (typeof value !== "number" || !Number.isFinite(value)) throw new WriteError("invalid_input", `${key} deve essere un numero`);
      if (key === "seedRatio") {
        if (value < 0 || value > 100) throw new WriteError("invalid_input", "seedRatio deve essere tra 0 e 100");
      } else if (!Number.isInteger(value) || value < 0 || value > 525_600) {
        throw new WriteError("invalid_input", `${key} deve essere un intero tra 0 e 525600`);
      }
      out[key] = value;
    }
    if (Object.keys(out).length === 0) throw new WriteError("invalid_input", "Nessuna impostazione indicata");
    return { indexerId: input.indexerId, changes: out };
  },
  async plan(ctx, input) {
    const id = input.indexerId as number;
    const wanted = input.changes as Record<string, number>;
    const indexer = await readIndexer(ctx, id);
    const fields = Array.isArray(indexer.fields) ? (indexer.fields as Array<{ name?: string; value?: unknown }>) : [];
    const changes: PlanChange[] = [];
    const before: Record<string, number> = {};
    for (const [key, to] of Object.entries(wanted)) {
      const field = fields.find((candidate) => candidate && candidate.name === SEED_FIELD_NAMES[key]);
      if (!field) throw new WriteError("not_supported", `L'indexer "${indexer.name ?? id}" non ha l'impostazione ${key}`);
      const from = typeof field.value === "number" ? field.value : null;
      if (from === to) continue;
      changes.push({ target: `Prowlarr: indexer "${indexer.name ?? id}" (id ${id})`, field: key, from, to });
      if (from !== null) before[key] = from;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    return {
      summary: `Prowlarr: obiettivi di semina dell'indexer "${indexer.name ?? id}": ${changes.map((change) => change.field).join(", ")}`,
      changes,
      undo: Object.keys(before).length === changes.length ? { action: "prowlarr_indexer_seed_goals", input: { indexerId: id, changes: before } } : null,
    };
  },
  async stillValid(ctx, input, changes) {
    const fields = (await readIndexer(ctx, input.indexerId as number)).fields;
    const list = Array.isArray(fields) ? (fields as Array<{ name?: string; value?: unknown }>) : [];
    return changes.every((change) => {
      const value = list.find((field) => field && field.name === SEED_FIELD_NAMES[change.field])?.value;
      return (typeof value === "number" ? value : null) === change.from;
    });
  },
  async apply(ctx, input) {
    const id = input.indexerId as number;
    const wanted = input.changes as Record<string, number>;
    const { base, headers } = await prowlarrAccess(ctx);
    // L'oggetto completo (con le credenziali) passa solo da qui, dal gateway a Prowlarr: non esce mai.
    const full = await readIndexer(ctx, id);
    const names = new Map(Object.entries(wanted).map(([key, value]) => [SEED_FIELD_NAMES[key]!, value]));
    const fields = (Array.isArray(full.fields) ? (full.fields as Array<Record<string, unknown>>) : []).map((field) => (names.has(String(field.name)) ? { ...field, value: names.get(String(field.name)) } : field));
    await request(ctx, `${base}/api/v1/indexer/${id}?forceSave=true`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...full, fields }),
    });
    const after = await readIndexer(ctx, id);
    const list = Array.isArray(after.fields) ? (after.fields as Array<{ name?: string; value?: unknown }>) : [];
    for (const [key, value] of Object.entries(wanted)) {
      if (list.find((field) => field && field.name === SEED_FIELD_NAMES[key])?.value !== value) throw new Error("Verifica fallita: Prowlarr non riporta i nuovi valori");
    }
    return `Applicato e verificato: obiettivi di semina dell'indexer "${full.name ?? id}": ${Object.entries(wanted).map(([key, value]) => `${key}=${value}`).join(", ")}`;
  },
};

export const ACTIONS: ActionDef[] = [qbittorrentPreferences, prowlarrIndexerEnabled, prowlarrSeedGoals, ...ARR_ACTIONS, ...CLEANUPARR_ACTIONS];

export function findAction(name: string): ActionDef | undefined {
  return ACTIONS.find((action) => action.name === name);
}
