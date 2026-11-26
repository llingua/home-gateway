import type { CacheLike, Env, Fetcher } from "../src/types";

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
  return net;
}

export async function authedRequest(key: TestKey, path: string, claims: Record<string, unknown> = validClaims()): Promise<Request> {
  return new Request(`https://gateway.test${path}`, { headers: { "Cf-Access-Jwt-Assertion": await signJwt(key, claims) } });
}
