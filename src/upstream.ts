import { NotConfigured, UpstreamError } from "./errors";
import type { Ctx, Env } from "./types";

export const DEFAULT_TIMEOUT_MS = 4000;

const DEFAULT_URLS = {
  radarr: "https://radarr.belinchebon.com",
  sonarr: "https://sonarr.belinchebon.com",
  overseerr: "https://overseerr.belinchebon.com",
  plex: "https://plex.belinchebon.com",
  prowlarr: "https://prowlarr.belinchebon.com",
  bazarr: "https://bazarr.belinchebon.com",
  proxmox: "https://proxmox.belinchebon.com",
  qbittorrent: "https://qbt.belinchebon.com",
} as const;

export type ServiceName = keyof typeof DEFAULT_URLS;

type UrlVar = "RADARR_URL" | "SONARR_URL" | "OVERSEERR_URL" | "PLEX_URL" | "PROWLARR_URL" | "BAZARR_URL" | "PROXMOX_URL" | "QBITTORRENT_URL";

const URL_VARS: Record<ServiceName, UrlVar> = {
  radarr: "RADARR_URL",
  sonarr: "SONARR_URL",
  overseerr: "OVERSEERR_URL",
  plex: "PLEX_URL",
  prowlarr: "PROWLARR_URL",
  bazarr: "BAZARR_URL",
  proxmox: "PROXMOX_URL",
  qbittorrent: "QBITTORRENT_URL",
};

export function baseUrl(env: Env, service: ServiceName): string {
  const configured = env[URL_VARS[service]];
  return (configured || DEFAULT_URLS[service]).replace(/\/+$/, "");
}

/** Intestazioni con cui il gateway si presenta ad Access (i servizi sono dietro Access). */
export function accessHeaders(env: Env): Record<string, string> {
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) return {};
  return {
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
  };
}

/** Restituisce il valore o solleva NotConfigured: i servizi senza segreti vengono saltati con garbo. */
export function requireSecret(value: string | undefined, service: string): string {
  if (!value) throw new NotConfigured(service);
  return value;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: string;
  body?: BodyInit;
}

/** Esegue una richiesta verso un servizio. Non segue i redirect: un 3xx significa che Access ha chiesto il login. */
export async function request(ctx: Ctx, url: string, options: RequestOptions = {}): Promise<Response> {
  // Proxmox si modifica solo a mano: nessuna scrittura parte mai verso il suo indirizzo, qualunque sia il codice che la chiede.
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && url.startsWith(baseUrl(ctx.env, "proxmox"))) {
    throw new UpstreamError("Proxmox è in sola lettura");
  }
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: options.method ?? "GET",
      headers: { ...accessHeaders(ctx.env), ...options.headers },
      body: options.body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new UpstreamError(timedOut ? "Timeout" : "Servizio non raggiungibile");
  }

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError("Access ha richiesto un login: token di servizio non accettato", response.status);
  }
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError("Accesso rifiutato dal servizio (chiave o token non validi)", response.status);
  }
  if (!response.ok) {
    throw new UpstreamError(`Errore del servizio (HTTP ${response.status})`, response.status);
  }
  return response;
}

export async function getJson<T>(ctx: Ctx, url: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(ctx, url, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
  try {
    return (await response.json()) as T;
  } catch {
    throw new UpstreamError("Risposta non valida dal servizio");
  }
}
