import { WriteError } from "./errors";
import { readBlocklist } from "./arr-blocklist";
import { scrubSecrets, stripAddresses } from "./scrub";
import { arrAccess, type ArrService } from "./services/arr";
import { baseUrl, getJson, requireSecret } from "./upstream";
import type { Ctx as BaseCtx } from "./types";

type Ctx = BaseCtx & { now?: number };

/**
 * Diagnosi in SOLA LETTURA: perché un film o una serie non si scarica, cosa manca, cosa è stato cercato e scartato.
 *
 * Si leggono da Radarr/Sonarr (ed eventualmente Bazarr) solo i campi utili, scelti per nome: mai indirizzi di download
 * (che contengono le chiavi degli indexer), guid, magnet o credenziali. Sopra c'è comunque la pulizia finale.
 * La ricerca delle uscite (`searchReleases`) interroga davvero gli indexer ma NON scarica nulla: è la stessa cosa della
 * "ricerca interattiva" dell'interfaccia, senza premere il pulsante di download.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown, max = 5000): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const str = (value: unknown, max = 200): string | null => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const gb = (bytes: unknown): number | null => (typeof bytes === "number" ? Math.round((bytes / 1024 ** 3) * 100) / 100 : null);
const nameOf = (value: unknown): string | null => (isRecord(value) ? str(value.name) : null);
const qualityName = (value: unknown): string | null => (isRecord(value) && isRecord(value.quality) ? str(value.quality.name) : null);

/** Uscita finale: niente indirizzi né segreti, anche se un campo fosse sfuggito alla selezione. */
const clean = <T>(value: T): T => scrubSecrets(stripAddresses(value) as T);

const LONG = 15_000; // elenchi grandi (libreria, episodi)
const SEARCH = 60_000; // ricerca negli indexer: può essere lenta

const arrGet = (ctx: Ctx, service: ArrService, path: string, timeoutMs = LONG) => {
  const { base, headers } = arrAccess(ctx, service);
  return getJson<unknown>(ctx, `${base}${path}`, { headers, timeoutMs });
};

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Trova un elemento per id o per titolo. Più risultati senza corrispondenza esatta = elenco di candidati da cui scegliere. */
function pick(items: Record<string, unknown>[], query: unknown, id: unknown): { item?: Record<string, unknown>; candidates?: Array<{ id: unknown; title: string | null; year: unknown }> } {
  if (typeof id === "number") {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new WriteError("not_found", `Nessun elemento con id ${id}`);
    return { item };
  }
  if (typeof query !== "string" || normalize(query).length < 2) throw new WriteError("invalid_input", "Indica un titolo (almeno 2 caratteri) oppure un id");
  const q = normalize(query);
  const titles = items.map((item) => ({ item, title: normalize(String(item.title ?? "")) }));
  const exact = titles.filter((entry) => entry.title === q);
  const matches = exact.length ? exact : titles.filter((entry) => entry.title.includes(q) || q.includes(entry.title) && entry.title.length > 3);
  if (matches.length === 0) throw new WriteError("not_found", `"${query.slice(0, 100)}" non è nella libreria`);
  if (matches.length === 1) return { item: matches[0]!.item };
  return { candidates: matches.slice(0, 10).map(({ item }) => ({ id: item.id, title: str(item.title), year: item.year })) };
}

async function profileNames(ctx: Ctx, service: ArrService): Promise<Map<number, string>> {
  const profiles = list(await arrGet(ctx, service, "/api/v3/qualityprofile"));
  return new Map(profiles.filter(isRecord).map((p) => [p.id as number, String(p.name ?? "")]));
}

// --- Storia, coda, uscite ----------------------------------------------------------------------------------------

const HISTORY_DATA_KEYS = ["indexer", "releaseGroup", "message", "reason", "downloadClientName", "downloadClient", "importedPath", "droppedPath"] as const;

interface HistoryItem {
  date: string | null;
  event: string | null;
  release: string | null;
  quality: string | null;
  episode?: string;
  message?: string;
  reason?: string;
  [key: string]: string | null | undefined;
}

function historyItems(raw: unknown, max = 15): HistoryItem[] {
  return list(raw)
    .filter(isRecord)
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .slice(0, max)
    .map((event) => {
      const data = isRecord(event.data) ? event.data : {};
      const details: Record<string, string> = {};
      for (const key of HISTORY_DATA_KEYS) {
        const value = str(data[key], 300);
        if (value) details[key] = value;
      }
      const episode = isRecord(event.episode) ? `S${String(event.episode.seasonNumber).padStart(2, "0")}E${String(event.episode.episodeNumber).padStart(2, "0")}` : undefined;
      return { date: str(event.date), event: str(event.eventType), release: str(event.sourceTitle), quality: qualityName(event.quality), ...(episode ? { episode } : {}), ...details };
    });
}

function queueItems(raw: unknown) {
  return list(raw, 50)
    .filter(isRecord)
    .map((item) => ({
      ...(typeof item.id === "number" ? { queueId: item.id } : {}),
      release: str(item.title),
      status: str(item.status),
      trackedStatus: str(item.trackedDownloadStatus),
      trackedState: str(item.trackedDownloadState),
      timeLeft: str(item.timeleft),
      sizeLeftGb: gb(item.sizeleft),
      quality: qualityName(item.quality),
      ...(isRecord(item.episode) ? { episode: `S${String(item.episode.seasonNumber).padStart(2, "0")}E${String(item.episode.episodeNumber).padStart(2, "0")}` } : {}),
      error: str(item.errorMessage, 300),
      messages: list(item.statusMessages, 10)
        .filter(isRecord)
        .flatMap((m) => list(m.messages, 10).map((text) => str(text, 300)))
        .filter((m): m is string => !!m),
    }));
}

const rejectionText = (value: unknown): string | null => (typeof value === "string" ? str(value, 200) : isRecord(value) ? str(value.reason ?? value.message, 200) : null);

/** Uscite trovate dagli indexer: riepilogo dei motivi di scarto e le prime in ordine di preferenza. Nessun indirizzo, guid o magnet. */
function releaseSummary(raw: unknown) {
  const releases = list(raw, 2000).filter(isRecord);
  const reasons = new Map<string, number>();
  for (const release of releases) {
    for (const reason of list(release.rejections, 30).map(rejectionText)) if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    found: releases.length,
    approved: releases.filter((release) => release.approved === true).length,
    topRejectionReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
    best: releases.slice(0, 12).map((release) => ({
      title: str(release.title),
      indexer: str(release.indexer),
      quality: qualityName(release.quality),
      sizeGb: gb(release.size),
      seeders: num(release.seeders),
      languages: list(release.languages, 10).map(nameOf).filter(Boolean),
      customFormatScore: num(release.customFormatScore),
      approved: release.approved === true,
      rejections: list(release.rejections, 10).map(rejectionText).filter(Boolean),
    })),
  };
}

// --- Bazarr: sottotitoli (facoltativo: se Bazarr non risponde, il resto della diagnosi resta) ---------------------

async function bazarr(ctx: Ctx, path: string): Promise<unknown> {
  const key = requireSecret(ctx.env.BAZARR_API_KEY, "bazarr");
  return getJson<unknown>(ctx, `${baseUrl(ctx.env, "bazarr")}${path}`, { headers: { "X-API-KEY": key }, timeoutMs: LONG });
}

async function bazarrProfiles(ctx: Ctx): Promise<Map<number, string>> {
  return new Map(list(await bazarr(ctx, "/api/system/languages/profiles")).filter(isRecord).map((p) => [p.profileId as number, String(p.name ?? "")]));
}

async function subtitlesForSeries(ctx: Ctx, sonarrId: number) {
  try {
    const [data, profiles] = await Promise.all([bazarr(ctx, `/api/series?seriesid[]=${sonarrId}`), bazarrProfiles(ctx)]);
    const record = isRecord(data) ? list(data.data, 1).filter(isRecord)[0] : undefined;
    if (!record) return { note: "Bazarr non conosce questa serie" };
    const profileId = num(record.profileId);
    return {
      languageProfile: profileId === null ? null : profiles.get(profileId) ?? `#${profileId}`,
      episodesWithMissingSubtitles: num(record.episodeMissingCount),
      episodesWithFile: num(record.episodeFileCount),
    };
  } catch {
    return { note: "Bazarr non raggiungibile o non configurato" };
  }
}

async function subtitlesForMovie(ctx: Ctx, radarrId: number) {
  try {
    const [data, profiles] = await Promise.all([bazarr(ctx, `/api/movies?radarrid[]=${radarrId}`), bazarrProfiles(ctx)]);
    const record = isRecord(data) ? list(data.data, 1).filter(isRecord)[0] : undefined;
    if (!record) return { note: "Bazarr non conosce questo film" };
    const profileId = num(record.profileId);
    return {
      languageProfile: profileId === null ? null : profiles.get(profileId) ?? `#${profileId}`,
      missingSubtitles: list(record.missing_subtitles, 20).map((m) => (isRecord(m) ? str(m.name ?? m.code2) : null)).filter(Boolean),
    };
  } catch {
    return { note: "Bazarr non raggiungibile o non configurato" };
  }
}

// --- Elenco di ciò che manca -------------------------------------------------------------------------------------

type Blocked = Awaited<ReturnType<typeof blocklistOf>>;

/** Voci di blocklist di un film o di una serie (le più recenti). Se la blocklist non si legge, si dice e basta. */
async function blocklistOf(ctx: Ctx, service: ArrService, mediaId: number) {
  try {
    const entries = (await readBlocklist(ctx, service, false)).filter((e) => e.mediaId === mediaId);
    return { total: entries.length, entries: entries.slice(0, 15).map(({ title: _t, mediaId: _m, ...rest }) => rest) };
  } catch {
    return { total: 0, entries: [], note: "Blocklist non leggibile" };
  }
}

export async function listMissing(ctx: Ctx, rawService: unknown, rawLimit: unknown) {
  if (rawService !== "radarr" && rawService !== "sonarr") throw new WriteError("invalid_input", "service deve essere radarr o sonarr");
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 30;
  if (rawService === "radarr") {
    const data = await arrGet(ctx, "radarr", `/api/v3/wanted/missing?page=1&pageSize=${limit}&monitored=true&sortKey=title&sortDirection=ascending`);
    const records = isRecord(data) ? list(data.records, limit).filter(isRecord) : [];
    return clean({
      service: "radarr",
      totalMissing: isRecord(data) ? num(data.totalRecords) : null,
      movies: records.map((movie) => ({
        id: movie.id, title: str(movie.title), year: num(movie.year), status: str(movie.status), minimumAvailability: str(movie.minimumAvailability), isAvailable: movie.isAvailable === true,
      })),
      hint: "Per il perché di un film: diagnose_movie con il suo id (e searchReleases: true per vedere cosa trovano gli indexer e perché viene scartato).",
    });
  }
  const data = await arrGet(ctx, "sonarr", "/api/v3/wanted/missing?page=1&pageSize=1000&monitored=true&includeSeries=true&sortKey=airDateUtc&sortDirection=descending");
  const records = isRecord(data) ? list(data.records, 1000).filter(isRecord) : [];
  const bySeries = new Map<number, { seriesId: number; title: string | null; missing: number; latest: string | null }>();
  for (const episode of records) {
    const seriesId = num(episode.seriesId);
    if (seriesId === null) continue;
    const entry = bySeries.get(seriesId) ?? { seriesId, title: isRecord(episode.series) ? str(episode.series.title) : null, missing: 0, latest: null };
    entry.missing += 1;
    entry.latest ??= `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")} (${str(episode.airDateUtc)?.slice(0, 10) ?? "?"})`;
    bySeries.set(seriesId, entry);
  }
  return clean({
    service: "sonarr",
    totalMissingEpisodes: isRecord(data) ? num(data.totalRecords) : null,
    countedFromLatest: records.length,
    series: [...bySeries.values()].sort((a, b) => b.missing - a.missing).slice(0, limit),
    hint: "Per il perché di una serie: diagnose_series con il suo id (e searchReleases: true per vedere cosa trovano gli indexer).",
  });
}

// --- Diagnosi di un film -----------------------------------------------------------------------------------------

export async function diagnoseMovie(ctx: Ctx, args: Record<string, unknown>) {
  const movies = list(await arrGet(ctx, "radarr", "/api/v3/movie")).filter(isRecord);
  const { item: movie, candidates } = pick(movies, args.query, args.id);
  if (!movie) return clean({ candidates, hint: "Più film corrispondono: ripeti con l'id giusto." });
  const id = movie.id as number;
  const blockedP = blocklistOf(ctx, "radarr", id);
  const [profiles, history, queue] = await Promise.all([
    profileNames(ctx, "radarr"),
    arrGet(ctx, "radarr", `/api/v3/history/movie?movieId=${id}`).catch(() => []),
    arrGet(ctx, "radarr", `/api/v3/queue/details?movieId=${id}`).catch(() => []),
  ]);
  const file = isRecord(movie.movieFile) ? movie.movieFile : null;
  const hints: string[] = [];
  if (movie.hasFile === true) hints.push("Il film è già presente su disco.");
  if (movie.monitored !== true) hints.push("Non è monitorato: Radarr non lo cerca da solo.");
  if (movie.isAvailable !== true) hints.push(`Non è ancora considerato disponibile (stato "${String(movie.status)}", disponibilità minima "${String(movie.minimumAvailability)}"): Radarr aspetta.`);
  const queued = queueItems(queue);
  if (queued.length) hints.push("È in coda di download: guarda lo stato in `queue`.");
  const events = historyItems(history);
  const lastFailure = events.find((event) => /failed|ignored/i.test(String(event.event)));
  if (lastFailure) hints.push(`Ultimo problema: ${lastFailure.event} — ${lastFailure.message ?? lastFailure.reason ?? lastFailure.release ?? ""}`.trim());
  if (!events.some((event) => event.event === "grabbed") && movie.hasFile !== true) hints.push("Non risulta mai preso (grabbed): probabilmente nessuna uscita trovata o tutte scartate. Usa searchReleases: true per vedere perché.");

  const releases = args.searchReleases === true ? releaseSummary(await arrGet(ctx, "radarr", `/api/v3/release?movieId=${id}`, SEARCH)) : undefined;
  if (releases) {
    if (releases.found === 0) hints.push("Gli indexer non trovano nessuna uscita per questo film.");
    else if (releases.approved === 0) hints.push(`Trovate ${releases.found} uscite ma tutte scartate: vedi topRejectionReasons.`);
    else hints.push(`Ci sono ${releases.approved} uscite accettabili: se non parte, controlla ritardi (profilo di ritardo) e coda.`);
  }
  const blocked: Blocked = await blockedP;
  if (blocked.total) hints.push(`${blocked.total} uscite di questo film sono in blocklist: non verranno riprese finché non le togli (propose_arr_blocklist_remove).`);
  return clean({
    blocklist: blocked,
    movie: {
      id, title: str(movie.title), year: num(movie.year), monitored: movie.monitored === true, hasFile: movie.hasFile === true, status: str(movie.status),
      minimumAvailability: str(movie.minimumAvailability), isAvailable: movie.isAvailable === true,
      qualityProfile: profiles.get(movie.qualityProfileId as number) ?? null,
      inCinemas: str(movie.inCinemas), digitalRelease: str(movie.digitalRelease), physicalRelease: str(movie.physicalRelease),
      file: file ? { quality: qualityName(file.quality), sizeGb: gb(file.size), languages: list(file.languages, 10).map(nameOf).filter(Boolean) } : null,
    },
    hints,
    queue: queued,
    history: events,
    ...(releases ? { releases } : {}),
    subtitles: await subtitlesForMovie(ctx, id),
  });
}

// --- Diagnosi di una serie ---------------------------------------------------------------------------------------

const code = (season: unknown, episode: unknown) => `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;

export async function diagnoseSeries(ctx: Ctx, args: Record<string, unknown>) {
  const all = list(await arrGet(ctx, "sonarr", "/api/v3/series")).filter(isRecord);
  const { item: series, candidates } = pick(all, args.query, args.id);
  if (!series) return clean({ candidates, hint: "Più serie corrispondono: ripeti con l'id giusto." });
  const id = series.id as number;
  const blockedP = blocklistOf(ctx, "sonarr", id);
  const [profiles, episodesRaw, history, queue] = await Promise.all([
    profileNames(ctx, "sonarr"),
    arrGet(ctx, "sonarr", `/api/v3/episode?seriesId=${id}`),
    arrGet(ctx, "sonarr", `/api/v3/history/series?seriesId=${id}&includeEpisode=true`).catch(() => []),
    arrGet(ctx, "sonarr", `/api/v3/queue/details?seriesId=${id}&includeEpisode=true`).catch(() => []),
  ]);
  const now = (ctx.now ?? Math.floor(Date.now() / 1000)) * 1000;
  const episodes = list(episodesRaw).filter(isRecord);
  const aired = (e: Record<string, unknown>) => typeof e.airDateUtc === "string" && Date.parse(e.airDateUtc) <= now;
  const seasonsMap = new Map<number, { season: number; monitored: boolean | null; episodes: number; aired: number; withFile: number; missingAired: number }>();
  for (const season of list(series.seasons, 200).filter(isRecord)) {
    const n = num(season.seasonNumber);
    if (n !== null) seasonsMap.set(n, { season: n, monitored: typeof season.monitored === "boolean" ? season.monitored : null, episodes: 0, aired: 0, withFile: 0, missingAired: 0 });
  }
  const missing: Array<{ episode: string; title: string | null; airDate: string | null; monitored: boolean }> = [];
  for (const episode of episodes) {
    const n = num(episode.seasonNumber);
    if (n === null) continue;
    const entry = seasonsMap.get(n) ?? { season: n, monitored: null, episodes: 0, aired: 0, withFile: 0, missingAired: 0 };
    entry.episodes += 1;
    if (aired(episode)) entry.aired += 1;
    if (episode.hasFile === true) entry.withFile += 1;
    else if (aired(episode)) {
      entry.missingAired += 1;
      missing.push({ episode: code(episode.seasonNumber, episode.episodeNumber), title: str(episode.title), airDate: str(episode.airDateUtc)?.slice(0, 10) ?? null, monitored: episode.monitored === true });
    }
    seasonsMap.set(n, entry);
  }
  const seasons = [...seasonsMap.values()].sort((a, b) => a.season - b.season).map((s) => ({ ...s, complete: s.aired > 0 && s.missingAired === 0 }));
  missing.sort((a, b) => String(b.airDate).localeCompare(String(a.airDate)));

  const hints: string[] = [];
  if (series.monitored !== true) hints.push("La serie non è monitorata: Sonarr non cerca nuovi episodi.");
  const unmonitoredSeasons = seasons.filter((s) => s.monitored === false && s.season > 0 && s.missingAired > 0).map((s) => s.season);
  if (unmonitoredSeasons.length) hints.push(`Stagioni con episodi mancanti ma non monitorate (non vengono cercate): ${unmonitoredSeasons.join(", ")}.`);
  const missingMonitored = missing.filter((m) => m.monitored).length;
  if (missing.length) hints.push(`${missing.length} episodi già usciti mancano (${missingMonitored} monitorati).`);
  if (series.seriesType === "daily") hints.push("È una serie giornaliera: Sonarr cerca le uscite per data; serve che gli indexer abbiano uscite datate di quel programma.");
  if (series.seriesType === "anime") hints.push("È impostata come anime: la numerazione è assoluta, servono uscite con numerazione anime.");
  const queued = queueItems(queue);
  if (queued.length) hints.push("Ci sono episodi in coda di download: guarda `queue`.");
  const events = historyItems(history, 20);
  const lastFailure = events.find((event) => /failed|ignored/i.test(String(event.event)));
  if (lastFailure) hints.push(`Ultimo problema: ${lastFailure.event} ${lastFailure.episode ?? ""} — ${lastFailure.message ?? lastFailure.reason ?? lastFailure.release ?? ""}`.trim());

  let releases: ReturnType<typeof releaseSummary> | undefined;
  let searchedFor: string | undefined;
  if (args.searchReleases === true) {
    const season = num(args.season);
    if (season !== null) {
      searchedFor = `stagione ${season}`;
      releases = releaseSummary(await arrGet(ctx, "sonarr", `/api/v3/release?seriesId=${id}&seasonNumber=${season}`, SEARCH));
    } else {
      const target = episodes.filter((e) => e.hasFile !== true && aired(e) && e.monitored === true).sort((a, b) => String(b.airDateUtc).localeCompare(String(a.airDateUtc)))[0];
      if (target) {
        searchedFor = `episodio mancante più recente ${code(target.seasonNumber, target.episodeNumber)}`;
        releases = releaseSummary(await arrGet(ctx, "sonarr", `/api/v3/release?episodeId=${target.id as number}`, SEARCH));
      } else {
        searchedFor = "niente: nessun episodio monitorato mancante";
      }
    }
    if (releases) {
      if (releases.found === 0) hints.push(`Ricerca (${searchedFor}): gli indexer non trovano nessuna uscita.`);
      else if (releases.approved === 0) hints.push(`Ricerca (${searchedFor}): ${releases.found} uscite trovate, tutte scartate: vedi topRejectionReasons.`);
      else hints.push(`Ricerca (${searchedFor}): ${releases.approved} uscite accettabili.`);
    }
  }

  const stats = isRecord(series.statistics) ? series.statistics : {};
  const blocked: Blocked = await blockedP;
  if (blocked.total) hints.push(`${blocked.total} uscite di questa serie sono in blocklist: non verranno riprese finché non le togli (propose_arr_blocklist_remove).`);
  return clean({
    blocklist: blocked,
    series: {
      id, title: str(series.title), year: num(series.year), monitored: series.monitored === true, status: str(series.status), seriesType: str(series.seriesType),
      qualityProfile: profiles.get(series.qualityProfileId as number) ?? null,
      episodesWithFile: num(stats.episodeFileCount), episodesAiredMonitored: num(stats.episodeCount), totalEpisodes: num(stats.totalEpisodeCount), sizeGb: gb(stats.sizeOnDisk),
    },
    seasons,
    missingEpisodes: { total: missing.length, latest: missing.slice(0, 25) },
    hints,
    queue: queued,
    history: events,
    ...(releases ? { releases: { searchedFor, ...releases } } : searchedFor ? { releases: { searchedFor } } : {}),
    subtitles: await subtitlesForSeries(ctx, id),
  });
}
