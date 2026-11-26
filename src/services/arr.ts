import { getJson, baseUrl, requireSecret, type ServiceName } from "../upstream";
import type { Ctx } from "../types";

/** Radarr e Sonarr hanno la stessa API v3: qui il codice condiviso. */

export type ArrService = Extract<ServiceName, "radarr" | "sonarr">;

const KEYS = { radarr: "RADARR_API_KEY", sonarr: "SONARR_API_KEY" } as const;

export function arrAccess(ctx: Ctx, service: ArrService): { base: string; headers: Record<string, string> } {
  const key = requireSecret(ctx.env[KEYS[service]], service);
  return { base: baseUrl(ctx.env, service), headers: { "X-Api-Key": key } };
}

interface QueueRecord {
  title?: string;
  status?: string;
  trackedDownloadStatus?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  movie?: { title?: string };
  series?: { title?: string };
  episode?: { seasonNumber?: number; episodeNumber?: number };
}

export interface QueueItem {
  title: string;
  status: string;
  /** 0-100, null se la dimensione non è nota. */
  progress: number | null;
  timeLeft: string | null;
  warning: boolean;
}

export interface QueueSummary {
  total: number;
  items: QueueItem[];
}

const pad = (n: number | undefined) => String(n ?? 0).padStart(2, "0");

function queueTitle(record: QueueRecord): string {
  if (record.movie?.title) return record.movie.title;
  if (record.series?.title) {
    const ep = record.episode;
    return ep ? `${record.series.title} S${pad(ep.seasonNumber)}E${pad(ep.episodeNumber)}` : record.series.title;
  }
  return record.title ?? "Sconosciuto";
}

export async function fetchQueue(ctx: Ctx, service: ArrService, limit = 8): Promise<QueueSummary> {
  const { base, headers } = arrAccess(ctx, service);
  const extra = service === "radarr" ? "includeMovie=true" : "includeSeries=true&includeEpisode=true";
  const data = await getJson<{ totalRecords?: number; records?: QueueRecord[] }>(
    ctx,
    `${base}/api/v3/queue?page=1&pageSize=${limit}&${extra}`,
    { headers },
  );
  const records = data.records ?? [];
  return {
    total: data.totalRecords ?? records.length,
    items: records.slice(0, limit).map((record) => ({
      title: queueTitle(record),
      status: record.status ?? "unknown",
      progress: record.size && record.size > 0 ? Math.round(((record.size - (record.sizeleft ?? 0)) / record.size) * 100) : null,
      timeLeft: record.timeleft ?? null,
      warning: record.trackedDownloadStatus === "warning" || record.trackedDownloadStatus === "error",
    })),
  };
}

export interface HealthIssue {
  service: ArrService;
  level: "warning" | "error";
  message: string;
}

export async function fetchHealth(ctx: Ctx, service: ArrService): Promise<HealthIssue[]> {
  const { base, headers } = arrAccess(ctx, service);
  const data = await getJson<Array<{ type?: string; message?: string }>>(ctx, `${base}/api/v3/health`, { headers });
  return data
    .filter((item) => item.type === "warning" || item.type === "error")
    .map((item) => ({ service, level: item.type as "warning" | "error", message: item.message ?? "" }));
}

export async function fetchWantedCount(ctx: Ctx, service: ArrService): Promise<number> {
  const { base, headers } = arrAccess(ctx, service);
  const data = await getJson<{ totalRecords?: number }>(ctx, `${base}/api/v3/wanted/missing?page=1&pageSize=1`, { headers });
  return data.totalRecords ?? 0;
}

export interface DiskVolume {
  path: string;
  freeGb: number;
  totalGb: number;
}

const GB = 1024 ** 3;

export async function fetchDiskSpace(ctx: Ctx, service: ArrService): Promise<DiskVolume[]> {
  const { base, headers } = arrAccess(ctx, service);
  const data = await getJson<Array<{ path?: string; freeSpace?: number; totalSpace?: number }>>(
    ctx,
    `${base}/api/v3/diskspace`,
    { headers },
  );
  return data.map((volume) => ({
    path: volume.path ?? "",
    freeGb: Math.round(((volume.freeSpace ?? 0) / GB) * 10) / 10,
    totalGb: Math.round(((volume.totalSpace ?? 0) / GB) * 10) / 10,
  }));
}

export interface UpcomingItem {
  title: string;
  /** Data ISO (AAAA-MM-GG). */
  date: string;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export async function fetchUpcoming(ctx: Ctx, service: ArrService, days = 30, limit = 5): Promise<UpcomingItem[]> {
  const { base, headers } = arrAccess(ctx, service);
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  const range = `start=${isoDay(start)}&end=${isoDay(end)}`;

  if (service === "radarr") {
    const data = await getJson<
      Array<{ title?: string; digitalRelease?: string; physicalRelease?: string; inCinemas?: string }>
    >(ctx, `${base}/api/v3/calendar?${range}&unmonitored=false`, { headers });
    return data
      .map((movie) => ({
        title: movie.title ?? "Sconosciuto",
        date: (movie.digitalRelease ?? movie.physicalRelease ?? movie.inCinemas ?? "").slice(0, 10),
      }))
      .filter((item) => item.date >= isoDay(start))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, limit);
  }

  const data = await getJson<
    Array<{ airDateUtc?: string; airDate?: string; seasonNumber?: number; episodeNumber?: number; series?: { title?: string }; title?: string }>
  >(ctx, `${base}/api/v3/calendar?${range}&includeSeries=true&unmonitored=false`, { headers });
  return data
    .map((episode) => ({
      title: `${episode.series?.title ?? episode.title ?? "Sconosciuto"} S${pad(episode.seasonNumber)}E${pad(episode.episodeNumber)}`,
      date: (episode.airDateUtc ?? episode.airDate ?? "").slice(0, 10),
    }))
    .filter((item) => item.date >= isoDay(start))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}
