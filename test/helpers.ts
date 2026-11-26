import type { CacheLike, Env, Fetcher, KvLike } from "../src/types";

export const TEAM = "team.cloudflareaccess.com";
export const AUD = "aud-test-123";
export const NOW = 1_800_000_000; // secondi Unix fissi per i test
export const JWKS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

const b64url = (input: ArrayBuffer | string): string => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid = "key-1"): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

export async function signJwt(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }));
  const body = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(signature)}`;
}

export const validClaims = (extra: Record<string, unknown> = {}) => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  exp: NOW + 600,
  iat: NOW - 10,
  common_name: "homepage-client-id",
  ...extra,
});

type Handler = (request: Request) => Response | Promise<Response>;

/** Finto "internet": risponde alle richieste in base all'indirizzo e tiene il conto delle chiamate. */
export class FakeNet {
  readonly calls: Array<{ url: string; method: string; headers: Headers; redirect: string }> = [];
  private readonly handlers: Array<[RegExp, Handler]> = [];

  on(pattern: RegExp | string, handler: Handler): this {
    const regex = typeof pattern === "string" ? new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : pattern;
    this.handlers.push([regex, handler]);
    return this;
  }

  json(pattern: RegExp | string, body: unknown, status = 200): this {
    return this.on(pattern, () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  }

  readonly fetch: Fetcher = async (input, init) => {
    const request = new Request(input, init);
    this.calls.push({ url: request.url, method: request.method, headers: request.headers, redirect: request.redirect });
    for (const [regex, handler] of this.handlers) {
      if (regex.test(request.url)) return handler(request);
    }
    return new Response("not found", { status: 404 });
  };

  callsTo(pattern: string): number {
    return this.calls.filter((call) => call.url.startsWith(pattern)).length;
  }
}

export class MemoryCache implements CacheLike {
  private readonly store = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> {
    return this.store.get(request.url)?.clone();
  }
  async put(request: Request, response: Response): Promise<void> {
    this.store.set(request.url, response.clone());
  }
}

export const CLIENTS = JSON.stringify({
  "homepage-client-id": { name: "homepage", scopes: ["media:read"] },
  "no-scope-id": { name: "senza-permessi", scopes: [] },
  "Admin@Example.com": { name: "admin", scopes: ["*"] },
  "agent-id": { name: "agente", scopes: ["media:read", "config:read"] },
  "writer-id": { name: "scrittore", scopes: ["media:read", "config:read", "config:write"] },
});

export const baseEnv = (extra: Partial<Env> = {}): Env => ({
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  CLIENTS,
  CF_ACCESS_CLIENT_ID: "gw-id",
  CF_ACCESS_CLIENT_SECRET: "gw-secret",
  RADARR_URL: "https://radarr.test",
  RADARR_API_KEY: "radarr-key",
  SONARR_URL: "https://sonarr.test",
  SONARR_API_KEY: "sonarr-key",
  OVERSEERR_URL: "https://overseerr.test",
  OVERSEERR_API_KEY: "seerr-key",
  PROWLARR_URL: "https://prowlarr.test",
  PROWLARR_API_KEY: "prowlarr-key",
  BAZARR_URL: "https://bazarr.test",
  BAZARR_API_KEY: "bazarr-key",
  PROXMOX_URL: "https://pve.test",
  PROXMOX_API_TOKEN: "gateway@pve!home=pve-secret-token",
  PLEX_URL: "https://plex.test",
  PLEX_TOKEN: "plex-token",
  QBITTORRENT_URL: "https://qbt.test",
  QBT_USERNAME: "user",
  QBT_PASSWORD: "pass",
  ...extra,
});

/** Un finto ambiente completo: tutti i servizi rispondono con dati realistici. */
export function healthyNet(key: TestKey): FakeNet {
  const net = new FakeNet();
  net.json(JWKS_URL, { keys: [key.jwk] });

  net.json("https://radarr.test/api/v3/queue", {
    totalRecords: 1,
    records: [{ status: "downloading", trackedDownloadStatus: "ok", size: 1000, sizeleft: 250, timeleft: "00:10:00", movie: { title: "Odissea" } }],
  });
  net.json("https://sonarr.test/api/v3/queue", {
    totalRecords: 2,
    records: [{ status: "downloading", size: 100, sizeleft: 100, series: { title: "Serie X" }, episode: { seasonNumber: 1, episodeNumber: 2 } }],
  });
  net.json("https://radarr.test/api/v3/health", [{ type: "warning", message: "Indexer non disponibile" }, { type: "ok", message: "" }]);
  net.json("https://sonarr.test/api/v3/health", []);
  net.json("https://radarr.test/api/v3/wanted/missing", { totalRecords: 4 });
  net.json("https://sonarr.test/api/v3/wanted/missing", { totalRecords: 7 });
  net.json("https://radarr.test/api/v3/diskspace", [{ path: "/movies", freeSpace: 770 * 1024 ** 3, totalSpace: 2000 * 1024 ** 3 }]);
  net.json("https://sonarr.test/api/v3/diskspace", [{ path: "/tv", freeSpace: 21 * 1024 ** 3, totalSpace: 31 * 1024 ** 3 }]);
  net.json("https://radarr.test/api/v3/calendar", [
    { title: "Più avanti", digitalRelease: "2099-02-01T00:00:00Z" },
    { title: "Presto", digitalRelease: "2099-01-01T00:00:00Z" },
    { title: "Già uscito", digitalRelease: "2000-01-01T00:00:00Z" },
  ]);
  net.json("https://sonarr.test/api/v3/calendar", [
    { airDateUtc: "2099-03-01T20:00:00Z", seasonNumber: 2, episodeNumber: 3, series: { title: "Serie X" } },
  ]);

  net.json("https://plex.test/status/sessions", {
    MediaContainer: {
      size: 1,
      Metadata: [
        {
          type: "episode",
          title: "Pilot",
          grandparentTitle: "Serie X",
          parentIndex: 1,
          index: 1,
          viewOffset: 300_000,
          duration: 600_000,
          User: { title: "mario.rossi" },
          Player: { title: "LG OLED", state: "playing", address: "192.168.0.50" },
        },
      ],
    },
  });
  net.json("https://plex.test/library/sections/1/all", { MediaContainer: { totalSize: 120 } });
  net.json("https://plex.test/library/sections/2/all", { MediaContainer: { totalSize: 45 } });
  net.json("https://plex.test/library/sections", {
    MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }, { key: "2", title: "Programmi", type: "show" }] },
  });

  net.on("https://qbt.test/api/v2/auth/login", () => new Response("Ok.", { headers: { "set-cookie": "SID=abc123; HttpOnly; path=/" } }));
  net.json("https://qbt.test/api/v2/transfer/info", { dl_info_speed: 12_400_000, up_info_speed: 900_000 });
  net.json("https://qbt.test/api/v2/torrents/info", [
    { name: "A", state: "downloading", progress: 0.5, eta: 600 },
    { name: "B", state: "stalledDL", progress: 0.9, eta: 8_640_000 },
    { name: "C", state: "uploading", progress: 1 },
    { name: "D", state: "pausedUP", progress: 1 },
    { name: "E", state: "error", progress: 0.1 },
  ]);

  net.json("https://overseerr.test/api/v1/request/count", { total: 40, movie: 30, tv: 10, pending: 2, approved: 1, declined: 3, processing: 34, available: 20 });
  net.json("https://overseerr.test/api/v1/media", {
    results: [{ mediaType: "movie", tmdbId: 11, mediaAddedAt: "2026-11-24T12:10:00.000Z", requestedBy: { email: "segreto@example.com" } }],
  });
  net.json("https://overseerr.test/api/v1/movie/11", { title: "Ti presento i Fotter" });
  net.json("https://overseerr.test/api/v1/issue/count", { total: 5, open: 1, closed: 4 });
  net.json("https://pve.test/api2/json/nodes/pve/tasks", {
    data: [
      { type: "vzdump", status: "OK", starttime: 1_800_000_000, endtime: 1_800_000_600 },
      { type: "vzdump", status: "job errors", starttime: 1_700_000_000, endtime: 1_700_000_100 },
      { type: "vzdump", starttime: 1_900_000_000 },
    ],
  });
  net.json("https://pve.test/api2/json/cluster/resources", {
    data: [
      { type: "node", node: "pve", status: "online", cpu: 0.124, mem: 6e9, maxmem: 16e9, uptime: 86_400 },
      { type: "lxc", vmid: 103, name: "jarvis", status: "running", cpu: 0.01, mem: 1e8, maxmem: 1e9 },
      { type: "qemu", vmid: 101, name: "windows11", status: "stopped", cpu: 0, mem: 0, maxmem: 8e9 },
      { type: "qemu", vmid: 9000, name: "modello", status: "stopped", template: 1 },
      { type: "storage", storage: "local-lvm", node: "pve", disk: 63 * 1024 ** 3, maxdisk: 100 * 1024 ** 3 },
      { type: "storage", storage: "nas", node: "pve", disk: 1, maxdisk: 2 },
      { type: "storage", storage: "nas", node: "altro", disk: 1, maxdisk: 2 },
    ],
  });
  net.json("https://bazarr.test/api/badges", { movies: 2, episodes: 5, providers: 1, status: 0, announcements: 3 });
  net.json("https://prowlarr.test/api/v1/indexerstatus", [
    { indexerId: 2, disabledTill: "2099-01-01T00:00:00Z" },
    { indexerId: 3, disabledTill: "2000-01-01T00:00:00Z" },
  ]);
  net.json("https://prowlarr.test/api/v1/indexer", [
    { id: 1, enable: true },
    { id: 2, enable: true },
    { id: 3, enable: true },
    { id: 4, enable: false },
  ]);
  net.json("https://prowlarr.test/api/v1/health", [{ type: "warning", message: "Indexer non disponibili: X" }, { type: "ok", message: "" }]);
  addConfigFixtures(net);
  return net;
}

/** Impostazioni "realistiche": con chiavi, password e indirizzi dove i servizi veri li mettono. */
function addConfigFixtures(net: FakeNet): void {
  const indexerWithSecrets = {
    id: 4, tags: [], configContract: "TorznabSettings", infoLink: "https://wiki.servarr.com/torznab", name: "Prowlarr (Torznab)", implementation: "Torznab", protocol: "torrent", enableRss: true, enableAutomaticSearch: true,
    enableInteractiveSearch: true, priority: 25, apiKey: "top-secret-indexer",
    fields: [{ name: "apiKey", value: "radarr-indexer-secret-key" }, { name: "baseUrl", value: "http://192.168.0.9:9696/1/" }],
  };
  const clientWithSecrets = {
    id: 7, tags: [1], configContract: "QBittorrentSettings", infoLink: "https://wiki.servarr.com/qbittorrent", implementationName: "qBittorrent",
    name: "qBittorrent", implementation: "QBittorrent", protocol: "torrent", enable: true, priority: 1, removeCompletedDownloads: true,
    fields: [{ name: "username", value: "admin-user" }, { name: "password", value: "qbt-pass-leak" }, { name: "host", value: "192.168.0.171" }],
  };

  for (const service of ["radarr", "sonarr"]) {
    const base = `https://${service}.test/api/v3`;
    net.json(`${base}/system/status`, { version: "5.0.1", apiKeyHint: "ignorato" });
    net.json(`${base}/qualityprofile`, [
      {
        name: "HD-1080p", upgradeAllowed: true, cutoff: 1001, minFormatScore: 0, cutoffFormatScore: 100,
        items: [
          { quality: { id: 1, name: "SDTV" }, items: [], allowed: false },
          { id: 1001, name: "WEB 1080p", items: [{ quality: { id: 3, name: "WEBDL-1080p" } }, { quality: { id: 15, name: "WEBRip-1080p" } }], allowed: true },
          { quality: { id: 7, name: "Bluray-1080p" }, items: [], allowed: true },
        ],
      },
    ]);
    net.json(`${base}/customformat`, [{ name: "x265 (HD)", specifications: [{ fields: { value: "leak-in-spec" } }] }, { name: "Repack/Proper" }]);
    net.json(`${base}/rootfolder`, [{ path: "/data/media", freeSpace: 770 * 1024 ** 3, accessible: true }]);
    net.json(`${base}/downloadclient`, [clientWithSecrets]);
    net.json(`${base}/indexer`, [indexerWithSecrets]);
    net.json(`${base}/config/mediamanagement`, {
      copyUsingHardlinks: true, deleteEmptyFolders: false, recycleBin: "/data/cestino", recycleBinCleanupDays: 7,
      downloadPropersAndRepacks: "preferAndUpgrade", chmodFolder: "755", chownGroup: "gruppo-segreto",
    });
    net.json(`${base}/config/naming`, { renameMovies: true, standardMovieFormat: "{Movie Title} ({Release Year})", renameEpisodes: true, standardEpisodeFormat: "{Series Title} - S{season:00}E{episode:00}" });
    net.json(`${base}/delayprofile`, [{ enableUsenet: true, enableTorrent: true, preferredProtocol: "torrent", usenetDelay: 0, torrentDelay: 30, order: 2147483647, tags: [1] }]);
    net.json(`${base}/tag`, [{ id: 1, label: "4k" }]);
  }

  net.json("https://prowlarr.test/api/v1/system/status", { version: "1.30.0" });
  net.json("https://prowlarr.test/api/v1/applications", [
    { id: 3, tags: [], configContract: "RadarrSettings", implementationName: "Radarr", syncCategories: [2000], name: "Radarr", implementation: "Radarr", syncLevel: "fullSync", fields: [{ name: "apiKey", value: "APP-LEAK-1234" }, { name: "baseUrl", value: "http://192.168.0.171:7878" }] },
  ]);
  net.json("https://prowlarr.test/api/v1/appprofile", [{ name: "Standard", enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, minimumSeeders: 1 }]);
  net.json("https://prowlarr.test/api/v1/downloadclient", [clientWithSecrets]);
  net.json("https://prowlarr.test/api/v1/tag", [{ id: 1, label: "italia" }]);

  net.json("https://qbt.test/api/v2/app/preferences", {
    save_path: "/downloads", max_active_downloads: 3, max_active_torrents: 5, dl_limit: 0, up_limit: 1_000_000, max_ratio_enabled: true, max_ratio: 2,
    web_ui_username: "admin-user", web_ui_password: "hash-of-qbt-password", web_ui_address: "192.168.0.171", proxy_ip: "10.1.1.1", proxy_password: "proxy-pass",
    autorun_program: "/usr/bin/autorun-segreto", bypass_auth_subnet_whitelist: "192.168.0.0/24", mail_notification_password: "mail-pass",
  });
  net.json("https://qbt.test/api/v2/torrents/categories", { radarr: { name: "radarr", savePath: "/downloads/radarr" }, sonarr: { name: "sonarr", savePath: "/downloads/sonarr" } });
  net.on("https://qbt.test/api/v2/app/version", () => new Response("v5.0.2"));
}

export async function authedRequest(key: TestKey, path: string, claims: Record<string, unknown> = validClaims()): Promise<Request> {
  return new Request(`https://gateway.test${path}`, { headers: { "Cf-Access-Jwt-Assertion": await signJwt(key, claims) } });
}


/** Finto KV: tiene valori e metadati, ordina le chiavi come fa Cloudflare. Non simula la scadenza. */
export class FakeKv implements KvLike {
  readonly data = new Map<string, { value: string; metadata?: unknown; ttl?: number }>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void> {
    this.data.set(key, { value, metadata: options?.metadata, ttl: options?.expirationTtl });
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list(options?: { prefix?: string; limit?: number }) {
    const keys = [...this.data.entries()]
      .filter(([name]) => name.startsWith(options?.prefix ?? ""))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, options?.limit ?? 1000)
      .map(([name, entry]) => ({ name, metadata: entry.metadata }));
    return { keys };
  }
}

export const APPROVAL_AUD = "aud-approvazione-456";
export const APPROVER_EMAIL = "persona@example.test";

export const writeEnv = (kv: FakeKv, extra: Partial<Env> = {}): Env =>
  baseEnv({ STATE: kv, ACCESS_AUD_APPROVAL: APPROVAL_AUD, APPROVERS: `${APPROVER_EMAIL}, altra@example.test`, APPROVAL_SECRET: "segreto-csrf-di-prova", ...extra });

/** Stato dei finti servizi che cambiano davvero (qBittorrent e Prowlarr). */
export interface WriteState {
  prefs: Record<string, unknown>;
  indexers: Record<number, Record<string, unknown>>;
  posts: Array<Record<string, unknown>>;
  puts: Array<{ url: string; body: Record<string, unknown> }>;
}

export function writeState(): WriteState {
  return {
    prefs: { max_active_downloads: 3, max_active_uploads: 2, max_active_torrents: 3, dl_limit: 1_024_000_000, up_limit: 10_240_000, web_ui_password: "hash-segreto" },
    indexers: {
      3: { id: 3, name: "The Pirate Bay", enable: true, priority: 25, fields: [{ name: "apiKey", value: "chiave-indexer-segreta" }, { name: "baseUrl", value: "http://192.168.0.9/x" }] },
      4: { id: 4, name: "<img src=x onerror=alert(1)>", enable: true, priority: 25, fields: [] },
    },
    posts: [],
    puts: [],
  };
}

export function writeNet(key: TestKey, state: WriteState, options: { ignoreSetPreferences?: boolean } = {}): FakeNet {
  const net = new FakeNet();
  net.json(JWKS_URL, { keys: [key.jwk] });
  net.on("https://qbt.test/api/v2/auth/login", () => new Response("Ok.", { headers: { "set-cookie": "SID=abc123; HttpOnly" } }));
  net.on("https://qbt.test/api/v2/app/preferences", () => new Response(JSON.stringify(state.prefs), { headers: { "Content-Type": "application/json" } }));
  net.on("https://qbt.test/api/v2/app/setPreferences", async (request) => {
    const form = await request.formData();
    const changes = JSON.parse(String(form.get("json"))) as Record<string, unknown>;
    state.posts.push(changes);
    if (!options.ignoreSetPreferences) Object.assign(state.prefs, changes);
    return new Response("");
  });
  net.on(/^https:\/\/prowlarr\.test\/api\/v1\/indexer\/(\d+)/, async (request) => {
    const id = Number(/indexer\/(\d+)/.exec(request.url)![1]);
    if (request.method === "PUT") {
      const body = (await request.json()) as Record<string, unknown>;
      state.puts.push({ url: request.url, body });
      state.indexers[id] = body;
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }
    const indexer = state.indexers[id];
    return indexer ? new Response(JSON.stringify(indexer), { headers: { "Content-Type": "application/json" } }) : new Response("no", { status: 404 });
  });
  return net;
}
