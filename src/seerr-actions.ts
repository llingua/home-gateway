import type { ActionDef, PlanDraft } from "./actions";
import { WriteError } from "./errors";
import { arrAccess } from "./services/arr";
import type { PlanChange } from "./store";
import { baseUrl, getJson, request, requireSecret } from "./upstream";
import type { Ctx } from "./types";

/**
 * Modifiche a Seerr (Overseerr): opzioni generali e server Radarr/Sonarr collegati.
 *
 * - Generali: la POST di Seerr unisce solo i campi inviati; si inviano SOLO quelli indicati. La risposta contiene la chiave API:
 *   il gateway non la legge né la restituisce mai. Non si toccano accessi (rischio di restare chiusi fuori), permessi, indirizzi né la chiave.
 * - Server collegati: la PUT di Seerr SOSTITUISCE l'intero oggetto (una chiave API omessa viene cancellata): si rilegge l'oggetto completo
 *   (chiave compresa, che resta nel gateway), si cambia solo il campo indicato, si rimanda tutto e si verifica che nient'altro sia cambiato.
 *   Cartelle, indirizzi e chiavi non si modificano.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Field = { type: "bool" } | { type: "int"; min: number; max: number } | { type: "enum"; values: readonly string[] };

function checkValue(key: string, value: unknown, field: Field): void {
  if (field.type === "bool") {
    if (typeof value !== "boolean") throw new WriteError("invalid_input", `${key} deve essere true o false`);
  } else if (field.type === "int") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) throw new WriteError("invalid_input", `${key} deve essere un intero tra ${field.min} e ${field.max}`);
  } else if (typeof value !== "string" || !field.values.includes(value)) {
    throw new WriteError("invalid_input", `${key} deve essere uno tra: ${field.values.join(", ")}`);
  }
}

const schemaOf = (field: Field) => (field.type === "bool" ? { type: "boolean" } : field.type === "int" ? { type: "integer", minimum: field.min, maximum: field.max } : { type: "string", enum: [...field.values] });
const describe = (fields: Record<string, Field>) => Object.entries(fields).map(([key, f]) => (f.type === "int" ? `${key} (${f.min}-${f.max})` : f.type === "enum" ? `${key} (${f.values.join("|")})` : `${key} (vero/falso)`)).join(", ");

function access(ctx: Ctx) {
  const key = requireSecret(ctx.env.OVERSEERR_API_KEY ?? ctx.env.OVERSEER_API_KEY, "overseerr");
  return { base: baseUrl(ctx.env, "overseerr"), headers: { "X-Api-Key": key } };
}

// --- Opzioni generali ------------------------------------------------------------------------------------------------

const MAIN_FIELDS: Record<string, Field> = {
  partialRequestsEnabled: { type: "bool" },
  hideAvailable: { type: "bool" },
  hideRequested: { type: "bool" },
  hideBlocklisted: { type: "bool" },
  enableSpecialEpisodes: { type: "bool" },
  newPlexLogin: { type: "bool" },
  cacheImages: { type: "bool" },
  versionCheck: { type: "bool" },
};

async function readMain(ctx: Ctx): Promise<Record<string, unknown>> {
  const { base, headers } = access(ctx);
  const data = await getJson<unknown>(ctx, `${base}/api/v1/settings/main`, { headers });
  const out: Record<string, unknown> = {};
  if (isRecord(data)) for (const key of Object.keys(MAIN_FIELDS)) if (key in data) out[key] = data[key]; // solo i campi ammessi, mai la chiave
  return out;
}

export const seerrMainSettings: ActionDef = {
  name: "seerr_main_settings",
  services: ["overseerr"],
  description: `Seerr: cambia le opzioni generali. Chiavi ammesse: ${describe(MAIN_FIELDS)}. Non tocca accessi (localLogin, mediaServerLogin), permessi, indirizzi né la chiave API.`,
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: { changes: { type: "object", properties: Object.fromEntries(Object.entries(MAIN_FIELDS).map(([key, f]) => [key, schemaOf(f)])), additionalProperties: false } },
    required: ["changes"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || !isRecord(input.changes) || Object.keys(input).some((key) => key !== "changes")) throw new WriteError("invalid_input", "Serve un oggetto `changes`");
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(input.changes)) {
      const field = Object.prototype.hasOwnProperty.call(MAIN_FIELDS, key) ? MAIN_FIELDS[key] : undefined;
      if (!field) throw new WriteError("invalid_input", `Impostazione non modificabile: ${key}`);
      checkValue(key, value, field);
      out[key] = value as boolean;
    }
    if (Object.keys(out).length === 0) throw new WriteError("invalid_input", "Nessuna impostazione indicata");
    return { changes: out };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const wanted = input.changes as Record<string, boolean>;
    const main = await readMain(ctx);
    const changes: PlanChange[] = [];
    const before: Record<string, boolean> = {};
    for (const [key, to] of Object.entries(wanted)) {
      if (!(key in main)) throw new WriteError("not_supported", `Questa versione di Seerr non ha l'impostazione ${key}`);
      const from = main[key];
      if (from === to) continue;
      changes.push({ target: "Seerr: opzioni generali", field: key, from, to });
      if (typeof from === "boolean") before[key] = from;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    return {
      summary: `Seerr: cambia ${changes.map((change) => change.field).join(", ")}`,
      changes,
      undo: Object.keys(before).length === changes.length ? { action: "seerr_main_settings", input: { changes: before } } : null,
    };
  },
  async stillValid(ctx, _input, changes) {
    const main = await readMain(ctx);
    return changes.every((change) => main[change.field] === change.from);
  },
  async apply(ctx, input) {
    const wanted = input.changes as Record<string, boolean>;
    const { base, headers } = access(ctx);
    // La POST unisce i campi: si inviano solo quelli indicati. La risposta (che contiene la chiave API) non viene letta.
    await request(ctx, `${base}/api/v1/settings/main`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(wanted) });
    const after = await readMain(ctx);
    if (Object.entries(wanted).some(([key, value]) => after[key] !== value)) throw new Error("Verifica fallita: Seerr non riporta i nuovi valori");
    return `Applicato e verificato: ${Object.entries(wanted).map(([key, value]) => `${key}=${value}`).join(", ")}`;
  },
};

// --- Server Radarr/Sonarr collegati ------------------------------------------------------------------------------------

const COMMON: Record<string, Field> = { syncEnabled: { type: "bool" }, preventSearch: { type: "bool" }, tagRequests: { type: "bool" }, activeProfileId: { type: "int", min: 1, max: 100_000 } };
const SERVER_FIELDS: Record<"radarr" | "sonarr", Record<string, Field>> = {
  radarr: { ...COMMON, minimumAvailability: { type: "enum", values: ["announced", "inCinemas", "released"] } },
  sonarr: {
    ...COMMON,
    activeAnimeProfileId: { type: "int", min: 1, max: 100_000 },
    enableSeasonFolders: { type: "bool" },
    seriesType: { type: "enum", values: ["standard", "daily", "anime"] },
    animeSeriesType: { type: "enum", values: ["standard", "daily", "anime"] },
    monitorNewItems: { type: "enum", values: ["all", "none"] },
  },
};
const PROFILE_NAME_FIELD: Record<string, string> = { activeProfileId: "activeProfileName", activeAnimeProfileId: "activeAnimeProfileName" };
const ALL_SERVER_FIELDS: Record<string, Field> = { ...SERVER_FIELDS.radarr, ...SERVER_FIELDS.sonarr };

async function readServers(ctx: Ctx, service: "radarr" | "sonarr"): Promise<Array<Record<string, unknown>>> {
  const { base, headers } = access(ctx);
  const data = await getJson<unknown>(ctx, `${base}/api/v1/settings/${service}`, { headers });
  if (!Array.isArray(data)) throw new WriteError("unexpected_response", "Seerr ha risposto in un formato inatteso");
  return data.filter(isRecord);
}

async function readServer(ctx: Ctx, service: "radarr" | "sonarr", id: number): Promise<Record<string, unknown>> {
  const server = (await readServers(ctx, service)).find((candidate) => candidate.id === id);
  if (!server) throw new WriteError("not_found", `Server ${service} con id ${id} non trovato in Seerr`);
  return server;
}

/** Nome del profilo di qualità letto dal servizio stesso: l'id deve esistere, e il nome salvato in Seerr resta coerente. */
async function profileName(ctx: Ctx, service: "radarr" | "sonarr", id: number): Promise<string> {
  const { base, headers } = arrAccess(ctx, service);
  const profiles = await getJson<unknown>(ctx, `${base}/api/v3/qualityprofile`, { headers });
  const profile = Array.isArray(profiles) ? profiles.find((p) => isRecord(p) && p.id === id) : undefined;
  if (!isRecord(profile) || typeof profile.name !== "string") throw new WriteError("invalid_input", `Il profilo di qualità ${id} non esiste in ${service}`);
  return profile.name;
}

export const seerrServerSettings: ActionDef = {
  name: "seerr_server_settings",
  services: ["overseerr"],
  description:
    "Seerr: cambia un server Radarr o Sonarr collegato (l'`id` si legge da get_config_overseerr). Radarr: " + describe(SERVER_FIELDS.radarr) +
    ". Sonarr: " + describe(SERVER_FIELDS.sonarr) + ". Per i profili si indica l'id: il nome lo legge il gateway da Radarr/Sonarr. Cartelle, indirizzi e chiavi non si toccano.",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string", enum: ["radarr", "sonarr"] },
      id: { type: "integer", minimum: 0 },
      changes: { type: "object", properties: Object.fromEntries(Object.entries(ALL_SERVER_FIELDS).map(([key, f]) => [key, schemaOf(f)])), additionalProperties: false },
    },
    required: ["service", "id", "changes"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || Object.keys(input).some((key) => !["service", "id", "changes"].includes(key))) throw new WriteError("invalid_input", "Input non valido");
    if (input.service !== "radarr" && input.service !== "sonarr") throw new WriteError("invalid_input", "service deve essere radarr o sonarr");
    if (typeof input.id !== "number" || !Number.isInteger(input.id) || input.id < 0 || input.id > 1000) throw new WriteError("invalid_input", "id deve essere un intero tra 0 e 1000");
    if (!isRecord(input.changes)) throw new WriteError("invalid_input", "Serve un oggetto `changes`");
    const fields = SERVER_FIELDS[input.service];
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.changes)) {
      const field = Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
      if (!field) throw new WriteError("invalid_input", `Impostazione non modificabile per ${input.service}: ${key}`);
      checkValue(key, value, field);
      out[key] = value;
    }
    if (Object.keys(out).length === 0) throw new WriteError("invalid_input", "Nessuna impostazione indicata");
    return { service: input.service, id: input.id, changes: out };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const service = input.service as "radarr" | "sonarr";
    const id = input.id as number;
    const wanted = input.changes as Record<string, unknown>;
    const server = await readServer(ctx, service, id);
    const label = `Seerr: server ${service} "${typeof server.name === "string" ? server.name : id}" (id ${id})`;
    const changes: PlanChange[] = [];
    const before: Record<string, unknown> = {};
    for (const [field, to] of Object.entries(wanted)) {
      const from = server[field];
      if (from === to) continue;
      if (field in PROFILE_NAME_FIELD) await profileName(ctx, service, to as number); // l'id deve esistere
      changes.push({ target: label, field, from, to });
      if (typeof from === "string" || typeof from === "number" || typeof from === "boolean") before[field] = from;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    return {
      summary: `Seerr: server ${service} "${typeof server.name === "string" ? server.name : id}": cambia ${changes.map((change) => change.field).join(", ")}`,
      changes,
      undo: Object.keys(before).length === changes.length ? { action: "seerr_server_settings", input: { service, id, changes: before } } : null,
    };
  },
  async stillValid(ctx, input, changes) {
    const server = await readServer(ctx, input.service as "radarr" | "sonarr", input.id as number);
    return changes.every((change) => server[change.field] === change.from);
  },
  async apply(ctx, input) {
    const service = input.service as "radarr" | "sonarr";
    const id = input.id as number;
    const wanted = input.changes as Record<string, unknown>;
    const full = await readServer(ctx, service, id);
    // La PUT sostituisce l'oggetto: senza la chiave API la cancellerebbe. Se non si legge, non si scrive.
    if (typeof full.apiKey !== "string" || full.apiKey === "") throw new WriteError("apikey_unavailable", "Seerr non mostra la chiave del server: non si scrive per non cancellarla");
    // `id` è di sola lettura nella validazione di Seerr (sta già nell'indirizzo): inviarlo fa rifiutare la richiesta (HTTP 400).
    const { id: _readOnlyId, ...rest } = full;
    const body: Record<string, unknown> = { ...rest, ...wanted };
    for (const [field, nameField] of Object.entries(PROFILE_NAME_FIELD)) {
      if (field in wanted) body[nameField] = await profileName(ctx, service, wanted[field] as number);
    }
    const { base, headers } = access(ctx);
    await request(ctx, `${base}/api/v1/settings/${service}/${id}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const after = await readServer(ctx, service, id);
    if (Object.entries(wanted).some(([field, value]) => after[field] !== value)) throw new Error("Verifica fallita: Seerr non riporta i nuovi valori");
    // Tutto il resto dell'oggetto (indirizzi, chiave, cartelle, tag...) deve essere rimasto uguale.
    const touched = new Set([...Object.keys(wanted), ...Object.keys(wanted).map((field) => PROFILE_NAME_FIELD[field]).filter((n): n is string => !!n)]);
    for (const key of new Set([...Object.keys(full), ...Object.keys(after)])) {
      if (touched.has(key)) continue;
      if (JSON.stringify(after[key]) !== JSON.stringify(full[key])) throw new Error(`Verifica fallita: il campo ${key} è cambiato`);
    }
    return `Applicato e verificato: server ${service} "${typeof full.name === "string" ? full.name : id}": ${Object.entries(wanted).map(([field, value]) => `${field}=${value}`).join(", ")}`;
  },
};

export const SEERR_ACTIONS: ActionDef[] = [seerrMainSettings, seerrServerSettings];
