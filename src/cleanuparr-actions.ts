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

export const CLEANUPARR_ACTIONS: ActionDef[] = [cleanuparrGeneral, cleanuparrArrFailedImport];
