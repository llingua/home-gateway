import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { authedRequest, baseEnv, healthyNet, makeKey, MemoryCache, NOW, validClaims, type TestKey } from "./helpers";

let key: TestKey;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
});

const get = (path: string) => new Request(`https://gateway.test${path}`);

describe("accesso", () => {
  it("/healthz risponde senza autenticazione e non rivela altro", async () => {
    const res = await handle(get("/healthz"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "home-gateway" });
  });

  it("senza token tutto il resto è 401", async () => {
    const res = await handle(get("/v1/media/overview"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    expect(res.status).toBe(401);
  });

  it("accetta solo GET", async () => {
    const res = await handle(new Request("https://gateway.test/v1/media/streams", { method: "POST" }), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    expect(res.status).toBe(405);
  });

  it("un cliente senza permessi riceve 403", async () => {
    const net = healthyNet(key);
    const request = await authedRequest(key, "/v1/media/streams", validClaims({ common_name: "no-scope-id" }));
    const res = await handle(request, baseEnv(), { fetch: net.fetch, now: NOW });
    expect(res.status).toBe(403);
    expect(net.callsTo("https://plex.test")).toBe(0); // non è stato interrogato nessun servizio
  });

  it("senza configurazione Access risponde 500 e non espone nulla", async () => {
    const net = healthyNet(key);
    const res = await handle(await authedRequest(key, "/v1/media/streams"), baseEnv({ ACCESS_AUD: undefined }), { fetch: net.fetch, now: NOW });
    expect(res.status).toBe(500);
    expect(net.callsTo("https://plex.test")).toBe(0);
  });

  it("aggiunge intestazioni di sicurezza e nessuna cache lato client", async () => {
    const res = await handle(await authedRequest(key, "/v1/capabilities"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("capacità", () => {
  it("elenca le sezioni e quali sono consentite al cliente", async () => {
    const res = await handle(await authedRequest(key, "/v1/capabilities"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    const body = (await res.json()) as { client: string; sections: Array<{ name: string; allowed: boolean }> };
    expect(body.client).toBe("homepage");
    expect(body.sections.map((s) => s.name)).toEqual(["streams", "downloads", "requests", "recent", "queue", "upcoming", "library", "storage", "health", "indexers", "subtitles", "proxmox"]);
    expect(body.sections.every((s) => s.allowed)).toBe(true);
  });
});

describe("overview", () => {
  it("restituisce tutte le sezioni", async () => {
    const res = await handle(await authedRequest(key, "/v1/media/overview"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generatedAt: string; sections: Record<string, { status: string; data?: any }> };
    expect(Object.keys(body.sections)).toHaveLength(12);
    expect(Object.values(body.sections).every((s) => s.status === "ok")).toBe(true);
    expect(body.sections.downloads!.data.downloadMBs).toBe(12.4);
    expect(body.sections.queue!.data.movies.total).toBe(1);
    expect(body.sections.library!.data.wantedEpisodes).toBe(7);
  });

  it("non mostra mai utenti, indirizzi, chiavi o token", async () => {
    const res = await handle(await authedRequest(key, "/v1/media/overview"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    const text = await res.text();
    for (const secret of ["mario.rossi", "segreto@example.com", "192.168", "radarr-key", "sonarr-key", "seerr-key", "plex-token", "prowlarr-key", "bazarr-key", "pve-secret-token", "gw-secret", "pass", "abc123"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("limita le sezioni richieste e rifiuta quelle sconosciute", async () => {
    const ok = await handle(await authedRequest(key, "/v1/media/overview?sections=streams,requests"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    expect(Object.keys(((await ok.json()) as { sections: object }).sections)).toEqual(["streams", "requests"]);
    const bad = await handle(await authedRequest(key, "/v1/media/overview?sections=streams,boh"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    expect(bad.status).toBe(400);
  });

  it("un servizio giù non blocca gli altri (risultati parziali)", async () => {
    const healthy = healthyNet(key);
    const mixed = async (input: string, init?: RequestInit) =>
      input.startsWith("https://overseerr.test") ? new Response("boom", { status: 500 }) : healthy.fetch(input, init);

    const res = await handle(await authedRequest(key, "/v1/media/overview"), baseEnv(), { fetch: mixed, now: NOW });
    const body = (await res.json()) as { sections: Record<string, { status: string; error?: string }> };
    expect(body.sections.requests).toMatchObject({ status: "error", error: "Errore del servizio (HTTP 500)" });
    expect(body.sections.streams!.status).toBe("ok");
    expect(body.sections.downloads!.status).toBe("ok");
  });

  it("se un solo servizio di una sezione composta è giù, la sezione resta ok con un avviso", async () => {
    const healthy = healthyNet(key);
    const mixed = async (input: string, init?: RequestInit) =>
      input.startsWith("https://sonarr.test/api/v3/queue") ? new Response("boom", { status: 500 }) : healthy.fetch(input, init);
    const res = await handle(await authedRequest(key, "/v1/media/queue"), baseEnv(), { fetch: mixed, now: NOW });
    const body = (await res.json()) as { status: string; data: any; warnings: string[] };
    expect(body.status).toBe("ok");
    expect(body.data.movies.total).toBe(1);
    expect(body.data.episodes).toBeNull();
    expect(body.warnings).toEqual(["episodes: Errore del servizio (HTTP 500)"]);
  });

  it("i servizi senza segreti risultano 'unconfigured', non in errore", async () => {
    const env = baseEnv({ PLEX_TOKEN: undefined, QBT_PASSWORD: undefined });
    const res = await handle(await authedRequest(key, "/v1/media/overview?sections=streams,downloads,requests"), env, { fetch: healthyNet(key).fetch, now: NOW });
    const body = (await res.json()) as { sections: Record<string, { status: string }> };
    expect(body.sections.streams!.status).toBe("unconfigured");
    expect(body.sections.downloads!.status).toBe("unconfigured");
    expect(body.sections.requests!.status).toBe("ok");
  });
});

describe("sezione singola", () => {
  it("restituisce la sezione richiesta", async () => {
    const res = await handle(await authedRequest(key, "/v1/media/requests"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW });
    expect(await res.json()).toMatchObject({ status: "ok", data: { pending: 2, processing: 34 } });
  });

  it("404 per sezioni e percorsi inesistenti", async () => {
    expect((await handle(await authedRequest(key, "/v1/media/boh"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW })).status).toBe(404);
    expect((await handle(await authedRequest(key, "/v1/altro"), baseEnv(), { fetch: healthyNet(key).fetch, now: NOW })).status).toBe(404);
  });
});

describe("cache", () => {
  it("la seconda richiesta non interroga i servizi", async () => {
    const net = healthyNet(key);
    const cache = new MemoryCache();
    const deps = { fetch: net.fetch, cache, now: NOW };

    await handle(await authedRequest(key, "/v1/media/requests"), baseEnv(), deps);
    const before = net.callsTo("https://overseerr.test");
    const second = await handle(await authedRequest(key, "/v1/media/requests"), baseEnv(), deps);

    expect(net.callsTo("https://overseerr.test")).toBe(before);
    expect(await second.json()).toMatchObject({ status: "ok", cached: true });
  });

  it("gli errori non finiscono in cache", async () => {
    let fail = true;
    const healthy = healthyNet(key);
    const flaky = async (input: string, init?: RequestInit) =>
      input.startsWith("https://overseerr.test") && fail ? new Response("boom", { status: 500 }) : healthy.fetch(input, init);
    const deps = { fetch: flaky, cache: new MemoryCache(), now: NOW };

    const first = await handle(await authedRequest(key, "/v1/media/requests"), baseEnv(), deps);
    expect(((await first.json()) as { status: string }).status).toBe("error");

    fail = false;
    const second = await handle(await authedRequest(key, "/v1/media/requests"), baseEnv(), deps);
    expect(((await second.json()) as { status: string }).status).toBe("ok");
  });
});
