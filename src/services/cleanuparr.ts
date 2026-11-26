import { stripAddresses } from "../scrub";
import { baseUrl, getJson, requireSecret } from "../upstream";
import type { Ctx } from "../types";

/**
 * Impostazioni di Cleanuparr per l'audit (solo lettura, API con `X-Api-Key`).
 *
 * Cleanuparr tiene nelle sue risposte indirizzi, chiavi e password dei servizi collegati (arr e client di download).
 * Qui NON entrano mai: per arr e client si restituiscono solo nome, tipo e stato; per le altre sezioni si usa un
 * filtro che toglie ogni chiave che somiglia a un indirizzo o a un segreto. Sopra c'è comunque `scrubSecrets`.
 */

const get = (ctx: Ctx, path: string) => {
  const key = requireSecret(ctx.env.CLEANUPARR_API_KEY, "cleanuparr");
  return getJson<unknown>(ctx, `${baseUrl(ctx.env, "cleanuparr")}${path}`, { headers: { "X-Api-Key": key } });
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Prende solo le chiavi elencate, senza badare a maiuscole e minuscole. */
function pickCaseless(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(source)) return out;
  const byLower = new Map(Object.keys(source).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const real = byLower.get(key.toLowerCase());
    if (real !== undefined) out[real] = stripAddresses(source[real]);
  }
  return out;
}

const lower = (source: Record<string, unknown>, key: string) => source[Object.keys(source).find((k) => k.toLowerCase() === key.toLowerCase()) ?? ""];

export const fetchCleanuparrQueueCleaner = async (ctx: Ctx) => stripAddresses(await get(ctx, "/api/configuration/queue_cleaner"));
export const fetchCleanuparrMalwareBlocker = async (ctx: Ctx) => stripAddresses(await get(ctx, "/api/configuration/malware_blocker"));
export const fetchCleanuparrStallRules = async (ctx: Ctx) => stripAddresses(await get(ctx, "/api/queue-rules/stall"));
export const fetchCleanuparrSlowRules = async (ctx: Ctx) => stripAddresses(await get(ctx, "/api/queue-rules/slow"));

const GENERAL_KEYS = [
  "DryRun", "HttpMaxRetries", "HttpTimeout", "HttpCertificateValidation", "StatusCheckEnabled",
  "IgnoredDownloads", "ConnectivityCheckEnabled", "StrikeInactivityWindowHours", "HistoryRetentionDays",
] as const;

/** Generali: solo le opzioni di funzionamento. Niente reti fidate, indirizzi di controllo né impostazioni di accesso. */
export async function fetchCleanuparrGeneral(ctx: Ctx) {
  return pickCaseless(await get(ctx, "/api/configuration/general"), GENERAL_KEYS);
}

/** Pulizia dei download: per ogni client solo nome, tipo, stato e regole (senza indirizzi). */
export async function fetchCleanuparrDownloadCleaner(ctx: Ctx) {
  const raw = await get(ctx, "/api/configuration/download_cleaner");
  if (!isRecord(raw)) return null;
  const clients = lower(raw, "clients");
  return {
    ...pickCaseless(raw, ["Enabled", "CronExpression", "UseAdvancedScheduling", "IgnoredDownloads"]),
    clients: Array.isArray(clients) ? clients.slice(0, 20).map((client) => stripAddresses(client)) : [],
  };
}

/** Client di download collegati: solo nome, tipo e stato. Host, utente, password e chiavi non escono. */
export async function fetchCleanuparrDownloadClients(ctx: Ctx) {
  const raw = await get(ctx, "/api/configuration/download_client");
  const list = isRecord(raw) ? lower(raw, "clients") : raw;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((client) => pickCaseless(client, ["Name", "TypeName", "Type", "Enabled"]));
}

/** Istanze Sonarr/Radarr collegate: solo nome, stato, versione e soglia dei fallimenti di importazione. */
export async function fetchCleanuparrArr(ctx: Ctx, service: "sonarr" | "radarr") {
  const raw = await get(ctx, `/api/configuration/${service}`);
  if (!isRecord(raw)) return null;
  const instances = lower(raw, "instances");
  return {
    ...pickCaseless(raw, ["FailedImportMaxStrikes"]),
    instances: Array.isArray(instances) ? instances.slice(0, 20).map((instance) => pickCaseless(instance, ["Name", "Enabled", "Version"])) : [],
  };
}
