import { getJson } from "../upstream";
import { arrAccess, type ArrService } from "./arr";
import type { Ctx } from "../types";

/**
 * Impostazioni di Radarr e Sonarr per l'audit. Si scelgono SOLO campi noti e innocui:
 * gli oggetti `indexer` e `downloadclient` contengono un array `fields` con chiavi e password, che qui non entra mai.
 */

const GB = 1024 ** 3;

function pick(source: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source) return out;
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

const get = <T>(ctx: Ctx, service: ArrService, path: string) => {
  const { base, headers } = arrAccess(ctx, service);
  return getJson<T>(ctx, `${base}${path}`, { headers });
};

export async function fetchArrVersion(ctx: Ctx, service: ArrService): Promise<string | null> {
  return (await get<{ version?: string }>(ctx, service, "/api/v3/system/status")).version ?? null;
}

interface ProfileItem {
  id?: number;
  name?: string;
  allowed?: boolean;
  quality?: { id?: number; name?: string };
  items?: ProfileItem[];
}

interface QualityProfile {
  id?: number;
  name?: string;
  minUpgradeFormatScore?: number;
  formatItems?: Array<{ format?: number; name?: string; score?: number }>;
  cutoff?: number;
  upgradeAllowed?: boolean;
  minFormatScore?: number;
  cutoffFormatScore?: number;
  items?: ProfileItem[];
}

function cutoffName(items: ProfileItem[], cutoff: number | undefined): string | null {
  for (const item of items) {
    if (item.quality && item.quality.id === cutoff) return item.quality.name ?? null;
    if (!item.quality && item.id === cutoff) return item.name ?? null;
  }
  return null;
}

export async function fetchQualityProfiles(ctx: Ctx, service: ArrService) {
  const profiles = await get<QualityProfile[]>(ctx, service, "/api/v3/qualityprofile");
  return profiles.map((profile) => {
    const items = profile.items ?? [];
    return {
      id: profile.id ?? null,
      name: profile.name ?? "",
      upgradeAllowed: profile.upgradeAllowed ?? false,
      cutoff: cutoffName(items, profile.cutoff),
      allowed: items.filter((item) => item.allowed).map((item) => item.quality?.name ?? item.name ?? ""),
      minFormatScore: profile.minFormatScore ?? null,
      cutoffFormatScore: profile.cutoffFormatScore ?? null,
      minUpgradeFormatScore: profile.minUpgradeFormatScore ?? null,
      // Formati personalizzati del profilo con il loro punteggio (id del formato = chiave per arr_quality_profile).
      formatScores: (profile.formatItems ?? []).map((item) => ({ id: item.format ?? null, name: item.name ?? "", score: item.score ?? 0 })),
    };
  });
}

export async function fetchCustomFormats(ctx: Ctx, service: ArrService): Promise<string[]> {
  return (await get<Array<{ name?: string }>>(ctx, service, "/api/v3/customformat")).map((format) => format.name ?? "");
}

export async function fetchRootFolders(ctx: Ctx, service: ArrService) {
  const folders = await get<Array<{ path?: string; freeSpace?: number }>>(ctx, service, "/api/v3/rootfolder");
  return folders.map((folder) => ({ path: folder.path ?? "", freeGb: Math.round(((folder.freeSpace ?? 0) / GB) * 10) / 10 }));
}

export async function fetchDownloadClients(ctx: Ctx, service: ArrService) {
  const clients = await get<Array<Record<string, unknown>>>(ctx, service, "/api/v3/downloadclient");
  return clients.map((client) => pick(client, ["id", "name", "implementation", "protocol", "enable", "priority", "removeCompletedDownloads", "removeFailedDownloads"]));
}

export async function fetchArrIndexers(ctx: Ctx, service: ArrService) {
  const indexers = await get<Array<Record<string, unknown>>>(ctx, service, "/api/v3/indexer");
  return indexers.map((indexer) =>
    pick(indexer, ["id", "name", "implementation", "protocol", "enableRss", "enableAutomaticSearch", "enableInteractiveSearch", "priority", "downloadClientId"]),
  );
}

const MEDIA_MANAGEMENT_KEYS = [
  "copyUsingHardlinks", "deleteEmptyFolders", "importExtraFiles", "extraFileExtensions", "recycleBinCleanupDays",
  "downloadPropersAndRepacks", "skipFreeSpaceCheckWhenImporting", "minimumFreeSpaceWhenImporting",
  "autoRenameFolders", "watchLibraryForChanges", "rescanAfterRefresh", "fileDate", "setPermissionsLinux",
  "autoUnmonitorPreviouslyDownloadedEpisodes", "autoUnmonitorPreviouslyDownloadedMovies",
  "createEmptyMovieFolders", "episodeTitleRequired",
] as const;

export async function fetchMediaManagement(ctx: Ctx, service: ArrService) {
  const config = await get<Record<string, unknown>>(ctx, service, "/api/v3/config/mediamanagement");
  // Del cestino si dice solo se è attivo, non dove sta.
  return { ...pick(config, MEDIA_MANAGEMENT_KEYS), recycleBinEnabled: typeof config.recycleBin === "string" && config.recycleBin !== "" };
}

const NAMING_KEYS = [
  "renameMovies", "renameEpisodes", "replaceIllegalCharacters", "colonReplacementFormat", "multiEpisodeStyle",
  "standardMovieFormat", "movieFolderFormat", "standardEpisodeFormat", "dailyEpisodeFormat", "animeEpisodeFormat",
  "seriesFolderFormat", "seasonFolderFormat", "specialsFolderFormat",
] as const;

export async function fetchNaming(ctx: Ctx, service: ArrService) {
  return pick(await get<Record<string, unknown>>(ctx, service, "/api/v3/config/naming"), NAMING_KEYS);
}

export async function fetchDelayProfiles(ctx: Ctx, service: ArrService) {
  const profiles = await get<Array<Record<string, unknown>>>(ctx, service, "/api/v3/delayprofile");
  return profiles.map((profile) => pick(profile, ["id", "enableUsenet", "enableTorrent", "preferredProtocol", "usenetDelay", "torrentDelay", "bypassIfHighestQuality", "bypassIfAboveCustomFormatScore", "minimumCustomFormatScore", "order"]));
}

export async function fetchArrTags(ctx: Ctx, service: ArrService): Promise<string[]> {
  return (await get<Array<{ label?: string }>>(ctx, service, "/api/v3/tag")).map((tag) => tag.label ?? "");
}
