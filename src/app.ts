import { handleApproval } from "./approval";
import { authenticate, hasScope } from "./auth";
import { HttpError } from "./errors";
import { loadSection as loadSectionWith } from "./load";
import { handleMcp } from "./mcp";
import { findSection, sectionGroup, SECTIONS, type SectionDef, type SectionGroup } from "./sections";
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

    // Pagina di approvazione delle modifiche: ha una sua autenticazione (persona, non token di servizio).
    if (path.startsWith("/approve/")) return handleApproval(request, env, { fetch: deps.fetch, now: deps.now });

    // L'MCP usa POST; tutto il resto dell'API è in sola lettura (GET).
    if (request.method !== "GET" && path !== "/mcp") {
      throw new HttpError(405, "method_not_allowed", "Sono ammesse solo richieste GET");
    }

    const client = await authenticate(request, env, { fetch: deps.fetch, now: deps.now });

    if (path === "/mcp") {
      return handleMcp(request, client, { env, fetch: deps.fetch, cache: deps.cache, now: deps.now });
    }

    const sectionPath = (section: SectionDef) =>
      sectionGroup(section) === "config" ? `/v1/config/${section.name.replace(/^config_/, "")}` : `/v1/media/${section.name}`;

    if (path === "/v1/capabilities") {
      return json({
        client: client.name,
        sections: SECTIONS.map((section) => ({
          name: section.name,
          group: sectionGroup(section),
          description: section.description,
          scope: section.scope,
          cacheSeconds: section.ttl,
          allowed: hasScope(client, section.scope),
          path: sectionPath(section),
        })),
      });
    }

    // Panoramica di un gruppo: senza `?sections=` restituisce SOLO le sezioni di quel gruppo consentite al cliente
    // (così un cliente con il solo permesso media non riceve un 403 perché esistono sezioni di configurazione).
    // Con `?sections=` si chiedono sezioni precise (di qualsiasi gruppo): se una non è consentita, 403.
    const overviewGroup: SectionGroup | null = path === "/v1/media/overview" ? "media" : path === "/v1/config/overview" ? "config" : null;
    if (overviewGroup) {
      const requested = url.searchParams.get("sections");
      let selected: SectionDef[];
      if (requested) {
        selected = requested
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name) => {
            const section = findSection(name);
            if (!section) throw new HttpError(400, "unknown_section", `Sezione sconosciuta: ${name}`);
            requireScope(client, section);
            return section;
          });
      } else {
        selected = SECTIONS.filter((section) => sectionGroup(section) === overviewGroup);
        if (overviewGroup === "config") {
          // La panoramica di configurazione è tutta o niente: senza permesso è un 403, non un elenco vuoto.
          selected.forEach((section) => requireScope(client, section));
        } else {
          selected = selected.filter((section) => hasScope(client, section.scope));
        }
      }

      const results = await Promise.all(selected.map((section) => loadSection(section, env, deps)));
      const sections: Record<string, SectionResult> = {};
      selected.forEach((section, index) => {
        sections[section.name] = results[index]!;
      });
      return json({ generatedAt: new Date((deps.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(), sections });
    }

    const single = /^\/v1\/(media|config)\/([a-z_]+)$/.exec(path);
    if (single) {
      const group = single[1] as SectionGroup;
      const section = findSection(group === "config" ? `config_${single[2]}` : single[2]!);
      if (!section || sectionGroup(section) !== group) throw new HttpError(404, "not_found", "Sezione non trovata");
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
