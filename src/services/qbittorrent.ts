import { UpstreamError } from "../errors";
import { getJson, request, baseUrl, requireSecret } from "../upstream";
import type { Ctx } from "../types";

const DOWNLOADING = new Set(["downloading", "forcedDL", "metaDL", "forcedMetaDL", "stalledDL", "queuedDL", "checkingDL", "allocating"]);
const SEEDING = new Set(["uploading", "forcedUP", "stalledUP", "queuedUP", "checkingUP"]);
// 4.x: pausedDL/pausedUP; 5.x: stoppedDL/stoppedUP.
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

/**
 * Cookie di sessione dal login. Fino alla 4.x si chiama `SID`; dalla 5.x può chiamarsi `QBT_SID_<porta>`.
 * Si accettano solo questi due nomi e si rimanda il cookie con il nome ricevuto.
 */
export function sessionCookie(headers: Headers): string | null {
  const raw = typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
    : [headers.get("set-cookie") ?? ""];
  let found: string | null = null;
  for (const line of raw) {
    // Più cookie possono arrivare uniti da ", ": si cerca il nome all'inizio o subito dopo un separatore.
    const re = /(?:^|[,;]\s*)(SID|QBT_SID_\d{1,5})=([^;,\s]+)/g;
    for (let match = re.exec(line); match; match = re.exec(line)) {
      const cookie = `${match[1]}=${match[2]}`;
      if (match[1] !== "SID") return cookie; // il nome con la porta è quello della 5.x: ha la precedenza
      found ??= cookie;
    }
  }
  return found;
}

/**
 * Login con cookie: si accede a ogni richiesta; il risultato finisce in cache.
 * Riuscito: 200 con corpo "Ok." (fino alla 5.1) oppure 204 senza corpo (5.2+), sempre con un cookie di sessione.
 * Rifiutato: 200 "Fails.", 401, 403 (o qualsiasi altra risposta).
 */
export async function login(ctx: Ctx, base: string): Promise<string> {
  const username = requireSecret(ctx.env.QBT_USERNAME, "qbittorrent");
  const password = requireSecret(ctx.env.QBT_PASSWORD, "qbittorrent");

  let response: Response;
  try {
    response = await request(ctx, `${base}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: base },
      body: new URLSearchParams({ username, password }),
    });
  } catch (error) {
    if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) throw new UpstreamError("Login qBittorrent rifiutato", error.status);
    throw error;
  }
  const text = (await response.text()).trim();
  const accepted = (response.status === 200 && text === "Ok.") || (response.status === 204 && text === "");
  const cookie = sessionCookie(response.headers);
  if (!accepted || !cookie) throw new UpstreamError("Login qBittorrent rifiutato");
  return cookie;
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

/** Solo impostazioni di funzionamento: mai credenziali, indirizzi, proxy né programmi da eseguire. */
const PREFERENCE_KEYS = [
  "save_path", "temp_path_enabled", "temp_path", "auto_tmm_enabled", "incomplete_files_ext", "preallocate_all",
  "max_connec", "max_connec_per_torrent", "max_uploads", "max_uploads_per_torrent",
  "queueing_enabled", "max_active_downloads", "max_active_uploads", "max_active_torrents", "max_active_checking_torrents",
  "dl_limit", "up_limit", "alt_dl_limit", "alt_up_limit", "scheduler_enabled",
  "max_ratio_enabled", "max_ratio", "max_ratio_act", "max_seeding_time_enabled", "max_seeding_time",
  "dht", "pex", "lsd", "encryption", "anonymous_mode", "upnp", "listen_port",
  "add_trackers_enabled", "start_paused_enabled", "add_stopped_enabled", "create_subfolder_enabled",
] as const;

export interface QbtConfig {
  version: string | null;
  preferences: Record<string, unknown>;
  categories: Array<{ name: string; savePath: string }>;
}

export async function fetchQbtConfig(ctx: Ctx): Promise<QbtConfig> {
  const base = baseUrl(ctx.env, "qbittorrent");
  const cookie = await login(ctx, base);
  const headers = { Cookie: cookie, Referer: base };

  const [preferences, categories, version] = await Promise.all([
    getJson<Record<string, unknown>>(ctx, `${base}/api/v2/app/preferences`, { headers }),
    getJson<Record<string, { name?: string; savePath?: string }>>(ctx, `${base}/api/v2/torrents/categories`, { headers }),
    request(ctx, `${base}/api/v2/app/version`, { headers }).then((response) => response.text()).catch(() => null),
  ]);

  const safe: Record<string, unknown> = {};
  for (const key of PREFERENCE_KEYS) if (key in preferences) safe[key] = preferences[key];

  return {
    version: version ? version.trim() : null,
    preferences: safe,
    categories: Object.values(categories).map((category) => ({ name: category.name ?? "", savePath: category.savePath ?? "" })),
  };
}
