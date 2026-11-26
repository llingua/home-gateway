import { baseUrl, getJson, requireSecret } from "../upstream";
import type { Ctx } from "../types";
import { isRecord, list, pickSimple } from "./config-common";

/**
 * Impostazioni di Plex per l'audit. Le preferenze del server contengono account, token e reti: si leggono SOLO quelle
 * elencate per nome (trascodifica, aggiornamento delle librerie, manutenzione) e solo se il valore è un numero, un vero/falso o un testo breve.
 */

const get = (ctx: Ctx, path: string) =>
  getJson<{ MediaContainer?: Record<string, unknown> }>(ctx, `${baseUrl(ctx.env, "plex")}${path}`, {
    headers: { "X-Plex-Token": requireSecret(ctx.env.PLEX_TOKEN, "plex"), Accept: "application/json" },
  });

const PREF_IDS = [
  "TranscoderTempDirectory", "TranscoderQuality", "TranscoderThrottleBuffer", "TranscoderH264BackgroundPreset", "TranscodeCountLimit",
  "HardwareAcceleratedCodecs", "HardwareAcceleratedEncoders", "TranscoderCanOnlyDownscale",
  "ScheduledLibraryUpdatesEnabled", "ScheduledLibraryUpdateInterval", "FSEventLibraryUpdatesEnabled", "FSEventLibraryPartialScanEnabled",
  "GenerateBIFBehavior", "GenerateIntroMarkerBehavior", "GenerateCreditsMarkerBehavior", "GenerateChapterThumbBehavior", "LoudnessAnalysisBehavior",
  "autoEmptyTrash", "allowMediaDeletion", "OnDeckWindow",
  "ButlerStartHour", "ButlerEndHour", "ButlerTaskBackupDatabase", "ButlerTaskOptimizeDatabase", "ButlerTaskCleanOldBundles", "ButlerTaskCleanOldCacheFiles",
  "ButlerTaskRefreshLocalMedia", "ButlerTaskRefreshLibraries", "ButlerTaskUpgradeMediaAnalysis", "ButlerTaskRefreshPeriodicMetadata",
  "ButlerTaskDeepMediaAnalysis", "ButlerTaskGenerateAutoTags", "ButlerTaskGenerateMediaIndexFiles",
  "WanTotalMaxUploadRate", "WanPerStreamMaxUploadRate", "RelayEnabled", "DlnaEnabled", "GdmEnabled", "secureConnections",
] as const;

export async function fetchPlexPreferences(ctx: Ctx) {
  const settings = list((await get(ctx, "/:/prefs")).MediaContainer?.Setting, 500);
  const wanted = new Set<string>(PREF_IDS);
  const out: Record<string, string | number | boolean> = {};
  for (const setting of settings) {
    if (!isRecord(setting) || typeof setting.id !== "string" || !wanted.has(setting.id)) continue;
    const value = setting.value;
    if (typeof value === "number" || typeof value === "boolean") out[setting.id] = value;
    else if (typeof value === "string") out[setting.id] = value.slice(0, 200);
  }
  return out;
}

/** Librerie: nome, tipo, agente, scanner, lingua e cartelle (i percorsi dei media sono ammessi nelle sezioni di configurazione). */
export async function fetchPlexLibraries(ctx: Ctx) {
  return list((await get(ctx, "/library/sections")).MediaContainer?.Directory, 50).map((library) => {
    const l = isRecord(library) ? library : {};
    return {
      ...pickSimple(l, ["key", "title", "type", "agent", "scanner", "language", "refreshing"]),
      locations: list(l.Location, 20).map((location) => (isRecord(location) && typeof location.path === "string" ? location.path.slice(0, 200) : null)).filter((p) => p !== null),
    };
  });
}

/** Versione e funzioni del server (niente nome, account né identificativi). */
export async function fetchPlexServer(ctx: Ctx) {
  const container = (await get(ctx, "/")).MediaContainer;
  const picked = pickSimple(container, ["version", "platform", "platformVersion", "transcoderVideo", "transcoderAudio", "allowMediaDeletion", "multiuser", "myPlexSubscription"]);
  // Il nome originale contiene "Session", che la pulizia finale toglie (di norma sono token): si rinomina.
  const active = isRecord(container) ? container.transcoderActiveVideoSessions : undefined;
  return typeof active === "number" ? { ...picked, activeTranscodes: active } : picked;
}
