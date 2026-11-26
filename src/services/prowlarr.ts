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

function pickSafe(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

/** Impostazioni di Prowlarr per l'audit: gli oggetti `applications` e `indexer` hanno un array `fields` con chiavi API, che non entra mai. */
export async function fetchProwlarrConfig(ctx: Ctx) {
  const key = requireSecret(ctx.env.PROWLARR_API_KEY, "prowlarr");
  const base = baseUrl(ctx.env, "prowlarr");
  const headers = { "X-Api-Key": key };
  const get = <T>(path: string) => getJson<T>(ctx, `${base}${path}`, { headers });

  const [status, indexers, applications, profiles, clients, tags] = await Promise.all([
    get<{ version?: string }>("/api/v1/system/status"),
    get<Array<Record<string, unknown>>>("/api/v1/indexer"),
    get<Array<Record<string, unknown>>>("/api/v1/applications"),
    get<Array<Record<string, unknown>>>("/api/v1/appprofile"),
    get<Array<Record<string, unknown>>>("/api/v1/downloadclient"),
    get<Array<{ label?: string }>>("/api/v1/tag"),
  ]);

  return {
    version: status.version ?? null,
    indexers: indexers.map((indexer) => pickSafe(indexer, ["name", "implementation", "protocol", "privacy", "enable", "priority", "appProfileId"])),
    applications: applications.map((app) => pickSafe(app, ["name", "implementation", "syncLevel"])),
    appProfiles: profiles.map((profile) => pickSafe(profile, ["name", "enableRss", "enableAutomaticSearch", "enableInteractiveSearch", "minimumSeeders"])),
    downloadClients: clients.map((client) => pickSafe(client, ["name", "implementation", "protocol", "enable", "priority"])),
    tags: tags.map((tag) => tag.label ?? ""),
  };
}
