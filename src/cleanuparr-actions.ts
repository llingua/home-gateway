import type { ActionDef, PlanDraft } from "./actions";
import { WriteError } from "./errors";
import type { PlanChange } from "./store";
import { baseUrl, getJson, request, requireSecret } from "./upstream";
import type { Ctx } from "./types";

/**
 * Modifiche a Cleanuparr: opzioni generali e soglia delle importazioni fallite per Radarr/Sonarr.
 *
 * Le PUT di Cleanuparr sostituiscono l'intero oggetto (un campo omesso torna al valore predefinito): per questo si rilegge
 * l'oggetto completo, si cambia SOLO il campo indicato e si rimanda tutto. Quello che il gateway non tocca (reti fidate,
 * impostazioni di accesso, registri) resta com'è e non esce mai dal gateway. Dopo la scrittura si rilegge e si verifica.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function access(ctx: Ctx): { base: string; headers: Record<string, string> } {
  return { base: baseUrl(ctx.env, "cleanuparr"), headers: { "X-Api-Key": requireSecret(ctx.env.CLEANUPARR_API_KEY, "cleanuparr") } };
}

async function readJson(ctx: Ctx, path: string): Promise<Record<string, unknown>> {
  const { base, headers } = access(ctx);
  const value = await getJson<unknown>(ctx, `${base}${path}`, { headers });
  if (!isRecord(value)) throw new WriteError("unexpected_response", "Cleanuparr ha risposto in un formato inatteso");
  return value;
}

async function putJson(ctx: Ctx, path: string, body: unknown): Promise<void> {
  const { base, headers } = access(ctx);
  await request(ctx, `${base}${path}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

/** Il nome vero della chiave (Cleanuparr risponde in camelCase, ma non ci si fa affidamento). */
const keyOf = (object: Record<string, unknown>, name: string): string | undefined => Object.keys(object).find((key) => key.toLowerCase() === name.toLowerCase());
const valueOf = (object: Record<string, unknown>, name: string): unknown => {
  const key = keyOf(object, name);
  return key === undefined ? undefined : object[key];
};

// --- Opzioni generali -------------------------------------------------------------------------------------------

type Field = { type: "bool" } | { type: "int"; min: number; max: number };
const GENERAL_FIELDS: Record<string, Field> = {
  httpMaxRetries: { type: "int", min: 0, max: 10 },
  httpTimeout: { type: "int", min: 10, max: 600 }, // secondi
  connectivityCheckEnabled: { type: "bool" },
  statusCheckEnabled: { type: "bool" },
  strikeInactivityWindowHours: { type: "int", min: 1, max: 168 },
  historyRetentionDays: { type: "int", min: 1, max: 3650 },
};

const describe = (fields: Record<string, Field>) => Object.entries(fields).map(([key, f]) => (f.type === "int" ? `${key} (${f.min}-${f.max})` : `${key} (vero/falso)`)).join(", ");

export const cleanuparrGeneral: ActionDef = {
  name: "cleanuparr_general",
  services: ["cleanuparr"],
  description: `Cleanuparr: cambia le opzioni generali. Chiavi ammesse: ${describe(GENERAL_FIELDS)}. Non tocca modalità di prova (dry run), reti fidate, accesso né registri.`,
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      changes: {
        type: "object",
        properties: Object.fromEntries(Object.entries(GENERAL_FIELDS).map(([key, f]) => [key, f.type === "bool" ? { type: "boolean" } : { type: "integer", minimum: f.min, maximum: f.max }])),
        additionalProperties: false,
      },
    },
    required: ["changes"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || !isRecord(input.changes) || Object.keys(input).some((key) => key !== "changes")) throw new WriteError("invalid_input", "Serve un oggetto `changes` con le impostazioni da cambiare");
    const out: Record<string, number | boolean> = {};
    for (const [key, value] of Object.entries(input.changes)) {
      const field = GENERAL_FIELDS[key];
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
  async plan(ctx, input): Promise<PlanDraft> {
    const wanted = input.changes as Record<string, number | boolean>;
    const general = await readJson(ctx, "/api/configuration/general");
    const urls = valueOf(general, "connectivityCheckUrls");
    if (wanted.connectivityCheckEnabled === true && (!Array.isArray(urls) || urls.length === 0)) {
      throw new WriteError("invalid_input", "Per accendere il controllo di connettività servono indirizzi di controllo: impostali una volta nell'interfaccia di Cleanuparr");
    }
    const changes: PlanChange[] = [];
    const before: Record<string, number | boolean> = {};
    for (const [field, to] of Object.entries(wanted)) {
      const from = valueOf(general, field);
      if (from === to) continue;
      changes.push({ target: "Cleanuparr: opzioni generali", field, from, to });
      if (typeof from === "number" || typeof from === "boolean") before[field] = from;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    return {
      summary: `Cleanuparr: cambia ${changes.map((change) => change.field).join(", ")}`,
      changes,
      undo: Object.keys(before).length === changes.length ? { action: "cleanuparr_general", input: { changes: before } } : null,
    };
  },
  async stillValid(ctx, _input, changes) {
    const general = await readJson(ctx, "/api/configuration/general");
    return changes.every((change) => valueOf(general, change.field) === change.from);
  },
  async apply(ctx, input) {
    const wanted = input.changes as Record<string, number | boolean>;
    const full = await readJson(ctx, "/api/configuration/general");
    const body: Record<string, unknown> = { ...full };
    for (const [field, value] of Object.entries(wanted)) {
      const key = keyOf(full, field);
      if (key === undefined) throw new WriteError("unexpected_response", `Cleanuparr non riporta l'impostazione ${field}`);
      body[key] = value;
    }
    await putJson(ctx, "/api/configuration/general", body);
    const after = await readJson(ctx, "/api/configuration/general");
    if (Object.entries(wanted).some(([field, value]) => valueOf(after, field) !== value)) throw new Error("Verifica fallita: Cleanuparr non riporta i nuovi valori");
    return `Applicato e verificato: ${Object.entries(wanted).map(([field, value]) => `${field}=${value}`).join(", ")}`;
  },
};

// --- Soglia delle importazioni fallite per Radarr/Sonarr ----------------------------------------------------------

const ARR_TYPES = ["sonarr", "radarr"] as const;
type ArrType = (typeof ARR_TYPES)[number];

/** -1 = usa la soglia della pulizia della coda; 0 = spento per questo servizio; da 3 in su = soglia propria (1 e 2 sono rifiutati da Cleanuparr). */
const validStrikes = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && (value === -1 || value === 0 || (value >= 3 && value <= 100));

export const cleanuparrArrFailedImport: ActionDef = {
  name: "cleanuparr_arr_failed_import",
  services: ["cleanuparr"],
  description:
    "Cleanuparr: soglia dei tentativi per le importazioni fallite di Radarr o Sonarr (failedImportMaxStrikes). " +
    "-1 = usa la soglia della pulizia della coda; 0 = spento per quel servizio; da 3 a 100 = soglia propria.",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: { service: { type: "string", enum: [...ARR_TYPES] }, failedImportMaxStrikes: { type: "integer", minimum: -1, maximum: 100 } },
    required: ["service", "failedImportMaxStrikes"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "service" && key !== "failedImportMaxStrikes")) throw new WriteError("invalid_input", "Input non valido");
    if (input.service !== "sonarr" && input.service !== "radarr") throw new WriteError("invalid_input", "service deve essere sonarr o radarr");
    if (!validStrikes(input.failedImportMaxStrikes)) throw new WriteError("invalid_input", "failedImportMaxStrikes deve essere -1, 0 oppure un intero da 3 a 100");
    return { service: input.service, failedImportMaxStrikes: input.failedImportMaxStrikes };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const service = input.service as ArrType;
    const to = input.failedImportMaxStrikes as number;
    const from = valueOf(await readJson(ctx, `/api/configuration/${service}`), "failedImportMaxStrikes");
    if (from === to) throw new WriteError("no_change", "Nessuna modifica: il valore è già questo");
    return {
      summary: `Cleanuparr: soglia delle importazioni fallite di ${service}: ${String(from)} → ${to}`,
      changes: [{ target: `Cleanuparr: ${service}`, field: "failedImportMaxStrikes", from, to }],
      undo: validStrikes(from) ? { action: "cleanuparr_arr_failed_import", input: { service, failedImportMaxStrikes: from } } : null,
    };
  },
  async stillValid(ctx, input, changes) {
    return valueOf(await readJson(ctx, `/api/configuration/${input.service as ArrType}`), "failedImportMaxStrikes") === changes[0]?.from;
  },
  async apply(ctx, input) {
    const service = input.service as ArrType;
    const to = input.failedImportMaxStrikes as number;
    // La PUT di Cleanuparr accetta solo questo campo (le istanze con indirizzi e chiavi non si toccano).
    await putJson(ctx, `/api/configuration/${service}`, { failedImportMaxStrikes: to });
    const after = valueOf(await readJson(ctx, `/api/configuration/${service}`), "failedImportMaxStrikes");
    if (after !== to) throw new Error("Verifica fallita: Cleanuparr non riporta il nuovo valore");
    return `Applicato e verificato: soglia delle importazioni fallite di ${service} = ${to}`;
  },
};

// --- Regole di semina della pulizia dei download -------------------------------------------------------------------

/**
 * Come Cleanuparr applica una regola (letto dal suo codice): vale la regola con la priorità più bassa che corrisponde a categoria,
 * tipo di tracker (pubblico/privato) ed eventuali filtri. Un torrent viene rimosso quando
 *   (rapporto raggiunto E tempo minimo di semina passato)  OPPURE  (tempo massimo di semina passato).
 * Il tempo MASSIMO vale da solo, senza aspettare il minimo: per garantire una semina minima il massimo deve essere più alto del minimo.
 * Un massimo di 0 cancella subito: qui non si ammette.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVACY = ["Public", "Private", "Both"] as const;
const RULE_ACTIONS = ["Delete", "Stop"] as const;

interface SeedingRule {
  id?: string;
  name?: string;
  categories?: string[];
  trackerPatterns?: string[];
  tagsAny?: string[];
  tagsAll?: string[];
  priority?: number;
  privacyType?: string;
  maxRatio?: number;
  minSeedTime?: number;
  maxSeedTime?: number;
  minSeeders?: number | null;
  maxInactiveDays?: number | null;
  deleteSourceFiles?: boolean;
  action?: string;
}

async function listRules(ctx: Ctx, clientId: string): Promise<SeedingRule[]> {
  const { base, headers } = access(ctx);
  const value = await getJson<unknown>(ctx, `${base}/api/seeding-rules/${clientId}`, { headers });
  if (!Array.isArray(value)) throw new WriteError("unexpected_response", "Cleanuparr ha risposto in un formato inatteso");
  return value.filter(isRecord) as SeedingRule[];
}

const stripControl = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "");

function parseTime(value: unknown, key: string, min: number, max: number, allowMinusOne: boolean): number {
  if (typeof value === "number" && Number.isFinite(value) && ((allowMinusOne && value === -1) || (value >= min && value <= max))) return value;
  throw new WriteError("invalid_input", `${key} deve essere ${allowMinusOne ? "-1 (disattivato) oppure " : ""}un numero tra ${min} e ${max}`);
}

/** Campi modificabili (numerici e di scelta) comuni a creazione e modifica. */
function parseRuleFields(raw: Record<string, unknown>, out: Record<string, unknown>): void {
  if ("privacyType" in raw) {
    if (typeof raw.privacyType !== "string" || !(PRIVACY as readonly string[]).includes(raw.privacyType)) throw new WriteError("invalid_input", `privacyType deve essere ${PRIVACY.join(", ")}`);
    out.privacyType = raw.privacyType;
  }
  if ("maxRatio" in raw) out.maxRatio = parseTime(raw.maxRatio, "maxRatio", 0, 1000, true);
  if ("minSeedTime" in raw) out.minSeedTime = parseTime(raw.minSeedTime, "minSeedTime", 0, 8760, false); // ore
  if ("maxSeedTime" in raw) {
    // 0 vorrebbe dire "cancella subito": non si ammette. -1 = nessun limite di tempo.
    out.maxSeedTime = parseTime(raw.maxSeedTime, "maxSeedTime", 1, 8760, true); // ore
  }
  if ("deleteSourceFiles" in raw) {
    if (typeof raw.deleteSourceFiles !== "boolean") throw new WriteError("invalid_input", "deleteSourceFiles deve essere true o false");
    out.deleteSourceFiles = raw.deleteSourceFiles;
  }
  if ("action" in raw) {
    if (typeof raw.action !== "string" || !(RULE_ACTIONS as readonly string[]).includes(raw.action)) throw new WriteError("invalid_input", `action deve essere ${RULE_ACTIONS.join(" oppure ")}`);
    out.action = raw.action;
  }
}

const RULE_FIELD_SCHEMA = {
  privacyType: { type: "string", enum: [...PRIVACY], description: "A quali torrent si applica: Public, Private o Both." },
  maxRatio: { type: "number", minimum: -1, maximum: 1000, description: "Rapporto da raggiungere (-1 = non usarlo)." },
  minSeedTime: { type: "number", minimum: 0, maximum: 8760, description: "Ore minime di semina, valgono solo insieme al rapporto." },
  maxSeedTime: { type: "number", minimum: -1, maximum: 8760, description: "Ore dopo le quali si rimuove comunque, anche senza rapporto e senza minimo (-1 = nessun limite)." },
  deleteSourceFiles: { type: "boolean" },
  action: { type: "string", enum: [...RULE_ACTIONS] },
};

const RULE_SEMANTICS =
  "Si rimuove quando (rapporto raggiunto E ore minime passate) OPPURE ore massime passate: il massimo vale da solo, quindi per garantire una semina minima il massimo deve essere maggiore del minimo. " +
  "Vale la regola con priorità più bassa che corrisponde a categoria e tipo di tracker.";

function checkRuleCoherence(rule: SeedingRule): void {
  const ratio = rule.maxRatio ?? -1;
  const seed = rule.maxSeedTime ?? -1;
  if (ratio < 0 && seed < 0) throw new WriteError("invalid_input", "Serve almeno un criterio: rapporto o tempo massimo di semina");
  if (typeof rule.minSeedTime === "number" && seed >= 0 && seed < rule.minSeedTime) {
    throw new WriteError("invalid_input", `Il tempo massimo (${seed} h) è minore del minimo (${rule.minSeedTime} h): il torrent verrebbe rimosso prima del minimo`);
  }
}

/** Il corpo completo che Cleanuparr si aspetta: i campi omessi tornano al valore predefinito, quindi si rimanda tutto. */
function ruleBody(rule: SeedingRule): Record<string, unknown> {
  return {
    name: rule.name ?? "",
    categories: rule.categories ?? [],
    trackerPatterns: rule.trackerPatterns ?? [],
    tagsAny: rule.tagsAny ?? [],
    tagsAll: rule.tagsAll ?? [],
    ...(typeof rule.priority === "number" ? { priority: rule.priority } : {}),
    privacyType: rule.privacyType ?? "Public",
    maxRatio: rule.maxRatio ?? -1,
    minSeedTime: rule.minSeedTime ?? 0,
    maxSeedTime: rule.maxSeedTime ?? -1,
    minSeeders: rule.minSeeders ?? 0,
    maxInactiveDays: rule.maxInactiveDays ?? -1,
    deleteSourceFiles: rule.deleteSourceFiles ?? true,
    action: rule.action ?? "Delete",
  };
}

const RULE_FIELDS = ["privacyType", "maxRatio", "minSeedTime", "maxSeedTime", "deleteSourceFiles", "action"] as const;

export const cleanuparrSeedingRuleUpdate: ActionDef = {
  name: "cleanuparr_seeding_rule_update",
  services: ["cleanuparr"],
  description:
    "Cleanuparr: modifica una regola di semina esistente (la pulizia dei download). Gli id si leggono da get_config_cleanuparr (downloadCleaner.clients[].downloadClientId e seedingRules[].id). " +
    "Campi in changes: privacyType, maxRatio, minSeedTime (ore), maxSeedTime (ore), deleteSourceFiles, action. Nome, categorie, tracker e priorità non si toccano. " + RULE_SEMANTICS,
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      clientId: { type: "string", description: "Id del client di download in Cleanuparr." },
      ruleId: { type: "string", description: "Id della regola." },
      changes: { type: "object", properties: RULE_FIELD_SCHEMA, additionalProperties: false },
    },
    required: ["clientId", "ruleId", "changes"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || Object.keys(input).some((key) => !["clientId", "ruleId", "changes"].includes(key))) throw new WriteError("invalid_input", "Input non valido");
    if (typeof input.clientId !== "string" || !GUID.test(input.clientId)) throw new WriteError("invalid_input", "clientId non valido");
    if (typeof input.ruleId !== "string" || !GUID.test(input.ruleId)) throw new WriteError("invalid_input", "ruleId non valido");
    if (!isRecord(input.changes)) throw new WriteError("invalid_input", "Serve un oggetto `changes`");
    const unknown = Object.keys(input.changes).filter((key) => !(RULE_FIELDS as readonly string[]).includes(key));
    if (unknown.length) throw new WriteError("invalid_input", `Impostazioni non modificabili: ${unknown.join(", ")}`);
    const changes: Record<string, unknown> = {};
    parseRuleFields(input.changes, changes);
    if (Object.keys(changes).length === 0) throw new WriteError("invalid_input", "Nessuna impostazione indicata");
    return { clientId: input.clientId.toLowerCase(), ruleId: input.ruleId.toLowerCase(), changes };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const rule = (await listRules(ctx, input.clientId as string)).find((candidate) => String(candidate.id).toLowerCase() === input.ruleId);
    if (!rule) throw new WriteError("not_found", "Regola non trovata per questo client");
    const wanted = input.changes as Record<string, unknown>;
    const changes: PlanChange[] = [];
    const before: Record<string, unknown> = {};
    for (const field of RULE_FIELDS) {
      if (!(field in wanted)) continue;
      const from = rule[field];
      if (from === wanted[field]) continue;
      changes.push({ target: `Cleanuparr: regola di semina "${rule.name ?? input.ruleId}"`, field, from, to: wanted[field] });
      if (typeof from === "string" || typeof from === "number" || typeof from === "boolean") before[field] = from;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    checkRuleCoherence({ ...rule, ...(wanted as SeedingRule) });
    return {
      summary: `Cleanuparr: regola di semina "${rule.name ?? input.ruleId}": cambia ${changes.map((change) => change.field).join(", ")}`,
      changes,
      undo: Object.keys(before).length === changes.length ? { action: "cleanuparr_seeding_rule_update", input: { clientId: input.clientId, ruleId: input.ruleId, changes: before } } : null,
    };
  },
  async stillValid(ctx, input, changes) {
    const rule = (await listRules(ctx, input.clientId as string)).find((candidate) => String(candidate.id).toLowerCase() === input.ruleId);
    return !!rule && changes.every((change) => (rule as Record<string, unknown>)[change.field] === change.from);
  },
  async apply(ctx, input) {
    const clientId = input.clientId as string;
    const wanted = input.changes as Record<string, unknown>;
    const rule = (await listRules(ctx, clientId)).find((candidate) => String(candidate.id).toLowerCase() === input.ruleId);
    if (!rule) throw new WriteError("not_found", "Regola non trovata per questo client");
    const merged = { ...rule, ...(wanted as SeedingRule) };
    checkRuleCoherence(merged);
    await putJson(ctx, `/api/seeding-rules/${input.ruleId}`, ruleBody(merged));
    const after = (await listRules(ctx, clientId)).find((candidate) => String(candidate.id).toLowerCase() === input.ruleId);
    if (!after || Object.entries(wanted).some(([field, value]) => (after as Record<string, unknown>)[field] !== value)) throw new Error("Verifica fallita: Cleanuparr non riporta i nuovi valori");
    // Nulla del resto della regola deve essere cambiato dalla scrittura.
    for (const field of ["name", "categories", "trackerPatterns", "priority", "minSeeders", "maxInactiveDays"] as const) {
      if (JSON.stringify(after[field]) !== JSON.stringify(rule[field])) throw new Error(`Verifica fallita: il campo ${field} è cambiato`);
    }
    return `Applicato e verificato: regola "${rule.name ?? ""}": ${Object.entries(wanted).map(([field, value]) => `${field}=${value}`).join(", ")}`;
  },
};

const NAME = /^[\p{L}\p{N} _.()+-]{1,60}$/u;
const CATEGORY = /^[A-Za-z0-9 _.+-]{1,50}$/;
const TRACKER = /^[A-Za-z0-9.-]{1,100}$/;

export const cleanuparrSeedingRuleCreate: ActionDef = {
  name: "cleanuparr_seeding_rule_create",
  services: ["cleanuparr"],
  description:
    "Cleanuparr: crea una nuova regola di semina per un client di download. Ha la priorità PIÙ BASSA (in fondo): le regole più in alto con la stessa categoria e lo stesso tipo di tracker vincono. " +
    "Per separare pubblici e privati: prima limita la regola esistente a Public (cleanuparr_seeding_rule_update), poi crea qui quella Private con le stesse categorie. " +
    "In rule: name, categories, trackerPatterns (opzionale, domini), privacyType, maxRatio, minSeedTime, maxSeedTime, deleteSourceFiles, action. " + RULE_SEMANTICS,
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      clientId: { type: "string" },
      rule: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 60 },
          categories: { type: "array", items: { type: "string", minLength: 1, maxLength: 50 }, minItems: 1, maxItems: 10 },
          trackerPatterns: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 10 },
          ...RULE_FIELD_SCHEMA,
        },
        required: ["name", "categories", "privacyType"],
        additionalProperties: false,
      },
    },
    required: ["clientId", "rule"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "clientId" && key !== "rule")) throw new WriteError("invalid_input", "Input non valido");
    if (typeof input.clientId !== "string" || !GUID.test(input.clientId)) throw new WriteError("invalid_input", "clientId non valido");
    if (!isRecord(input.rule)) throw new WriteError("invalid_input", "Serve un oggetto `rule`");
    const allowed = ["name", "categories", "trackerPatterns", ...RULE_FIELDS];
    const unknown = Object.keys(input.rule).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new WriteError("invalid_input", `Campi non ammessi: ${unknown.join(", ")}`);
    const rule: Record<string, unknown> = {};
    const name = typeof input.rule.name === "string" ? stripControl(input.rule.name).trim() : "";
    if (!NAME.test(name)) throw new WriteError("invalid_input", "name: da 1 a 60 caratteri (lettere, numeri, spazi e . _ - + ( ))");
    rule.name = name;
    const categories = input.rule.categories;
    if (!Array.isArray(categories) || categories.length < 1 || categories.length > 10 || !categories.every((c) => typeof c === "string" && CATEGORY.test(c))) {
      throw new WriteError("invalid_input", "categories: da 1 a 10 categorie (lettere, numeri, spazi e . _ - +)");
    }
    rule.categories = [...new Set(categories as string[])];
    const trackers = input.rule.trackerPatterns ?? [];
    if (!Array.isArray(trackers) || trackers.length > 10 || !trackers.every((t) => typeof t === "string" && TRACKER.test(t))) throw new WriteError("invalid_input", "trackerPatterns: al massimo 10 domini (lettere, numeri, . e -)");
    rule.trackerPatterns = [...new Set(trackers as string[])];
    if (!("privacyType" in input.rule)) throw new WriteError("invalid_input", "privacyType è obbligatorio");
    parseRuleFields(input.rule, rule);
    checkRuleCoherence(rule as SeedingRule);
    return { clientId: input.clientId.toLowerCase(), rule };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const rule = input.rule as Record<string, unknown>;
    const existing = await listRules(ctx, input.clientId as string);
    if (existing.some((candidate) => String(candidate.name).toLowerCase() === String(rule.name).toLowerCase())) {
      throw new WriteError("already_exists", `Esiste già una regola chiamata "${String(rule.name)}"`);
    }
    const labels: Array<[string, unknown]> = [
      ["name", rule.name], ["categories", (rule.categories as string[]).join(", ")], ["privacyType", rule.privacyType],
      ["maxRatio", rule.maxRatio ?? -1], ["minSeedTime", rule.minSeedTime ?? 0], ["maxSeedTime", rule.maxSeedTime ?? -1],
      ["deleteSourceFiles", rule.deleteSourceFiles ?? true], ["action", rule.action ?? "Delete"],
    ];
    if ((rule.trackerPatterns as string[]).length) labels.push(["trackerPatterns", (rule.trackerPatterns as string[]).join(", ")]);
    return {
      summary: `Cleanuparr: nuova regola di semina "${String(rule.name)}" (${String(rule.privacyType)}), in fondo alla lista`,
      changes: labels.map(([field, to]) => ({ target: "Cleanuparr: nuova regola di semina", field, from: null, to })),
      undo: null,
    };
  },
  async stillValid(ctx, input) {
    const rule = input.rule as Record<string, unknown>;
    return !(await listRules(ctx, input.clientId as string)).some((candidate) => String(candidate.name).toLowerCase() === String(rule.name).toLowerCase());
  },
  async apply(ctx, input) {
    const clientId = input.clientId as string;
    const rule = input.rule as SeedingRule;
    const { base, headers } = access(ctx);
    // Nessuna priorità: Cleanuparr la mette in fondo, quindi non scavalca nessuna regola esistente.
    await request(ctx, `${base}/api/seeding-rules/${clientId}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(ruleBody(rule)),
    });
    const created = (await listRules(ctx, clientId)).find((candidate) => String(candidate.name).toLowerCase() === String(rule.name).toLowerCase());
    if (!created) throw new Error("Verifica fallita: Cleanuparr non mostra la nuova regola");
    for (const field of ["privacyType", "maxRatio", "minSeedTime", "maxSeedTime", "deleteSourceFiles", "action"] as const) {
      const expected = ruleBody(rule)[field];
      if (created[field] !== expected) throw new Error(`Verifica fallita: ${field} non corrisponde`);
    }
    return `Creata e verificata: regola "${String(rule.name)}" (priorità ${String(created.priority)})`;
  },
};

export const CLEANUPARR_ACTIONS: ActionDef[] = [cleanuparrGeneral, cleanuparrArrFailedImport, cleanuparrSeedingRuleUpdate, cleanuparrSeedingRuleCreate];
