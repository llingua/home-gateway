import { baseUrl, getJson, requireSecret } from "../upstream";
import type { Ctx } from "../types";
import { isRecord, list, pickSimple } from "./config-common";

/**
 * Impostazioni di Overseerr per l'audit. Si leggono SOLO le opzioni di funzionamento: mai chiavi API, indirizzi, utenti,
 * token o indirizzi dei server Radarr/Sonarr collegati.
 */

const get = (ctx: Ctx, path: string) => getJson<unknown>(ctx, `${baseUrl(ctx.env, "overseerr")}${path}`, { headers: { "X-Api-Key": requireSecret(ctx.env.OVERSEERR_API_KEY ?? ctx.env.OVERSEER_API_KEY, "overseerr") } });

const MAIN_KEYS = [
  "applicationTitle", "hideAvailable", "partialRequestsEnabled", "localLogin", "mediaServerLogin", "newPlexLogin", "defaultPermissions",
  "region", "originalLanguage", "trustProxy", "csrfProtection", "cacheImages", "enableSpecialEpisodes",
] as const;
const ARR_SERVER_KEYS = [
  "id", "name", "is4k", "isDefault", "minimumAvailability", "activeProfileId", "activeProfileName", "activeDirectory", "activeLanguageProfileId",
  "activeAnimeProfileId", "activeAnimeProfileName", "activeAnimeDirectory", "activeAnimeLanguageProfileId", "seriesType", "animeSeriesType",
  "tags", "animeTags", "enableSeasonFolders", "enableScan", "syncEnabled", "preventSearch", "tagRequests", "overrideRule",
] as const;

export async function fetchOverseerrMain(ctx: Ctx) {
  return pickSimple(await get(ctx, "/api/v1/settings/main"), MAIN_KEYS);
}

export async function fetchOverseerrArr(ctx: Ctx, service: "radarr" | "sonarr") {
  return list(await get(ctx, `/api/v1/settings/${service}`), 20).map((server) => pickSimple(server, ARR_SERVER_KEYS));
}

/** Librerie Plex sincronizzate: solo nome e stato. */
export async function fetchOverseerrPlex(ctx: Ctx) {
  const raw = await get(ctx, "/api/v1/settings/plex");
  const libraries = isRecord(raw) ? list(raw.libraries, 50) : [];
  return { libraries: libraries.map((library) => pickSimple(library, ["id", "name", "enabled", "type"])) };
}

export async function fetchOverseerrJobs(ctx: Ctx) {
  return list(await get(ctx, "/api/v1/settings/jobs"), 50).map((job) => pickSimple(job, ["id", "name", "type", "interval", "cronSchedule", "running"]));
}

export async function fetchOverseerrVersion(ctx: Ctx) {
  return pickSimple(await get(ctx, "/api/v1/status"), ["version", "commitTag", "updateAvailable", "commitsBehind", "restartRequired"]);
}
