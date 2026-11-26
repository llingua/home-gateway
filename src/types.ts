/** Variabili e segreti del Worker. Tutti opzionali: ciò che manca = servizio "unconfigured". */
export interface Env {
  // Autenticazione dei clienti (Cloudflare Access)
  ACCESS_TEAM_DOMAIN?: string; // es. llhome.cloudflareaccess.com
  ACCESS_AUD?: string; // AUD tag dell'app Access del gateway
  CLIENTS?: string | Record<string, Client>; // { "<client_id | email>": { "name": "...", "scopes": ["media:read"] } }

  // Token di servizio con cui il gateway entra nei servizi (anch'essi dietro Access)
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;

  RADARR_URL?: string;
  RADARR_API_KEY?: string;
  SONARR_URL?: string;
  SONARR_API_KEY?: string;
  OVERSEERR_URL?: string;
  OVERSEERR_API_KEY?: string;
  PLEX_URL?: string;
  PLEX_TOKEN?: string;
  QBITTORRENT_URL?: string;
  QBT_USERNAME?: string;
  QBT_PASSWORD?: string;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Cache minimale (compatibile con `caches.default`), sostituibile nei test. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Ctx {
  env: Env;
  fetch: Fetcher;
}

export type SectionStatus = "ok" | "error" | "unconfigured";

export interface SectionResult<T = unknown> {
  status: SectionStatus;
  data?: T;
  /** Messaggio breve e senza dati sensibili. */
  error?: string;
  /** Problemi parziali: un servizio ha risposto, un altro no. */
  warnings?: string[];
  cached?: boolean;
}

export interface Client {
  name: string;
  scopes: string[];
}
