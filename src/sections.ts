import { NotConfigured, UpstreamError } from "./errors";
import { fetchDiskSpace, fetchHealth, fetchQueue, fetchUpcoming, fetchWantedCount } from "./services/arr";
import { fetchDownloads } from "./services/qbittorrent";
import { fetchRequests } from "./services/overseerr";
import { fetchLibraries, fetchStreams } from "./services/plex";
import { fetchIndexers } from "./services/prowlarr";
import type { Ctx, SectionResult } from "./types";

/**
 * Le "capacità" del gateway. I clienti chiedono cosa vogliono sapere (streams, downloads, queue...),
 * non da quale servizio arriva: se domani cambia il servizio, cambia solo l'adapter.
 */

export interface SectionDef {
  name: string;
  description: string;
  scope: string;
  /** Secondi di cache. */
  ttl: number;
  load: (ctx: Ctx) => Promise<SectionResult>;
}

function failure(error: unknown): SectionResult {
  if (error instanceof NotConfigured) return { status: "unconfigured", error: error.message };
  if (error instanceof UpstreamError) return { status: "error", error: error.message };
  return { status: "error", error: "Errore interno" };
}

/** Sezione che dipende da un solo servizio. */
async function single<T>(load: () => Promise<T>): Promise<SectionResult> {
  try {
    return { status: "ok", data: await load() };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Sezione che unisce più servizi: se almeno uno risponde, la sezione è "ok" con i dati disponibili
 * (gli altri a null) e un elenco di avvisi. Se nessuno risponde, restituisce il problema.
 */
async function combine(parts: Record<string, () => Promise<unknown>>): Promise<SectionResult> {
  const entries = Object.entries(parts);
  const settled = await Promise.allSettled(entries.map(([, load]) => load()));

  const data: Record<string, unknown> = {};
  const warnings: string[] = [];
  const failures: SectionResult[] = [];

  settled.forEach((outcome, index) => {
    const key = entries[index]![0];
    if (outcome.status === "fulfilled") {
      data[key] = outcome.value;
      return;
    }
    data[key] = null;
    const result = failure(outcome.reason);
    failures.push(result);
    if (result.status === "error") warnings.push(`${key}: ${result.error}`);
  });

  if (failures.length === entries.length) {
    const firstError = failures.find((item) => item.status === "error");
    return firstError ?? { status: "unconfigured", error: "Nessun servizio configurato" };
  }
  return { status: "ok", data, ...(warnings.length ? { warnings } : {}) };
}

const SCOPE = "media:read";

export const SECTIONS: SectionDef[] = [
  {
    name: "streams",
    description: "Riproduzioni Plex in corso (senza utenti né indirizzi).",
    scope: SCOPE,
    ttl: 15,
    load: (ctx) => single(() => fetchStreams(ctx)),
  },
  {
    name: "downloads",
    description: "Velocità e stato dei torrent (qBittorrent).",
    scope: SCOPE,
    ttl: 15,
    load: (ctx) => single(() => fetchDownloads(ctx)),
  },
  {
    name: "requests",
    description: "Richieste e problemi aperti su Overseerr (solo contatori).",
    scope: SCOPE,
    ttl: 60,
    load: (ctx) => single(() => fetchRequests(ctx)),
  },
  {
    name: "queue",
    description: "Code di download di Radarr (film) e Sonarr (episodi).",
    scope: SCOPE,
    ttl: 30,
    load: (ctx) =>
      combine({
        movies: () => fetchQueue(ctx, "radarr"),
        episodes: () => fetchQueue(ctx, "sonarr"),
      }),
  },
  {
    name: "upcoming",
    description: "Prossime uscite nei prossimi 30 giorni (film e episodi).",
    scope: SCOPE,
    ttl: 600,
    load: (ctx) =>
      combine({
        movies: () => fetchUpcoming(ctx, "radarr"),
        episodes: () => fetchUpcoming(ctx, "sonarr"),
      }),
  },
  {
    name: "library",
    description: "Elementi nelle librerie Plex e contenuti ricercati ma non ancora trovati.",
    scope: SCOPE,
    ttl: 600,
    load: (ctx) =>
      combine({
        plex: () => fetchLibraries(ctx),
        wantedMovies: () => fetchWantedCount(ctx, "radarr"),
        wantedEpisodes: () => fetchWantedCount(ctx, "sonarr"),
      }),
  },
  {
    name: "storage",
    description: "Spazio libero sui volumi visti da Radarr e Sonarr.",
    scope: SCOPE,
    ttl: 300,
    load: (ctx) =>
      combine({
        radarr: () => fetchDiskSpace(ctx, "radarr"),
        sonarr: () => fetchDiskSpace(ctx, "sonarr"),
      }),
  },
  {
    name: "health",
    description: "Avvisi di salute segnalati da Radarr e Sonarr.",
    scope: SCOPE,
    ttl: 120,
    load: (ctx) =>
      combine({
        radarr: () => fetchHealth(ctx, "radarr"),
        sonarr: () => fetchHealth(ctx, "sonarr"),
      }),
  },
  {
    name: "indexers",
    description: "Indexer di Prowlarr: quanti, quanti non attivi, avvisi di salute.",
    scope: SCOPE,
    ttl: 120,
    load: (ctx) => single(() => fetchIndexers(ctx)),
  },
];

export function findSection(name: string): SectionDef | undefined {
  return SECTIONS.find((section) => section.name === name);
}
