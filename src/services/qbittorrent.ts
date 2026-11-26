import { UpstreamError } from "../errors";
import { getJson, request, baseUrl, requireSecret } from "../upstream";
import type { Ctx } from "../types";

const DOWNLOADING = new Set(["downloading", "forcedDL", "metaDL", "forcedMetaDL", "stalledDL", "queuedDL", "checkingDL", "allocating"]);
const SEEDING = new Set(["uploading", "forcedUP", "stalledUP", "queuedUP", "checkingUP"]);
const PAUSED = new Set(["pausedDL", "pausedUP", "stoppedDL", "stoppedUP"]);
const ERRORED = new Set(["error", "missingFiles"]);

interface Torrent {
  name?: string;
  state?: string;
  progress?: number;
  eta?: number;
  dlspeed?: number;
}

export interface DownloadsSummary {
  downloadMBs: number;
  uploadMBs: number;
  total: number;
  downloading: number;
  seeding: number;
  paused: number;
  errored: number;
  /** Fino a 5 download in corso, dal più avanzato. */
  active: Array<{ name: string; progress: number; etaSeconds: number | null; state: string }>;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** qBittorrent usa un login con cookie (SID): si accede a ogni richiesta; il risultato finisce in cache. */
async function login(ctx: Ctx, base: string): Promise<string> {
  const username = requireSecret(ctx.env.QBT_USERNAME, "qbittorrent");
  const password = requireSecret(ctx.env.QBT_PASSWORD, "qbittorrent");

  const response = await request(ctx, `${base}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: base },
    body: new URLSearchParams({ username, password }),
  });
  const text = (await response.text()).trim();
  const cookie = /SID=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (text !== "Ok." || !cookie) throw new UpstreamError("Login qBittorrent rifiutato");
  return `SID=${cookie}`;
}

export async function fetchDownloads(ctx: Ctx): Promise<DownloadsSummary> {
  const base = baseUrl(ctx.env, "qbittorrent");
  const cookie = await login(ctx, base);
  const headers = { Cookie: cookie, Referer: base };

  const [transfer, torrents] = await Promise.all([
    getJson<{ dl_info_speed?: number; up_info_speed?: number }>(ctx, `${base}/api/v2/transfer/info`, { headers }),
    getJson<Torrent[]>(ctx, `${base}/api/v2/torrents/info`, { headers }),
  ]);

  const downloading = torrents.filter((torrent) => DOWNLOADING.has(torrent.state ?? ""));
  return {
    downloadMBs: round1((transfer.dl_info_speed ?? 0) / 1e6),
    uploadMBs: round1((transfer.up_info_speed ?? 0) / 1e6),
    total: torrents.length,
    downloading: downloading.length,
    seeding: torrents.filter((torrent) => SEEDING.has(torrent.state ?? "")).length,
    paused: torrents.filter((torrent) => PAUSED.has(torrent.state ?? "")).length,
    errored: torrents.filter((torrent) => ERRORED.has(torrent.state ?? "")).length,
    active: downloading
      .sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))
      .slice(0, 5)
      .map((torrent) => ({
        name: torrent.name ?? "Sconosciuto",
        progress: Math.round((torrent.progress ?? 0) * 100),
        // qBittorrent usa 8640000 come "infinito".
        etaSeconds: torrent.eta !== undefined && torrent.eta < 8_640_000 ? torrent.eta : null,
        state: torrent.state ?? "unknown",
      })),
  };
}
