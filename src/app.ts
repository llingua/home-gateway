import { authenticate, hasScope } from "./auth";
import { HttpError } from "./errors";
import { loadSection as loadSectionWith } from "./load";
import { handleMcp } from "./mcp";
import { findSection, SECTIONS, type SectionDef } from "./sections";
import type { CacheLike, Client, Env, Fetcher, SectionResult } from "./types";

export interface AppDeps {
  fetch: Fetcher;
  cache?: CacheLike;
  /** Secondi Unix; sostituibile nei test. */
  now?: number;
}

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

function errorResponse(error: HttpError): Response {
  return json({ error: { code: error.code, message: error.message } }, error.status);
}

function loadSection(section: SectionDef, env: Env, deps: AppDeps): Promise<SectionResult> {
  return loadSectionWith(section, env, deps);
}

function requireScope(client: Client, section: SectionDef): void {
  if (!hasScope(client, section.scope)) {
    throw new HttpError(403, "forbidden", `Permesso mancante: ${section.scope}`);
  }
}

export async function handle(request: Request, env: Env, deps: AppDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // L'unica risposta senza autenticazione: serve solo a sapere che il Worker è vivo.
    if (path === "/healthz") return json({ ok: true, service: "home-gateway" });

    // L'MCP usa POST; tutto il resto dell'API è in sola lettura (GET).
    if (request.method !== "GET" && path !== "/mcp") {
      throw new HttpError(405, "method_not_allowed", "Sono ammesse solo richieste GET");
    }

    const client = await authenticate(request, env, { fetch: deps.fetch, now: deps.now });

    if (path === "/mcp") {
      return handleMcp(request, client, { env, fetch: deps.fetch, cache: deps.cache, now: deps.now });
    }

    if (path === "/v1/capabilities") {
      return json({
        client: client.name,
        sections: SECTIONS.map(({ name, description, scope, ttl }) => ({
          name,
          description,
          scope,
          cacheSeconds: ttl,
          allowed: hasScope(client, scope),
          path: `/v1/media/${name}`,
        })),
      });
    }

    if (path === "/v1/media/overview") {
      const requested = url.searchParams.get("sections");
      const names = requested ? requested.split(",").map((name) => name.trim()).filter(Boolean) : SECTIONS.map((section) => section.name);

      const selected = names.map((name) => {
        const section = findSection(name);
        if (!section) throw new HttpError(400, "unknown_section", `Sezione sconosciuta: ${name}`);
        requireScope(client, section);
        return section;
      });

      const results = await Promise.all(selected.map((section) => loadSection(section, env, deps)));
      const sections: Record<string, SectionResult> = {};
      selected.forEach((section, index) => {
        sections[section.name] = results[index]!;
      });
      return json({ generatedAt: new Date((deps.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(), sections });
    }

    const single = /^\/v1\/media\/([a-z]+)$/.exec(path);
    if (single) {
      const section = findSection(single[1]!);
      if (!section) throw new HttpError(404, "not_found", "Sezione non trovata");
      requireScope(client, section);
      return json(await loadSection(section, env, deps));
    }

    throw new HttpError(404, "not_found", "Risorsa non trovata");
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(error);
    }
    // Nessun dettaglio al cliente: nei log resta solo il tipo di errore.
    console.error("errore interno", error instanceof Error ? error.name : typeof error);
    return json({ error: { code: "internal", message: "Errore interno" } }, 500);
  }
}
