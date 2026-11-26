import type { CacheLike, SectionResult } from "./types";

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

  const cacheKey = new Request(`https://home-gateway.cache/v1/${encodeURIComponent(key)}`);

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
