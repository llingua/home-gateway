import { NotConfigured, UpstreamError } from "./errors";
import { scrubSecrets } from "./scrub";
import { fetchDiskSpace, fetchHealth, fetchQueue, fetchUpcoming, fetchWantedCount, type ArrService } from "./services/arr";
import {
  fetchArrIndexers, fetchArrTags, fetchArrVersion, fetchCustomFormats, fetchDelayProfiles, fetchDownloadClients,
  fetchMediaManagement, fetchNaming, fetchQualityProfiles, fetchRootFolders,
} from "./services/arr-config";
import { fetchDownloads, fetchQbtConfig } from "./services/qbittorrent";
import { fetchSubtitles } from "./services/bazarr";
import { fetchLastAvailable, fetchRequests } from "./services/overseerr";
import { fetchLibraries, fetchStreams } from "./services/plex";
import { fetchIndexers, fetchProwlarrConfig } from "./services/prowlarr";
import { fetchProxmox } from "./services/proxmox";
import { fetchBazarrLanguages, fetchBazarrProfiles, fetchBazarrSettings, fetchBazarrVersion } from "./services/bazarr-config";
import { fetchOverseerrArr, fetchOverseerrConnections, fetchOverseerrJobs, fetchOverseerrMain, fetchOverseerrPlex, fetchOverseerrVersion } from "./services/overseerr-config";
import { fetchPlexLibraries, fetchPlexPreferences, fetchPlexServer } from "./services/plex-config";
import { fetchProxmoxBackups, fetchProxmoxDisks, fetchProxmoxGuests, fetchProxmoxNode, fetchProxmoxStorages } from "./services/proxmox-config";
import {
  fetchCleanuparrArr, fetchCleanuparrDownloadCleaner, fetchCleanuparrDownloadClients, fetchCleanuparrGeneral,
  fetchCleanuparrMalwareBlocker, fetchCleanuparrQueueCleaner, fetchCleanuparrSlowRules, fetchCleanuparrStallRules,
} from "./services/cleanuparr";
import type { Ctx, SectionResult } from "./types";

/**
 * Le "capacità" del gateway. I clienti chiedono cosa vogliono sapere (streams, downloads, queue...),
 * non da quale servizio arriva: se domani cambia il servizio, cambia solo l'adapter.
 */

export type SectionGroup = "media" | "config";

export interface SectionDef {
  name: string;
  description: string;
  scope: string;
  /** "media" (default): dati di stato; "config": impostazioni dei servizi, con un permesso a parte. */
  group?: SectionGroup;
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
const CONFIG_SCOPE = "config:read";

/**
 * Sezione di configurazione (audit): permesso a parte e, qualunque cosa restituisca l'adapter,
 * una pulizia finale da chiavi, password e valori che ne hanno l'aspetto.
 */
function configSection(service: string, description: string, parts: (ctx: Ctx) => Record<string, () => Promise<unknown>>): SectionDef {
  return {
    name: `config_${service}`,
    description,
    scope: CONFIG_SCOPE,
    group: "config",
    ttl: 60,
    load: async (ctx) => {
      const result = await combine(parts(ctx));
      return result.data ? { ...result, data: scrubSecrets(result.data) } : result;
    },
  };
}

const arrConfigParts = (service: ArrService) => (ctx: Ctx) => ({
  version: () => fetchArrVersion(ctx, service),
  qualityProfiles: () => fetchQualityProfiles(ctx, service),
  customFormats: () => fetchCustomFormats(ctx, service),
  rootFolders: () => fetchRootFolders(ctx, service),
  downloadClients: () => fetchDownloadClients(ctx, service),
  indexers: () => fetchArrIndexers(ctx, service),
  mediaManagement: () => fetchMediaManagement(ctx, service),
  naming: () => fetchNaming(ctx, service),
  delayProfiles: () => fetchDelayProfiles(ctx, service),
  tags: () => fetchArrTags(ctx, service),
});

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
    name: "recent",
    description: "Ultimo film o serie reso disponibile (solo titolo).",
    scope: SCOPE,
    ttl: 300,
    load: (ctx) => single(async () => ({ lastAvailable: await fetchLastAvailable(ctx) })),
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
  {
    name: "subtitles",
    description: "Sottotitoli mancanti e problemi dei provider (Bazarr).",
    scope: SCOPE,
    ttl: 300,
    load: (ctx) => single(() => fetchSubtitles(ctx)),
  },
  {
    name: "proxmox",
    description: "Host Proxmox (CPU, RAM, uptime), guest, spazio degli storage e ultimo backup.",
    scope: SCOPE,
    ttl: 30,
    load: (ctx) => single(() => fetchProxmox(ctx)),
  },
  configSection("radarr", "Impostazioni di Radarr per l'audit: profili di qualità, formati personalizzati, cartelle, client di download, indexer, naming (senza chiavi né password).", arrConfigParts("radarr")),
  configSection("sonarr", "Impostazioni di Sonarr per l'audit: profili di qualità, formati personalizzati, cartelle, client di download, indexer, naming (senza chiavi né password).", arrConfigParts("sonarr")),
  configSection("prowlarr", "Impostazioni di Prowlarr per l'audit: indexer, applicazioni collegate, profili, client di download (senza chiavi né password).", (ctx) => ({
    prowlarr: () => fetchProwlarrConfig(ctx),
  })),
  configSection("qbittorrent", "Impostazioni di qBittorrent per l'audit: percorsi, code, limiti, rapporto di condivisione, categorie (senza credenziali, proxy né programmi da eseguire).", (ctx) => ({
    qbittorrent: () => fetchQbtConfig(ctx),
  })),
  configSection("bazarr", "Impostazioni di Bazarr per l'audit: opzioni di ricerca e aggiornamento dei sottotitoli, punteggi minimi, provider attivi (solo i nomi), profili lingua (senza chiavi, utenti né indirizzi).", (ctx) => ({
    version: () => fetchBazarrVersion(ctx),
    settings: () => fetchBazarrSettings(ctx),
    languageProfiles: () => fetchBazarrProfiles(ctx),
    enabledLanguages: () => fetchBazarrLanguages(ctx),
  })),
  configSection("overseerr", "Impostazioni di Overseerr per l'audit: opzioni generali, server Radarr/Sonarr collegati (profili, cartelle, disponibilità minima), librerie Plex sincronizzate, lavori pianificati (senza chiavi né indirizzi).", (ctx) => ({
    version: () => fetchOverseerrVersion(ctx),
    main: () => fetchOverseerrMain(ctx),
    radarr: () => fetchOverseerrArr(ctx, "radarr"),
    sonarr: () => fetchOverseerrArr(ctx, "sonarr"),
    plex: () => fetchOverseerrPlex(ctx),
    connections: () => fetchOverseerrConnections(ctx),
    jobs: () => fetchOverseerrJobs(ctx),
  })),
  configSection("plex", "Impostazioni di Plex per l'audit: trascodifica (cartella temporanea, limiti), aggiornamento e manutenzione delle librerie, librerie e cartelle (senza account, token né reti).", (ctx) => ({
    server: () => fetchPlexServer(ctx),
    preferences: () => fetchPlexPreferences(ctx),
    libraries: () => fetchPlexLibraries(ctx),
  })),
  configSection("proxmox", "Configurazione di Proxmox per l'audit, SOLO LETTURA (Proxmox non si modifica dal gateway): nodo, guest (risorse, avvio automatico, dischi), backup pianificati, storage, salute dei dischi (senza indirizzi, utenti né note).", (ctx) => ({
    node: () => fetchProxmoxNode(ctx),
    guests: () => fetchProxmoxGuests(ctx),
    backupJobs: () => fetchProxmoxBackups(ctx),
    storages: () => fetchProxmoxStorages(ctx),
    disks: () => fetchProxmoxDisks(ctx),
  })),
  configSection("cleanuparr", "Impostazioni di Cleanuparr per l'audit: pulizia della coda (regole di stallo, lentezza, importazioni fallite), blocco malware, pulizia dei download, opzioni generali (senza indirizzi, chiavi né password).", (ctx) => ({
    queueCleaner: () => fetchCleanuparrQueueCleaner(ctx),
    stallRules: () => fetchCleanuparrStallRules(ctx),
    slowRules: () => fetchCleanuparrSlowRules(ctx),
    malwareBlocker: () => fetchCleanuparrMalwareBlocker(ctx),
    downloadCleaner: () => fetchCleanuparrDownloadCleaner(ctx),
    general: () => fetchCleanuparrGeneral(ctx),
    downloadClients: () => fetchCleanuparrDownloadClients(ctx),
    sonarr: () => fetchCleanuparrArr(ctx, "sonarr"),
    radarr: () => fetchCleanuparrArr(ctx, "radarr"),
  })),
];

export const sectionGroup = (section: SectionDef): SectionGroup => section.group ?? "media";

export function findSection(name: string): SectionDef | undefined {
  return SECTIONS.find((section) => section.name === name);
}
