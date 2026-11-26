import { getJson, baseUrl, requireSecret } from "../upstream";
import type { Ctx } from "../types";

export interface SubtitlesSummary {
  /** Film con sottotitoli mancanti. */
  missingMovies: number;
  /** Episodi con sottotitoli mancanti. */
  missingEpisodes: number;
  /** Provider di sottotitoli con problemi (es. sospesi per troppe richieste). */
  providerIssues: number;
  /** Altri problemi di salute segnalati da Bazarr. */
  healthIssues: number;
}

/** Contatori di sottotitoli mancanti e problemi (endpoint /api/badges di Bazarr). */
export async function fetchSubtitles(ctx: Ctx): Promise<SubtitlesSummary> {
  const key = requireSecret(ctx.env.BAZARR_API_KEY, "bazarr");
  const base = baseUrl(ctx.env, "bazarr");
  const data = await getJson<{ movies?: number; episodes?: number; providers?: number; status?: number }>(
    ctx,
    `${base}/api/badges`,
    { headers: { "X-API-KEY": key } },
  );
  return {
    missingMovies: data.movies ?? 0,
    missingEpisodes: data.episodes ?? 0,
    providerIssues: data.providers ?? 0,
    healthIssues: data.status ?? 0,
  };
}
