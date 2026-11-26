import { SECTIONS } from "./sections";
import type { CacheLike, SectionResult } from "./types";

const cacheRequest = (key: string) => new Request(`https://home-gateway.cache/v1/${encodeURIComponent(key)}`);

/**
 * Cache per sezione, nella Cache API di Cloudflare. Si salvano solo i risultati "ok":
 * un errore passeggero non deve restare in cache.
 */
export async function withCache<T>(
  cache: CacheLike | undefined,
  key: string,
  ttlSeconds: number,
  load: () => Promise<SectionResult<T>>,
): Promise<SectionResult<T>> {
  if (!cache || ttlSeconds <= 0) return load();

  const cacheKey = cacheRequest(key);

  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const stored = (await hit.json()) as SectionResult<T>;
      return { ...stored, cached: true };
    }
  } catch {
    // Una cache che non risponde non deve bloccare la richiesta.
  }

  const result = await load();

  if (result.status === "ok") {
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlSeconds}` },
        }),
      );
    } catch {
      // Idem: se non si riesce a salvare, si risponde comunque.
    }
  }
  return result;
}

/**
 * Svuota la cache di tutte le sezioni (di questa sede Cloudflare): dopo una modifica applicata la lettura successiva deve vedere il valore nuovo.
 * Non solleva mai errori: una cache che non risponde non deve far fallire una modifica già fatta.
 */
export async function invalidateAllSections(cache: CacheLike | undefined): Promise<void> {
  if (!cache) return;
  await Promise.all(
    SECTIONS.map(async (section) => {
      try {
        await cache.delete(cacheRequest(section.name));
      } catch {
        /* ignorato */
      }
    }),
  );
}
