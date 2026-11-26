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
