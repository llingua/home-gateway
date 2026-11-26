import { WriteError } from "./errors";
import type { Store } from "./store";
import { baseUrl, getJson, request, requireSecret } from "./upstream";
import type { Client, Ctx } from "./types";

/**
 * Cerca film e serie e, su conferma della persona in chat, li aggiunge ai download come *richiesta Overseerr*.
 *
 * Perché Overseerr e non Radarr/Sonarr direttamente: valgono le regole di sempre (profili, cartelle, approvazione
 * automatica o manuale) e la richiesta compare nella pagina delle richieste, dove si può annullare.
 *
 * La richiesta NON passa dalla pagina di approvazione (è un'aggiunta annullabile), ma ha limiti stretti:
 * permesso `media:request`, conferma esplicita, tetto giornaliero, controllo "già richiesto/disponibile",
 * verifica dopo la scrittura e voce nel registro. Non può cancellare né modificare nulla.
 */

export const MAX_MEDIA_REQUESTS_PER_DAY = 10;
const MAX_RESULTS = 8;
const MAX_SEASONS = 40;

export type MediaState = "non_richiesto" | "in_attesa_di_approvazione" | "approvato_in_download" | "parzialmente_disponibile" | "disponibile";

/** Overseerr: 1 sconosciuto, 2 in attesa, 3 in elaborazione, 4 parziale, 5 disponibile (6 = eliminato). */
function stateOf(status: unknown): MediaState {
  switch (status) {
    case 2:
      return "in_attesa_di_approvazione";
    case 3:
      return "approvato_in_download";
    case 4:
      return "parzialmente_disponibile";
    case 5:
      return "disponibile";
    default:
      return "non_richiesto";
  }
}

export interface MediaHit {
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  year: string | null;
  overview: string | null;
  state: MediaState;
}

const clean = (value: unknown, max: number): string => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function overseerr(ctx: Ctx) {
  const key = requireSecret(ctx.env.OVERSEERR_API_KEY ?? ctx.env.OVERSEER_API_KEY, "overseerr");
  return { base: baseUrl(ctx.env, "overseerr"), headers: { "X-Api-Key": key } };
}

interface RawSearchResult {
  mediaType?: string;
  id?: number;
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
  mediaInfo?: { status?: number };
}

/** Cerca per titolo. Restituisce solo titolo, anno, trama breve e se è già richiesto/disponibile. */
export async function searchMedia(ctx: Ctx, rawQuery: unknown, rawType?: unknown): Promise<{ query: string; results: MediaHit[] }> {
  const query = clean(rawQuery, 100);
  if (query.length < 2) throw new WriteError("invalid_input", "Scrivi almeno 2 caratteri da cercare");
  const type = rawType === "movie" || rawType === "tv" ? rawType : undefined;
  if (rawType !== undefined && rawType !== null && !type) throw new WriteError("invalid_input", "mediaType deve essere movie o tv");

  const { base, headers } = overseerr(ctx);
  const page = await getJson<{ results?: RawSearchResult[] }>(ctx, `${base}/api/v1/search?query=${encodeURIComponent(query)}&page=1&language=it`, { headers });

  const results: MediaHit[] = [];
  for (const item of page.results ?? []) {
    if ((item.mediaType !== "movie" && item.mediaType !== "tv") || typeof item.id !== "number") continue;
    if (type && item.mediaType !== type) continue;
    const title = clean(item.title ?? item.name, 120);
    if (!title) continue;
    const date = clean(item.releaseDate ?? item.firstAirDate, 10);
    results.push({
      mediaType: item.mediaType,
      tmdbId: item.id,
      title,
      year: /^\d{4}/.test(date) ? date.slice(0, 4) : null,
      overview: item.overview ? clean(item.overview, 280) : null,
      state: stateOf(item.mediaInfo?.status),
    });
    if (results.length >= MAX_RESULTS) break;
  }
  return { query, results };
}

interface RawDetail {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  mediaInfo?: { status?: number };
  seasons?: Array<{ seasonNumber?: number }>;
}

const dayKey = (nowSeconds: number) => `limit:media-request:${new Date(nowSeconds * 1000).toISOString().slice(0, 10)}`;

export interface RequestInput {
  mediaType: unknown;
  tmdbId: unknown;
  seasons?: unknown;
  confirmedByUser: unknown;
}

export interface RequestDeps {
  ctx: Ctx;
  store: Store;
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
  now: () => number;
}

export async function requestMedia(deps: RequestDeps, client: Client, input: RequestInput) {
  const { ctx, store, kv, now } = deps;
  if (!(client.scopes.includes("*") || client.scopes.includes("media:request"))) {
    throw new WriteError("forbidden", "Permesso mancante: media:request");
  }
  if (input.confirmedByUser !== true) {
    throw new WriteError("not_confirmed", "Chiedi prima conferma alla persona (titolo e anno) e passa confirmedByUser: true solo dopo il suo sì");
  }
  if (input.mediaType !== "movie" && input.mediaType !== "tv") throw new WriteError("invalid_input", "mediaType deve essere movie o tv");
  const mediaType = input.mediaType;
  const tmdbId = input.tmdbId;
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId < 1 || tmdbId > 99_999_999) throw new WriteError("invalid_input", "tmdbId non valido");

  const key = dayKey(now());
  const used = Number((await kv.get(key)) ?? "0") || 0;
  if (used >= MAX_MEDIA_REQUESTS_PER_DAY) {
    throw new WriteError("daily_limit", `Limite giornaliero raggiunto (${MAX_MEDIA_REQUESTS_PER_DAY} richieste): riprova domani o chiedi dall'app Overseerr`);
  }

  const { base, headers } = overseerr(ctx);
  const detail = await getJson<RawDetail>(ctx, `${base}/api/v1/${mediaType}/${tmdbId}`, { headers });
  const title = clean(detail.title ?? detail.name, 120);
  if (!title) throw new WriteError("not_found", "Titolo non trovato");
  const date = clean(detail.releaseDate ?? detail.firstAirDate, 10);
  const year = /^\d{4}/.test(date) ? date.slice(0, 4) : null;

  const state = stateOf(detail.mediaInfo?.status);
  if (state !== "non_richiesto" && !(mediaType === "tv" && state === "parzialmente_disponibile")) {
    throw new WriteError("already_requested", `"${title}" è già ${state.replace(/_/g, " ")}: non serve aggiungerlo`);
  }

  const body: Record<string, unknown> = { mediaType, mediaId: tmdbId };
  let seasons: number[] | undefined;
  if (mediaType === "tv") {
    const available = (detail.seasons ?? []).map((season) => season.seasonNumber).filter((n): n is number => Number.isInteger(n) && (n as number) > 0);
    if (input.seasons === undefined || input.seasons === "all") {
      seasons = available;
    } else if (Array.isArray(input.seasons) && input.seasons.length > 0 && input.seasons.length <= MAX_SEASONS && input.seasons.every((n) => Number.isInteger(n) && n >= 1 && n <= 200)) {
      seasons = [...new Set(input.seasons as number[])].sort((a, b) => a - b);
      const unknown = seasons.filter((n) => !available.includes(n));
      if (unknown.length) throw new WriteError("invalid_input", `Stagioni inesistenti: ${unknown.join(", ")}`);
    } else {
      throw new WriteError("invalid_input", 'seasons deve essere "all" o un elenco di numeri di stagione');
    }
    if (seasons.length === 0) throw new WriteError("invalid_input", "La serie non ha stagioni richiedibili");
    body.seasons = seasons;
  }

  // Si conta il tentativo PRIMA di scrivere: un errore a metà non permette di aggirare il tetto.
  await kv.put(key, String(used + 1), { expirationTtl: 2 * 24 * 3600 });

  const response = await request(ctx, `${base}/api/v1/request`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  let created: { status?: number } = {};
  try {
    created = (await response.json()) as { status?: number };
  } catch {
    /* risposta senza corpo: si verifica comunque sotto */
  }

  const after = await getJson<RawDetail>(ctx, `${base}/api/v1/${mediaType}/${tmdbId}`, { headers });
  if (stateOf(after.mediaInfo?.status) === "non_richiesto") {
    await store.audit({ event: "richiesta_media_fallita", actor: client.name, action: "media_request", detail: `${title} (${mediaType} ${tmdbId})` });
    throw new WriteError("verify_failed", "La richiesta è stata inviata ma Overseerr non la mostra: controlla l'app Overseerr");
  }

  await store.audit({ event: "richiesta_media", actor: client.name, action: "media_request", detail: `${title}${year ? ` (${year})` : ""} [${mediaType} ${tmdbId}${seasons ? ` stagioni ${seasons.join(",")}` : ""}]` });
  return {
    requested: true,
    title,
    year,
    mediaType,
    ...(seasons ? { seasons } : {}),
    outcome: created.status === 2 ? "approvata: parte il download" : "in attesa di approvazione in Overseerr",
    requestsToday: used + 1,
    dailyLimit: MAX_MEDIA_REQUESTS_PER_DAY,
  };
}
