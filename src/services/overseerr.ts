import { UpstreamError } from "../errors";
import { getJson, baseUrl, requireSecret } from "../upstream";
import type { Ctx } from "../types";

export interface RequestsSummary {
  pending: number;
  processing: number;
  approved: number;
  available: number;
  declined: number;
  total: number;
  movies: number;
  tv: number;
  issuesOpen: number;
}

/** Contatori di richieste e problemi. Nessun nome utente né email. */
export async function fetchRequests(ctx: Ctx): Promise<RequestsSummary> {
  const key = requireSecret(ctx.env.OVERSEERR_API_KEY ?? ctx.env.OVERSEER_API_KEY, "overseerr");
  const base = baseUrl(ctx.env, "overseerr");
  const headers = { "X-Api-Key": key };

  const [requests, issues] = await Promise.all([
    getJson<Record<string, number>>(ctx, `${base}/api/v1/request/count`, { headers }),
    getJson<Record<string, number>>(ctx, `${base}/api/v1/issue/count`, { headers }),
  ]);

  return {
    pending: requests.pending ?? 0,
    processing: requests.processing ?? 0,
    approved: requests.approved ?? 0,
    available: requests.available ?? 0,
    declined: requests.declined ?? 0,
    total: requests.total ?? 0,
    movies: requests.movie ?? 0,
    tv: requests.tv ?? 0,
    issuesOpen: issues.open ?? 0,
  };
}

export interface LastAvailable {
  title: string;
  type: "movie" | "tv";
  /** Quando è diventato disponibile (ISO), se noto. */
  addedAt: string | null;
}

interface MediaItem {
  mediaType?: string;
  tmdbId?: number;
  mediaAddedAt?: string;
  updatedAt?: string;
}

/**
 * L'ultimo film o serie reso disponibile su Plex, dalle richieste di Overseerr.
 * Restituisce solo il titolo: nessun dato di chi l'ha richiesto.
 */
export async function fetchLastAvailable(ctx: Ctx): Promise<LastAvailable | null> {
  const key = requireSecret(ctx.env.OVERSEERR_API_KEY ?? ctx.env.OVERSEER_API_KEY, "overseerr");
  const base = baseUrl(ctx.env, "overseerr");
  const headers = { "X-Api-Key": key };

  const list = async (sort: string) =>
    getJson<{ results?: MediaItem[] }>(ctx, `${base}/api/v1/media?filter=available&sort=${sort}&take=1`, { headers });

  let page: { results?: MediaItem[] };
  try {
    page = await list("mediaAdded");
  } catch (error) {
    // Alcune versioni non conoscono l'ordinamento "mediaAdded": si ripiega su "modified".
    if (error instanceof UpstreamError && error.status === 400) page = await list("modified");
    else throw error;
  }

  const item = page.results?.[0];
  if (!item || typeof item.tmdbId !== "number") return null;

  const type = item.mediaType === "tv" ? "tv" : "movie";
  const detail = await getJson<{ title?: string; name?: string }>(ctx, `${base}/api/v1/${type}/${item.tmdbId}`, { headers });
  const title = detail.title ?? detail.name;
  if (!title) return null;

  return { title, type, addedAt: item.mediaAddedAt ?? item.updatedAt ?? null };
}
