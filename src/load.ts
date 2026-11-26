import { withCache } from "./cache";
import type { SectionDef } from "./sections";
import type { CacheLike, Env, Fetcher, SectionResult } from "./types";

export interface LoadDeps {
  fetch: Fetcher;
  cache?: CacheLike;
}

export async function loadSection(section: SectionDef, env: Env, deps: LoadDeps): Promise<SectionResult> {
  const ctx = { env, fetch: deps.fetch };
  return withCache(deps.cache, section.name, section.ttl, () => section.load(ctx));
}
