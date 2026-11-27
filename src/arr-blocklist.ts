import type { ActionDef } from "./actions";
import { WriteError } from "./errors";
import { scrubSecrets, stripAddresses } from "./scrub";
import { arrAccess, type ArrService } from "./services/arr";
import type { PlanChange } from "./store";
import { getJson, request } from "./upstream";
import type { Ctx } from "./types";

/**
 * Blocklist di Radarr e Sonarr: le uscite che il servizio non riprenderà più (di solito dopo un download segnato come fallito).
 * - lettura (`listBlocklist`): solo campi innocui, mai URL, guid, hash o percorsi;
 * - `arr_blocklist_remove`: toglie voci dalla blocklist (così l'uscita torna scaricabile);
 * - `arr_blocklist_add`: mette in blocklist un download IN CODA (lo toglie dalla coda e, se richiesto, dal client) e fa cercare un'alternativa.
 *   L'API dei servizi non permette di aggiungere un'uscita qualsiasi: si passa sempre da un elemento della coda.
 * Entrambe le scritture passano da proposta + approvazione nel browser.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, max = 200): string | null => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const qualityName = (value: unknown): string | null => (isRecord(value) && isRecord(value.quality) ? str(value.quality.name) : null);
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isRecord).map((v) => str(v.name)).filter((v): v is string => !!v).slice(0, 10) : []);
const clean = <T>(value: T): T => scrubSecrets(stripAddresses(value) as T);
const normalize = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const MAX_RECORDS = 2000;
const MAX_REMOVE = 50;

export interface BlocklistEntry {
  id: number;
  date: string | null;
  release: string | null;
  title: string | null;
  mediaId: number | null;
  quality: string | null;
  languages: string[];
  indexer: string | null;
  protocol: string | null;
  message: string | null;
}

async function titlesOf(ctx: Ctx, service: ArrService): Promise<Map<number, string>> {
  const { base, headers } = arrAccess(ctx, service);
  const items = await getJson<unknown>(ctx, `${base}/api/v3/${service === "radarr" ? "movie" : "series"}`, { headers, timeoutMs: 30_000 }).catch(() => []);
  const map = new Map<number, string>();
  if (Array.isArray(items)) for (const item of items.filter(isRecord)) if (num(item.id) !== null && typeof item.title === "string") map.set(item.id as number, str(item.title)!);
  return map;
}

export async function readBlocklist(ctx: Ctx, service: ArrService, withTitles = true): Promise<BlocklistEntry[]> {
  const { base, headers } = arrAccess(ctx, service);
  const [raw, titles] = await Promise.all([
    getJson<{ records?: unknown }>(ctx, `${base}/api/v3/blocklist?page=1&pageSize=${MAX_RECORDS}&sortKey=date&sortDirection=descending`, { headers, timeoutMs: 30_000 }),
    withTitles ? titlesOf(ctx, service) : Promise.resolve(new Map<number, string>()),
  ]);
  const records = isRecord(raw) && Array.isArray(raw.records) ? raw.records : [];
  return records
    .filter(isRecord)
    .filter((r) => num(r.id) !== null)
    .map((r) => {
      const mediaId = num(service === "radarr" ? r.movieId : r.seriesId);
      return {
        id: r.id as number,
        date: str(r.date),
        release: str(r.sourceTitle, 300),
        title: mediaId !== null ? titles.get(mediaId) ?? null : null,
        mediaId,
        quality: qualityName(r.quality),
        languages: names(r.languages),
        indexer: str(r.indexer),
        protocol: str(r.protocol),
        message: str(r.message, 300),
      };
    });
}

const parseService = (value: unknown): ArrService => {
  if (value !== "radarr" && value !== "sonarr") throw new WriteError("invalid_input", "service deve essere radarr o sonarr");
  return value;
};

/** Lettura per lo strumento `get_blocklist`: tutte le voci o solo quelle di un titolo / di un id. */
export async function listBlocklist(ctx: Ctx, args: Record<string, unknown>) {
  const service = parseService(args.service);
  const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 50;
  let entries = await readBlocklist(ctx, service);
  if (num(args.mediaId) !== null) entries = entries.filter((e) => e.mediaId === args.mediaId);
  if (typeof args.query === "string" && args.query.trim().length >= 2) {
    const words = normalize(args.query).split(" ").filter(Boolean);
    entries = entries.filter((e) => {
      const text = normalize(`${e.title ?? ""} ${e.release ?? ""}`);
      return words.every((word) => text.includes(word));
    });
  }
  return clean({
    service,
    total: entries.length,
    entries: entries.slice(0, limit),
    hint: "Per togliere voci: propose_arr_blocklist_remove con service e gli id. Per bloccare un download in coda: propose_arr_blocklist_add.",
  });
}

// --- Togliere dalla blocklist -----------------------------------------------------------------------------------

const describe = (e: BlocklistEntry) => `#${e.id} ${e.title ? `${e.title}: ` : ""}${e.release ?? "?"}`.slice(0, 300);

export const arrBlocklistRemove: ActionDef = {
  name: "arr_blocklist_remove",
  services: ["radarr", "sonarr"],
  description:
    `Radarr/Sonarr: toglie voci dalla blocklist (al massimo ${MAX_REMOVE} per volta), così quelle uscite tornano scaricabili. Gli id si leggono con get_blocklist. ` +
    "Non avvia ricerche: dopo l'applicazione Radarr/Sonarr possono riprenderle alla prossima ricerca.",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string", enum: ["radarr", "sonarr"] },
      ids: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: MAX_REMOVE },
    },
    required: ["service", "ids"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input)) throw new WriteError("invalid_input", "Input non valido");
    const extra = Object.keys(input).filter((k) => k !== "service" && k !== "ids");
    if (extra.length) throw new WriteError("invalid_input", `Campi non ammessi: ${extra.join(", ")}`);
    const service = parseService(input.service);
    const ids = input.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_REMOVE || !ids.every((id) => Number.isInteger(id) && (id as number) >= 1 && (id as number) <= 100_000_000)) {
      throw new WriteError("invalid_input", `ids deve essere un elenco di 1-${MAX_REMOVE} interi positivi`);
    }
    return { service, ids: [...new Set(ids as number[])].sort((a, b) => a - b) };
  },
  async plan(ctx, input) {
    const service = input.service as ArrService;
    const ids = input.ids as number[];
    const entries = await readBlocklist(ctx, service);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new WriteError("not_found", `Non in blocklist: ${missing.join(", ")}`);
    const changes: PlanChange[] = ids.map((id) => ({ target: `${service} blocklist`, field: clean(describe(byId.get(id)!)), from: "in blocklist", to: "rimossa" }));
    return { summary: `${service}: togli ${ids.length} ${ids.length === 1 ? "voce" : "voci"} dalla blocklist`, changes, undo: null };
  },
  async stillValid(ctx, input) {
    const present = new Set((await readBlocklist(ctx, input.service as ArrService, false)).map((e) => e.id));
    return (input.ids as number[]).every((id) => present.has(id));
  },
  async apply(ctx, input) {
    const service = input.service as ArrService;
    const ids = input.ids as number[];
    const { base, headers } = arrAccess(ctx, service);
    await request(ctx, `${base}/api/v3/blocklist/bulk`, {
      method: "DELETE",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const still = new Set((await readBlocklist(ctx, service, false)).map((e) => e.id));
    const left = ids.filter((id) => still.has(id));
    if (left.length) throw new Error(`Verifica fallita: ancora in blocklist ${left.join(", ")}`);
    return `Applicato e verificato: tolte dalla blocklist di ${service} le voci ${ids.join(", ")}`;
  },
};

// --- Mettere in blocklist un download in coda ------------------------------------------------------------------

interface QueueEntry {
  id: number;
  release: string;
  title: string | null;
  mediaId: number | null;
  episode: string | null;
  status: string | null;
}

async function readQueue(ctx: Ctx, service: ArrService): Promise<QueueEntry[]> {
  const { base, headers } = arrAccess(ctx, service);
  const extra = service === "radarr" ? "includeMovie=true" : "includeSeries=true&includeEpisode=true";
  const raw = await getJson<{ records?: unknown }>(ctx, `${base}/api/v3/queue?page=1&pageSize=500&${extra}`, { headers, timeoutMs: 30_000 });
  const records = isRecord(raw) && Array.isArray(raw.records) ? raw.records : [];
  return records
    .filter(isRecord)
    .filter((r) => num(r.id) !== null && typeof r.title === "string")
    .map((r) => {
      const media = isRecord(r.movie) ? r.movie : isRecord(r.series) ? r.series : null;
      const ep = isRecord(r.episode) ? `S${String(r.episode.seasonNumber).padStart(2, "0")}E${String(r.episode.episodeNumber).padStart(2, "0")}` : null;
      return {
        id: r.id as number,
        release: str(r.title, 300)!,
        title: media ? str(media.title) : null,
        mediaId: num(service === "radarr" ? r.movieId : r.seriesId),
        episode: ep,
        status: str(r.status),
      };
    });
}

export const arrBlocklistAdd: ActionDef = {
  name: "arr_blocklist_add",
  services: ["radarr", "sonarr"],
  description:
    "Radarr/Sonarr: mette in blocklist un download che è IN CODA (queueId dalla coda di diagnose_movie o diagnose_series), così quell'uscita non verrà più ripresa, lo toglie dalla coda e fa cercare un'alternativa. " +
    "removeFromClient (default true) cancella anche il torrent dal client; false lo lascia nel client (per esempio per continuare a seminare). " +
    "Non si possono bloccare uscite che non sono in coda.",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      service: { type: "string", enum: ["radarr", "sonarr"] },
      queueId: { type: "integer", minimum: 1 },
      removeFromClient: { type: "boolean" },
    },
    required: ["service", "queueId"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input)) throw new WriteError("invalid_input", "Input non valido");
    const extra = Object.keys(input).filter((k) => !["service", "queueId", "removeFromClient"].includes(k));
    if (extra.length) throw new WriteError("invalid_input", `Campi non ammessi: ${extra.join(", ")}`);
    const service = parseService(input.service);
    if (!Number.isInteger(input.queueId) || (input.queueId as number) < 1 || (input.queueId as number) > 2_000_000_000) throw new WriteError("invalid_input", "queueId deve essere un intero positivo");
    if (input.removeFromClient !== undefined && typeof input.removeFromClient !== "boolean") throw new WriteError("invalid_input", "removeFromClient deve essere true o false");
    return { service, queueId: input.queueId as number, removeFromClient: input.removeFromClient !== false };
  },
  async plan(ctx, input) {
    const service = input.service as ArrService;
    const item = (await readQueue(ctx, service)).find((q) => q.id === input.queueId);
    if (!item) throw new WriteError("not_found", `Elemento ${String(input.queueId)} non presente nella coda di ${service}`);
    const label = clean(`${item.title ?? "?"}${item.episode ? ` ${item.episode}` : ""}: ${item.release}`);
    return {
      summary: `${service}: metti in blocklist "${clean(item.release)}"${input.removeFromClient ? " e cancellalo dal client" : " (resta nel client)"}`,
      changes: [
        { target: `${service} coda`, field: label, from: "in coda", to: input.removeFromClient ? "in blocklist, tolto da coda e client, nuova ricerca" : "in blocklist, tolto dalla coda (resta nel client), nuova ricerca" },
      ],
      undo: null,
    };
  },
  async stillValid(ctx, input, changes) {
    const item = (await readQueue(ctx, input.service as ArrService)).find((q) => q.id === input.queueId);
    return !!item && changes.length === 1 && changes[0]!.field.endsWith(clean(item.release));
  },
  async apply(ctx, input) {
    const service = input.service as ArrService;
    const before = (await readQueue(ctx, service)).find((q) => q.id === input.queueId);
    if (!before) throw new Error("Elemento non più in coda");
    const { base, headers } = arrAccess(ctx, service);
    const params = new URLSearchParams({ removeFromClient: String(input.removeFromClient), blocklist: "true", skipRedownload: "false" });
    await request(ctx, `${base}/api/v3/queue/${input.queueId as number}?${params}`, { method: "DELETE", headers });
    const stillQueued = (await readQueue(ctx, service)).some((q) => q.id === input.queueId);
    const blocked = (await readBlocklist(ctx, service, false)).some((e) => e.release === before.release && (before.mediaId === null || e.mediaId === before.mediaId));
    if (stillQueued || !blocked) throw new Error("Verifica fallita: il download non risulta in blocklist o è ancora in coda");
    return `Applicato e verificato: "${clean(before.release)}" è in blocklist di ${service} e non è più in coda`;
  },
};

export const BLOCKLIST_ACTIONS: ActionDef[] = [arrBlocklistRemove, arrBlocklistAdd];
