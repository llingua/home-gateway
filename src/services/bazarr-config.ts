import { baseUrl, getJson, requireSecret } from "../upstream";
import type { Ctx } from "../types";
import { isRecord, list, pickSimple } from "./config-common";

/**
 * Impostazioni di Bazarr per l'audit. Le impostazioni contengono chiavi API, utenti e password dei provider e di Sonarr/Radarr,
 * indirizzi e un comando di post-elaborazione: qui si leggono SOLO le opzioni di funzionamento elencate per nome.
 */

const GENERAL_KEYS = [
  "use_sonarr", "use_radarr", "serie_default_enabled", "serie_default_profile", "movie_default_enabled", "movie_default_profile",
  "minimum_score", "minimum_score_movie", "use_scenename", "use_postprocessing", "postprocessing_threshold", "postprocessing_threshold_movie",
  "single_language", "wanted_search_frequency", "wanted_search_frequency_movie", "upgrade_subs", "upgrade_frequency", "days_to_upgrade_subs",
  "upgrade_manual", "adaptive_searching", "adaptive_searching_delay", "adaptive_searching_delta", "subfolder", "hi_extension",
  "embedded_subs_show_desired", "utf8_encode", "ignore_pgs_subs", "ignore_vobsub_subs", "ignore_ass_subs", "enabled_providers",
] as const;
const SONARR_KEYS = ["only_monitored", "series_sync", "episodes_sync", "full_update", "excluded_tags", "excluded_series_types", "sync_only_monitored_series", "sync_only_monitored_episodes"] as const;
const RADARR_KEYS = ["only_monitored", "movies_sync", "full_update", "excluded_tags", "sync_only_monitored_movies"] as const;

const get = (ctx: Ctx, path: string) => getJson<unknown>(ctx, `${baseUrl(ctx.env, "bazarr")}${path}`, { headers: { "X-API-KEY": requireSecret(ctx.env.BAZARR_API_KEY, "bazarr") } });

export async function fetchBazarrSettings(ctx: Ctx) {
  const raw = await get(ctx, "/api/system/settings");
  const settings = isRecord(raw) ? raw : {};
  return {
    general: pickSimple(settings.general, GENERAL_KEYS),
    sonarr: pickSimple(settings.sonarr, SONARR_KEYS),
    radarr: pickSimple(settings.radarr, RADARR_KEYS),
  };
}

/** Profili lingua: nome, lingue (con sottotitoli per non udenti / forzati), soglia e parole richieste o escluse. */
export async function fetchBazarrProfiles(ctx: Ctx) {
  const raw = await get(ctx, "/api/system/languages/profiles");
  return list(raw, 50).map((profile) => {
    const p = isRecord(profile) ? profile : {};
    return {
      ...pickSimple(p, ["profileId", "name", "cutoff", "mustContain", "mustNotContain", "originalFormat"]),
      items: list(p.items, 30).map((item) => pickSimple(item, ["id", "language", "hi", "forced", "audio_exclude", "audio_only_include"])),
    };
  });
}

/** Lingue attive in Bazarr: solo i codici. */
export async function fetchBazarrLanguages(ctx: Ctx) {
  return list(await get(ctx, "/api/system/languages"), 200)
    .filter(isRecord)
    .filter((language) => language.enabled === true || language.enabled === 1)
    .map((language) => (typeof language.code2 === "string" ? language.code2 : null))
    .filter((code) => code !== null);
}

export async function fetchBazarrVersion(ctx: Ctx) {
  const raw = await get(ctx, "/api/system/status");
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : isRecord(raw) ? raw : {};
  return pickSimple(data, ["bazarr_version", "sonarr_version", "radarr_version", "operating_system", "python_version"]);
}
