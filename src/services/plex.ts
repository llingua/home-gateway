import { getJson, baseUrl, requireSecret } from "../upstream";
import type { Ctx } from "../types";

function plexAccess(ctx: Ctx): { base: string; headers: Record<string, string> } {
  const token = requireSecret(ctx.env.PLEX_TOKEN, "plex");
  return { base: baseUrl(ctx.env, "plex"), headers: { "X-Plex-Token": token } };
}

interface PlexSession {
  type?: string;
  title?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  viewOffset?: number;
  duration?: number;
  Player?: { title?: string; state?: string };
}

export interface Stream {
  title: string;
  subtitle: string | null;
  type: string;
  state: string;
  device: string | null;
  /** 0-100, null se non nota. */
  progress: number | null;
}

export interface StreamsSummary {
  count: number;
  streams: Stream[];
}

const pad = (n: number | undefined) => String(n ?? 0).padStart(2, "0");

/**
 * Sessioni Plex in corso. Di proposito NON si espongono utente, indirizzo IP né account:
 * solo ciò che serve a una dashboard.
 */
export async function fetchStreams(ctx: Ctx): Promise<StreamsSummary> {
  const { base, headers } = plexAccess(ctx);
  const data = await getJson<{ MediaContainer?: { size?: number; Metadata?: PlexSession[] } }>(
    ctx,
    `${base}/status/sessions`,
    { headers },
  );
  const sessions = data.MediaContainer?.Metadata ?? [];
  return {
    count: data.MediaContainer?.size ?? sessions.length,
    streams: sessions.map((session) => {
      const isEpisode = session.type === "episode";
      return {
        title: (isEpisode ? session.grandparentTitle : session.title) ?? session.title ?? "Sconosciuto",
        subtitle: isEpisode ? `S${pad(session.parentIndex)}E${pad(session.index)} ${session.title ?? ""}`.trim() : null,
        type: session.type ?? "unknown",
        state: session.Player?.state ?? "unknown",
        device: session.Player?.title ?? null,
        progress:
          session.duration && session.duration > 0 && session.viewOffset !== undefined
            ? Math.min(100, Math.round((session.viewOffset / session.duration) * 100))
            : null,
      };
    }),
  };
}

export interface LibraryCount {
  name: string;
  type: string;
  count: number;
}

export async function fetchLibraries(ctx: Ctx, maxSections = 10): Promise<LibraryCount[]> {
  const { base, headers } = plexAccess(ctx);
  const sections = await getJson<{ MediaContainer?: { Directory?: Array<{ key?: string; title?: string; type?: string }> } }>(
    ctx,
    `${base}/library/sections`,
    { headers },
  );
  const directories = (sections.MediaContainer?.Directory ?? []).slice(0, maxSections);

  const counts = await Promise.all(
    directories.map(async (directory) => {
      const data = await getJson<{ MediaContainer?: { totalSize?: number; size?: number } }>(
        ctx,
        `${base}/library/sections/${encodeURIComponent(directory.key ?? "")}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`,
        { headers },
      );
      return {
        name: directory.title ?? "Sconosciuta",
        type: directory.type ?? "unknown",
        count: data.MediaContainer?.totalSize ?? data.MediaContainer?.size ?? 0,
      };
    }),
  );
  return counts;
}
