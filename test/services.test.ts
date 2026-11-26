import { describe, expect, it } from "vitest";
import { NotConfigured, UpstreamError } from "../src/errors";
import { fetchDiskSpace, fetchHealth, fetchQueue, fetchUpcoming, fetchWantedCount } from "../src/services/arr";
import { fetchDownloads } from "../src/services/qbittorrent";
import { fetchLastAvailable, fetchRequests } from "../src/services/overseerr";
import { fetchSubtitles } from "../src/services/bazarr";
import { fetchIndexers } from "../src/services/prowlarr";
import { fetchLibraries, fetchStreams } from "../src/services/plex";
import { baseEnv, FakeNet, healthyNet, makeKey } from "./helpers";

const ctxFor = async (envExtra = {}) => {
  const net = healthyNet(await makeKey());
  return { net, ctx: { env: baseEnv(envExtra), fetch: net.fetch } };
};

describe("Radarr / Sonarr", () => {
  it("normalizza la coda con titolo, avanzamento e avvisi", async () => {
    const { ctx } = await ctxFor();
    const movies = await fetchQueue(ctx, "radarr");
    expect(movies).toEqual({ total: 1, items: [{ title: "Odissea", status: "downloading", progress: 75, timeLeft: "00:10:00", warning: false }] });
    const episodes = await fetchQueue(ctx, "sonarr");
    expect(episodes.items[0]).toMatchObject({ title: "Serie X S01E02", progress: 0 });
  });

  it("manda la chiave API e le credenziali Access in ogni richiesta", async () => {
    const { net, ctx } = await ctxFor();
    await fetchQueue(ctx, "radarr");
    const call = net.calls.find((c) => c.url.startsWith("https://radarr.test/api/v3/queue"))!;
    expect(call.headers.get("x-api-key")).toBe("radarr-key");
    expect(call.headers.get("cf-access-client-id")).toBe("gw-id");
    expect(call.headers.get("cf-access-client-secret")).toBe("gw-secret");
  });

  it("restituisce solo avvisi e errori di salute, conteggi e volumi", async () => {
    const { ctx } = await ctxFor();
    expect(await fetchHealth(ctx, "radarr")).toEqual([{ service: "radarr", level: "warning", message: "Indexer non disponibile" }]);
    expect(await fetchWantedCount(ctx, "sonarr")).toBe(7);
    expect(await fetchDiskSpace(ctx, "radarr")).toEqual([{ path: "/movies", freeGb: 770, totalGb: 2000 }]);
  });

  it("ordina le uscite per data e scarta quelle già passate", async () => {
    const { ctx } = await ctxFor();
    expect((await fetchUpcoming(ctx, "radarr")).map((item) => item.title)).toEqual(["Presto", "Più avanti"]);
    expect((await fetchUpcoming(ctx, "sonarr"))[0]).toEqual({ title: "Serie X S02E03", date: "2099-03-01" });
  });

  it("senza chiave API il servizio risulta non configurato", async () => {
    const { ctx } = await ctxFor({ RADARR_API_KEY: undefined });
    await expect(fetchQueue(ctx, "radarr")).rejects.toBeInstanceOf(NotConfigured);
  });
});

describe("Plex", () => {
  it("espone i flussi senza utente né indirizzo IP", async () => {
    const { ctx } = await ctxFor();
    const summary = await fetchStreams(ctx);
    expect(summary).toEqual({
      count: 1,
      streams: [{ title: "Serie X", subtitle: "S01E01 Pilot", type: "episode", state: "playing", device: "LG OLED", progress: 50 }],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("mario");
    expect(serialized).not.toContain("192.168");
  });

  it("conta gli elementi di ogni libreria", async () => {
    const { ctx } = await ctxFor();
    expect(await fetchLibraries(ctx)).toEqual([
      { name: "Movies", type: "movie", count: 120 },
      { name: "Programmi", type: "show", count: 45 },
    ]);
  });
});

describe("qBittorrent", () => {
  it("riassume velocità e stati, ignorando l'ETA infinita", async () => {
    const { ctx } = await ctxFor();
    const summary = await fetchDownloads(ctx);
    expect(summary).toMatchObject({ downloadMBs: 12.4, uploadMBs: 0.9, total: 5, downloading: 2, seeding: 1, paused: 1, errored: 1 });
    expect(summary.active[0]).toEqual({ name: "B", progress: 90, etaSeconds: null, state: "stalledDL" });
    expect(summary.active[1]).toEqual({ name: "A", progress: 50, etaSeconds: 600, state: "downloading" });
  });

  it("usa il cookie di sessione ottenuto dal login", async () => {
    const { net, ctx } = await ctxFor();
    await fetchDownloads(ctx);
    const call = net.calls.find((c) => c.url.endsWith("/api/v2/torrents/info"))!;
    expect(call.headers.get("cookie")).toBe("SID=abc123");
  });

  it("segnala un login rifiutato", async () => {
    const net = new FakeNet().on("https://qbt.test/api/v2/auth/login", () => new Response("Fails."));
    await expect(fetchDownloads({ env: baseEnv(), fetch: net.fetch })).rejects.toThrow("Login qBittorrent rifiutato");
  });
});

describe("Prowlarr", () => {
  it("conta gli indexer e quelli non attivi (spenti o sospesi), ignorando le sospensioni scadute", async () => {
    const { ctx } = await ctxFor();
    expect(await fetchIndexers(ctx)).toEqual({
      total: 4,
      disabled: 2, // il 4 è spento dall'utente, il 2 è sospeso fino al 2099; il 3 era sospeso ma la sospensione è finita
      issues: [{ level: "warning", message: "Indexer non disponibili: X" }],
    });
  });

  it("senza chiave API risulta non configurato", async () => {
    const { ctx } = await ctxFor({ PROWLARR_API_KEY: undefined });
    await expect(fetchIndexers(ctx)).rejects.toBeInstanceOf(NotConfigured);
  });
});

describe("Bazarr", () => {
  it("restituisce i contatori dei sottotitoli mancanti e dei problemi, con la chiave nell'intestazione giusta", async () => {
    const { net, ctx } = await ctxFor();
    expect(await fetchSubtitles(ctx)).toEqual({ missingMovies: 2, missingEpisodes: 5, providerIssues: 1, healthIssues: 0 });
    const call = net.calls.find((c) => c.url.startsWith("https://bazarr.test/api/badges"))!;
    expect(call.headers.get("x-api-key")).toBe("bazarr-key");
  });

  it("senza chiave API risulta non configurato", async () => {
    const { ctx } = await ctxFor({ BAZARR_API_KEY: undefined });
    await expect(fetchSubtitles(ctx)).rejects.toBeInstanceOf(NotConfigured);
  });
});

describe("Overseerr", () => {
  it("accetta anche il nome del segreto scritto con una R sola (OVERSEER_API_KEY)", async () => {
    const { ctx } = await ctxFor({ OVERSEERR_API_KEY: undefined, OVERSEER_API_KEY: "seerr-key" });
    expect((await fetchRequests(ctx)).pending).toBe(2);
  });

  it("restituisce solo contatori", async () => {
    const { ctx } = await ctxFor();
    expect(await fetchRequests(ctx)).toEqual({
      pending: 2, processing: 34, approved: 1, available: 20, declined: 3, total: 40, movies: 30, tv: 10, issuesOpen: 1,
    });
  });
});

describe("Overseerr: ultimo disponibile", () => {
  it("restituisce titolo, tipo e data, senza dati di chi ha richiesto", async () => {
    const { ctx } = await ctxFor();
    const last = await fetchLastAvailable(ctx);
    expect(last).toEqual({ title: "Ti presento i Fotter", type: "movie", addedAt: "2026-11-24T12:10:00.000Z" });
    expect(JSON.stringify(last)).not.toContain("segreto");
  });

  it("per le serie usa il nome", async () => {
    const net = new FakeNet()
      .json("https://overseerr.test/api/v1/media", { results: [{ mediaType: "tv", tmdbId: 5 }] })
      .json("https://overseerr.test/api/v1/tv/5", { name: "Serie X" });
    expect(await fetchLastAvailable({ env: baseEnv(), fetch: net.fetch })).toMatchObject({ title: "Serie X", type: "tv" });
  });

  it("ripiega sull'ordinamento 'modified' se 'mediaAdded' non è supportato", async () => {
    const net = new FakeNet()
      .on(/\/api\/v1\/media\?.*sort=mediaAdded/, () => new Response("bad", { status: 400 }))
      .json("https://overseerr.test/api/v1/media", { results: [{ mediaType: "movie", tmdbId: 1 }] })
      .json("https://overseerr.test/api/v1/movie/1", { title: "Film" });
    expect((await fetchLastAvailable({ env: baseEnv(), fetch: net.fetch }))?.title).toBe("Film");
  });

  it("senza risultati restituisce null", async () => {
    const net = new FakeNet().json("https://overseerr.test/api/v1/media", { results: [] });
    expect(await fetchLastAvailable({ env: baseEnv(), fetch: net.fetch })).toBeNull();
  });
});

describe("errori dei servizi a monte", () => {
  const run = async (net: FakeNet) =>
    fetchRequests({ env: baseEnv(), fetch: net.fetch }).then(
      () => "ok",
      (error: unknown) => (error instanceof UpstreamError ? error.message : `altro: ${String(error)}`),
    );

  it("un redirect significa che Access ha chiesto il login", async () => {
    const net = new FakeNet().on("https://overseerr.test", () => new Response(null, { status: 302, headers: { Location: "https://login" } }));
    expect(await run(net)).toContain("token di servizio non accettato");
  });

  it("chiede sempre di non seguire i redirect, per non finire su pagine di login", async () => {
    const net = new FakeNet().json("https://overseerr.test", {});
    await run(net);
    expect(net.calls.length).toBeGreaterThan(0);
    expect(net.calls.every((call) => call.redirect === "manual")).toBe(true);
  });

  it("401 e 403 indicano chiave non valida", async () => {
    const net = new FakeNet().on("https://overseerr.test", () => new Response("no", { status: 401 }));
    expect(await run(net)).toContain("chiave o token non validi");
  });

  it("un 500 viene riportato senza dettagli", async () => {
    const net = new FakeNet().on("https://overseerr.test", () => new Response("boom", { status: 500 }));
    expect(await run(net)).toBe("Errore del servizio (HTTP 500)");
  });

  it("timeout e rete assente producono messaggi chiari e senza indirizzi", async () => {
    const timeout = await fetchRequests({
      env: baseEnv(),
      fetch: async () => {
        throw new DOMException("scaduto", "TimeoutError");
      },
    }).catch((e: Error) => e.message);
    expect(timeout).toBe("Timeout");

    const down = await fetchRequests({
      env: baseEnv(),
      fetch: async () => {
        throw new TypeError("fetch failed: https://overseerr.test/segreto");
      },
    }).catch((e: Error) => e.message);
    expect(down).toBe("Servizio non raggiungibile");
  });

  it("una risposta che non è JSON viene rifiutata", async () => {
    const net = new FakeNet().on("https://overseerr.test", () => new Response("<html>", { status: 200 }));
    expect(await run(net)).toBe("Risposta non valida dal servizio");
  });
});
