import { getJson, baseUrl, requireSecret } from "../upstream";
import type { Ctx } from "../types";

export interface IndexersSummary {
  total: number;
  /** Indexer disattivati dall'utente o sospesi temporaneamente per errori. */
  disabled: number;
  issues: Array<{ level: "warning" | "error"; message: string }>;
}

/** Stato degli indexer di Prowlarr. Nessun indirizzo né chiave degli indexer esce dal gateway. */
export async function fetchIndexers(ctx: Ctx): Promise<IndexersSummary> {
  const key = requireSecret(ctx.env.PROWLARR_API_KEY, "prowlarr");
  const base = baseUrl(ctx.env, "prowlarr");
  const headers = { "X-Api-Key": key };

  const [indexers, statuses, health] = await Promise.all([
    getJson<Array<{ id?: number; enable?: boolean }>>(ctx, `${base}/api/v1/indexer`, { headers }),
    getJson<Array<{ indexerId?: number; disabledTill?: string }>>(ctx, `${base}/api/v1/indexerstatus`, { headers }),
    getJson<Array<{ type?: string; message?: string }>>(ctx, `${base}/api/v1/health`, { headers }),
  ]);

  const now = Date.now();
  const disabledIds = new Set<number>();
  for (const indexer of indexers) {
    if (indexer.enable === false && indexer.id !== undefined) disabledIds.add(indexer.id);
  }
  for (const status of statuses) {
    if (status.indexerId !== undefined && status.disabledTill && Date.parse(status.disabledTill) > now) {
      disabledIds.add(status.indexerId);
    }
  }

  return {
    total: indexers.length,
    disabled: disabledIds.size,
    issues: health
      .filter((item) => item.type === "warning" || item.type === "error")
      .map((item) => ({ level: item.type as "warning" | "error", message: item.message ?? "" })),
  };
}
