import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { baseEnv, FakeNet, JWKS_URL, makeKey, NOW, signJwt, validClaims, type TestKey } from "./helpers";

let key: TestKey;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SECRET_URL = "https://prowlarr.interno.example/1/download?apikey=chiave-segretissima-1234567890abcdef&link=x";
const day = (offset: number) => new Date(NOW * 1000 + offset * 86400_000).toISOString();

/** Radarr, Sonarr e Bazarr finti, con segreti piantati dove li mettono i servizi veri. */
function net(options: { bazarrDown?: boolean; noReleases?: boolean } = {}) {
  const n = new FakeNet();
  n.json(JWKS_URL, { keys: [key.jwk] });
  // --- Radarr
  n.json("https://radarr.test/api/v3/qualityprofile", [{ id: 9, name: "2160p Quality (IT)" }, { id: 1, name: "Any" }]);
  n.json(/^https:\/\/radarr\.test\/api\/v3\/movie$/ as any, [
    { id: 1, title: "Dune", year: 2021, monitored: true, hasFile: true, isAvailable: true, status: "released", minimumAvailability: "released", qualityProfileId: 9, movieFile: { quality: { quality: { name: "Bluray-2160p" } }, size: 50 * 1024 ** 3, languages: [{ name: "Italian" }], path: "/media/library/Movies/Dune/dune.mkv" } },
    { id: 2, title: "Dune - Parte due", year: 2024, monitored: true, hasFile: false, isAvailable: true, status: "released", minimumAvailability: "released", qualityProfileId: 9 },
    { id: 3, title: "Film futuro", year: 2027, monitored: true, hasFile: false, isAvailable: false, status: "announced", minimumAvailability: "released", qualityProfileId: 9 },
    { id: 4, title: "Non seguito", year: 2010, monitored: false, hasFile: false, isAvailable: true, status: "released", minimumAvailability: "released", qualityProfileId: 1 },
  ]);
  n.on(/^https:\/\/radarr\.test\/api\/v3\/history\/movie\?movieId=2$/, () => json([
    { date: day(-3), eventType: "grabbed", sourceTitle: "Dune.Part.Two.2024.2160p.ITA", quality: { quality: { name: "WEBDL-2160p" } }, data: { indexer: "FutureTorrent (Prowlarr)", downloadUrl: SECRET_URL, guid: "guid-segreto", releaseGroup: "GRP" } },
    { date: day(-2), eventType: "downloadFailed", sourceTitle: "Dune.Part.Two.2024.2160p.ITA", data: { message: "Torrent morto: nessun seeder", downloadClient: "qBittorrent" } },
  ]));
  n.on(/^https:\/\/radarr\.test\/api\/v3\/history\/movie/, () => json([]));
  n.on(/^https:\/\/radarr\.test\/api\/v3\/queue\/details/, () => json([]));
  n.on(/^https:\/\/radarr\.test\/api\/v3\/release\?movieId=2$/, () => json(options.noReleases ? [] : [
    { title: "Dune.Part.Two.2024.1080p.ENG", indexer: "YTS (Prowlarr)", size: 2 * 1024 ** 3, seeders: 900, quality: { quality: { name: "WEBDL-1080p" } }, languages: [{ name: "English" }], customFormatScore: 0, approved: false, rejections: ["Quality not wanted in profile", "Custom Format score 0 below minimum 100000"], downloadUrl: SECRET_URL, guid: "guid-segreto", magnetUrl: "magnet:?xt=urn:btih:segreto", infoUrl: "https://tracker.interno.example/t/1" },
    { title: "Dune.Part.Two.2024.2160p.ENG", indexer: "TPB (Prowlarr)", size: 20 * 1024 ** 3, seeders: 3, quality: { quality: { name: "WEBDL-2160p" } }, languages: [{ name: "English" }], approved: false, rejections: [{ reason: "Custom Format score 0 below minimum 100000", type: "permanent" }], downloadUrl: SECRET_URL },
  ]));
  n.json("https://radarr.test/api/v3/wanted/missing", { totalRecords: 3, records: [{ id: 2, title: "Dune - Parte due", year: 2024, status: "released", minimumAvailability: "released", isAvailable: true }, { id: 3, title: "Film futuro", year: 2027, status: "announced", minimumAvailability: "released", isAvailable: false }] });
  n.on(/^https:\/\/radarr\.test\/api\/v3\/blocklist/, () => json({ records: [{ id: 5, movieId: 2, sourceTitle: "Dune.Part.Two.2024.ITA.2160p", date: day(-4), message: "Manually marked as failed", torrentInfoHash: "hash-segreto", downloadUrl: SECRET_URL }, { id: 6, movieId: 1, sourceTitle: "Dune.2021.ITA" }] }));
  // --- Sonarr
  n.json("https://sonarr.test/api/v3/qualityprofile", [{ id: 10, name: "1080p Quality" }]);
  n.json(/^https:\/\/sonarr\.test\/api\/v3\/series$/ as any, [
    { id: 7, title: "The Big Bang Theory", year: 2007, monitored: true, status: "ended", seriesType: "standard", qualityProfileId: 10, statistics: { episodeFileCount: 3, episodeCount: 5, totalEpisodeCount: 5, sizeOnDisk: 3 * 1024 ** 3 }, seasons: [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }, { seasonNumber: 2, monitored: false }], path: "/media/library/TV/tbbt" },
    { id: 8, title: "The Tonight Show Starring Jimmy Fallon", year: 2014, monitored: true, status: "continuing", seriesType: "daily", qualityProfileId: 10, statistics: {}, seasons: [{ seasonNumber: 14, monitored: true }] },
    { id: 9, title: "The Big Bang Theory Extra", year: 2010, monitored: true, seriesType: "standard", qualityProfileId: 10, statistics: {}, seasons: [] },
  ]);
  n.on(/^https:\/\/sonarr\.test\/api\/v3\/episode\?seriesId=7$/, () => json([
    { id: 701, seasonNumber: 1, episodeNumber: 1, title: "Pilot", airDateUtc: day(-5000), hasFile: true, monitored: true },
    { id: 702, seasonNumber: 1, episodeNumber: 2, title: "Due", airDateUtc: day(-4990), hasFile: true, monitored: true },
    { id: 703, seasonNumber: 2, episodeNumber: 1, title: "Tre", airDateUtc: day(-4600), hasFile: false, monitored: false },
    { id: 704, seasonNumber: 2, episodeNumber: 2, title: "Quattro", airDateUtc: day(-4590), hasFile: true, monitored: false },
    { id: 705, seasonNumber: 1, episodeNumber: 3, title: "Cinque", airDateUtc: day(-4980), hasFile: false, monitored: true },
    { id: 799, seasonNumber: 3, episodeNumber: 1, title: "Futuro", airDateUtc: day(30), hasFile: false, monitored: true },
  ]));
  n.on(/^https:\/\/sonarr\.test\/api\/v3\/episode\?seriesId=8$/, () => json([{ id: 801, seasonNumber: 14, episodeNumber: 34, title: "Ospite", airDateUtc: day(-1), hasFile: false, monitored: true }]));
  n.on(/^https:\/\/sonarr\.test\/api\/v3\/history\/series/, () => json([{ date: day(-1), eventType: "downloadFailed", sourceTitle: "Jimmy.Fallon.2026.11.25", episode: { seasonNumber: 14, episodeNumber: 34 }, data: { message: "Nessun file video", downloadUrl: SECRET_URL } }]));
  n.on(/^https:\/\/sonarr\.test\/api\/v3\/queue\/details/, () => json([{ title: "The.Big.Bang.Theory.S01E03", status: "downloading", trackedDownloadStatus: "warning", trackedDownloadState: "importPending", sizeleft: 1024 ** 3, timeleft: "00:10:00", episode: { seasonNumber: 1, episodeNumber: 3 }, statusMessages: [{ title: "x", messages: ["Nessun file idoneo in http://192.168.0.171:8080/"] }], downloadId: "hash-segreto", outputPath: "/media/downloads/x" }]));
  n.on(/^https:\/\/sonarr\.test\/api\/v3\/release/, () => json([{ title: "The.Tonight.Show.2026.11.25.720p", indexer: "kickass (Prowlarr)", size: 1024 ** 3, seeders: 1, quality: { quality: { name: "HDTV-720p" } }, approved: false, rejections: ["Quality not wanted in profile"], downloadUrl: SECRET_URL }]));
  n.json("https://sonarr.test/api/v3/wanted/missing", { totalRecords: 4, records: [
    { seriesId: 8, seasonNumber: 14, episodeNumber: 34, airDateUtc: day(-1), series: { title: "The Tonight Show Starring Jimmy Fallon" } },
    { seriesId: 8, seasonNumber: 14, episodeNumber: 33, airDateUtc: day(-2), series: { title: "The Tonight Show Starring Jimmy Fallon" } },
    { seriesId: 7, seasonNumber: 1, episodeNumber: 3, airDateUtc: day(-4980), series: { title: "The Big Bang Theory" } },
  ] });
  // --- Bazarr
  if (options.bazarrDown) n.on(/^https:\/\/bazarr\.test/, () => new Response("no", { status: 500 }));
  n.json("https://bazarr.test/api/system/languages/profiles", [{ profileId: 1, name: "Italiano" }]);
  n.json("https://bazarr.test/api/series", { data: [{ sonarrSeriesId: 8, profileId: 1, episodeMissingCount: 120, episodeFileCount: 130, path: "/segreto" }] });
  n.json("https://bazarr.test/api/movies", { data: [{ radarrId: 2, profileId: 1, missing_subtitles: [{ name: "Italian", code2: "it" }] }] });
  return n;
}

async function tool(n: FakeNet, name: string, args: Record<string, unknown>, who = "agent-id") {
  const response = await handle(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await signJwt(key, validClaims({ common_name: who })) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    baseEnv(),
    { fetch: n.fetch, now: NOW },
  );
  const body = (await response.json()) as any;
  const text: string = body.result?.content?.[0]?.text ?? JSON.stringify(body);
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* messaggio di errore */ }
  return { isError: Boolean(body.result?.isError), text, data };
}

const LEAKS = ["segretissima", "apikey", "guid-segreto", "magnet:", "interno.example", "192.168", "hash-segreto", "http://", "https://"];
const noLeaks = (text: string) => { for (const leak of LEAKS) expect(text, leak).not.toContain(leak); };

describe("list_missing", () => {
  it("Radarr: film monitorati mancanti con stato e disponibilità", async () => {
    const r = await tool(net(), "list_missing", { service: "radarr" });
    expect(r.data.totalMissing).toBe(3);
    expect(r.data.movies[1]).toEqual({ id: 3, title: "Film futuro", year: 2027, status: "announced", minimumAvailability: "released", isAvailable: false });
  });

  it("Sonarr: episodi mancanti raggruppati per serie", async () => {
    const r = await tool(net(), "list_missing", { service: "sonarr" });
    expect(r.data.totalMissingEpisodes).toBe(4);
    expect(r.data.series[0]).toMatchObject({ seriesId: 8, title: "The Tonight Show Starring Jimmy Fallon", missing: 2 });
    expect(r.data.series[0].latest).toMatch(/^S14E34/);
  });

  it("servizio non valido", async () => {
    expect((await tool(net(), "list_missing", { service: "lidarr" })).isError).toBe(true);
  });
});

describe("diagnose_movie", () => {
  it("spiega perché non si scarica: storia con il motivo del fallimento, ricerca con motivi di scarto aggregati, sottotitoli; nessun segreto", async () => {
    const n = net();
    const r = await tool(n, "diagnose_movie", { query: "dune parte due", searchReleases: true });
    expect(r.isError).toBe(false);
    expect(r.data.movie).toMatchObject({ id: 2, title: "Dune - Parte due", hasFile: false, qualityProfile: "2160p Quality (IT)" });
    expect(r.data.history[0]).toMatchObject({ event: "downloadFailed", message: "Torrent morto: nessun seeder" });
    expect(r.data.history[1]).toMatchObject({ event: "grabbed", indexer: "FutureTorrent (Prowlarr)", releaseGroup: "GRP" });
    expect(r.data.releases).toMatchObject({ found: 2, approved: 0 });
    expect(r.data.releases.topRejectionReasons[0]).toEqual({ reason: "Custom Format score 0 below minimum 100000", count: 2 });
    expect(r.data.releases.best[0]).toMatchObject({ title: "Dune.Part.Two.2024.1080p.ENG", indexer: "YTS (Prowlarr)", seeders: 900, languages: ["English"] });
    expect(r.data.hints.join(" ")).toContain("tutte scartate");
    expect(r.data.subtitles).toEqual({ languageProfile: "Italiano", missingSubtitles: ["Italian"] });
    noLeaks(r.text);
    expect(n.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("mostra le voci in blocklist del film (con id per toglierle) e lo segnala nei suggerimenti", async () => {
    const r = await tool(net(), "diagnose_movie", { id: 2 });
    expect(r.data.blocklist.total).toBe(1);
    expect(r.data.blocklist.entries[0]).toMatchObject({ id: 5, release: "Dune.Part.Two.2024.ITA.2160p", message: "Manually marked as failed" });
    expect(r.data.hints.join(" ")).toContain("in blocklist");
    noLeaks(r.text);
  });

  it("get_blocklist: elenco filtrato, sola lettura, non visibile alla homepage", async () => {
    const n = net();
    const r = await tool(n, "get_blocklist", { service: "radarr", query: "dune part" });
    expect(r.data.entries.map((e: any) => e.id)).toEqual([5]);
    noLeaks(r.text);
    expect(n.calls.every((c) => c.method === "GET")).toBe(true);
    expect((await tool(net(), "get_blocklist", { service: "radarr" }, "homepage-client-id")).isError).toBe(true);
  });

  it("senza searchReleases non interroga gli indexer", async () => {
    const n = net();
    await tool(n, "diagnose_movie", { id: 2 });
    expect(n.calls.some((c) => c.url.includes("/release"))).toBe(false);
  });

  it("suggerimenti: non monitorato, non ancora disponibile, già presente, nessuna uscita", async () => {
    expect((await tool(net(), "diagnose_movie", { id: 4 })).data.hints.join(" ")).toContain("Non è monitorato");
    expect((await tool(net(), "diagnose_movie", { id: 3 })).data.hints.join(" ")).toContain("Non è ancora considerato disponibile");
    const present = await tool(net(), "diagnose_movie", { query: "Dune" });
    expect(present.data.hints.join(" ")).toContain("già presente");
    expect(present.data.movie.file).toEqual({ quality: "Bluray-2160p", sizeGb: 50, languages: ["Italian"] });
    expect(present.text).not.toContain("/media/library/Movies/Dune");
    expect((await tool(net({ noReleases: true }), "diagnose_movie", { id: 2, searchReleases: true })).data.hints.join(" ")).toContain("non trovano nessuna uscita");
  });

  it("titolo ambiguo → candidati; inesistente → errore; Bazarr giù → nota", async () => {
    const amb = await tool(net(), "diagnose_movie", { query: "dun" });
    expect(amb.data.candidates.map((c: any) => c.id)).toEqual([1, 2]);
    expect((await tool(net(), "diagnose_movie", { query: "Matrix" })).text).toContain("not_found");
    expect((await tool(net(), "diagnose_movie", { query: "x" })).isError).toBe(true);
    expect((await tool(net({ bazarrDown: true }), "diagnose_movie", { id: 2 })).data.subtitles).toEqual({ note: "Bazarr non raggiungibile o non configurato" });
  });
});

describe("diagnose_series", () => {
  it("stagioni complete e mancanti contando solo gli episodi già usciti; stagioni non monitorate; coda; nessun segreto", async () => {
    const r = await tool(net(), "diagnose_series", { query: "the big bang theory" });
    expect(r.data.series).toMatchObject({ id: 7, title: "The Big Bang Theory", qualityProfile: "1080p Quality", episodesWithFile: 3 });
    expect(r.data.seasons).toEqual([
      { season: 0, monitored: false, episodes: 0, aired: 0, withFile: 0, missingAired: 0, complete: false },
      { season: 1, monitored: true, episodes: 3, aired: 3, withFile: 2, missingAired: 1, complete: false },
      { season: 2, monitored: false, episodes: 2, aired: 2, withFile: 1, missingAired: 1, complete: false },
      { season: 3, monitored: null, episodes: 1, aired: 0, withFile: 0, missingAired: 0, complete: false },
    ]);
    expect(r.data.missingEpisodes.total).toBe(2);
    expect(r.data.hints.join(" ")).toContain("non monitorate (non vengono cercate): 2");
    expect(r.data.queue[0]).toMatchObject({ episode: "S01E03", trackedState: "importPending" });
    expect(r.data.queue[0].messages[0]).toContain("[omesso]");
    noLeaks(r.text);
  });

  it("serie giornaliera: suggerimento, ricerca dell'episodio mancante più recente, sottotitoli italiani mancanti", async () => {
    const n = net();
    const r = await tool(n, "diagnose_series", { query: "jimmy fallon", searchReleases: true });
    expect(r.data.series.seriesType).toBe("daily");
    expect(r.data.hints.join(" ")).toContain("giornaliera");
    expect(r.data.history[0]).toMatchObject({ event: "downloadFailed", episode: "S14E34", message: "Nessun file video" });
    expect(r.data.releases).toMatchObject({ searchedFor: "episodio mancante più recente S14E34", found: 1, approved: 0 });
    expect(n.calls.some((c) => c.url.endsWith("/api/v3/release?episodeId=801"))).toBe(true);
    expect(r.data.subtitles).toEqual({ languageProfile: "Italiano", episodesWithMissingSubtitles: 120, episodesWithFile: 130 });
    noLeaks(r.text);
  });

  it("ricerca di una stagione intera con season", async () => {
    const n = net();
    await tool(n, "diagnose_series", { id: 7, searchReleases: true, season: 2 });
    expect(n.calls.some((c) => c.url.endsWith("/api/v3/release?seriesId=7&seasonNumber=2"))).toBe(true);
  });

  it("corrispondenza esatta preferita a quelle parziali", async () => {
    expect((await tool(net(), "diagnose_series", { query: "The Big Bang Theory" })).data.series.id).toBe(7);
  });
});

describe("permessi", () => {
  it("la homepage (solo media:read) non vede né usa gli strumenti di diagnosi", async () => {
    const r = await tool(net(), "diagnose_movie", { id: 2 }, "homepage-client-id");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("config:read");
  });
});
