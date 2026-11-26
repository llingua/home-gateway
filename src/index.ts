import { handle } from "./app";
import type { CacheLike, Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cache = typeof caches !== "undefined" ? ((caches as unknown as { default: CacheLike }).default) : undefined;
    return handle(request, env, {
      fetch: (input, init) => fetch(input, init),
      cache,
    });
  },
} satisfies ExportedHandler<Env>;
