/** Variabili e segreti del Worker. Tutti opzionali: ciò che manca = servizio "unconfigured". */
export interface Env {
  // Autenticazione dei clienti (Cloudflare Access)
  ACCESS_TEAM_DOMAIN?: string; // es. llhome.cloudflareaccess.com
  ACCESS_AUD?: string; // AUD tag dell'app Access del gateway
  ACCESS_AUD_OAUTH?: string; // AUD dell'app Access con Managed OAuth (mcp.belinchebon.com): accesso di una persona da app come Claude
  CLIENTS?: string | Record<string, Client>;

  // Scritture (livello 3): piani da approvare. Senza questi valori le scritture sono disattivate.
  STATE?: KvLike; // KV Namespace con piani e registro
  ACCESS_AUD_APPROVAL?: string; // AUD dell'app Access della pagina di approvazione (accesso personale con email)
  APPROVERS?: string; // email di chi può approvare, separate da virgola (segreto)
  APPROVAL_SECRET?: string; // segreto per i token anti-CSRF della pagina di approvazione (segreto) // { "<client_id | email>": { "name": "...", "scopes": ["media:read"] } }

  // Token di servizio con cui il gateway entra nei servizi (anch'essi dietro Access)
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;

  RADARR_URL?: string;
  RADARR_API_KEY?: string;
  SONARR_URL?: string;
  SONARR_API_KEY?: string;
  OVERSEERR_URL?: string;
  OVERSEERR_API_KEY?: string;
  /** Alias accettato per OVERSEERR_API_KEY (errore di battitura frequente nel nome del segreto). */
  OVERSEER_API_KEY?: string;
  PROWLARR_URL?: string;
  PROWLARR_API_KEY?: string;
  BAZARR_URL?: string;
  BAZARR_API_KEY?: string;
  PROXMOX_URL?: string;
  /** Token API di Proxmox, formato utente@realm!nome=segreto. Consigliato: utente dedicato con ruolo PVEAuditor. */
  PROXMOX_API_TOKEN?: string;
  PLEX_URL?: string;
  PLEX_TOKEN?: string;
  QBITTORRENT_URL?: string;
  QBT_USERNAME?: string;
  QBT_PASSWORD?: string;
  CLEANUPARR_URL?: string;
  /** Chiave API di Cleanuparr (Account → API key), solo lettura delle impostazioni. */
  CLEANUPARR_API_KEY?: string;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Cache minimale (compatibile con `caches.default`), sostituibile nei test. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

/** Archivio chiave-valore (compatibile con un KV Namespace di Cloudflare), sostituibile nei test. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string; metadata?: unknown }> }>;
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
