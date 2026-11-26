import { hasScope } from "./auth";
import { loadSection, type LoadDeps } from "./load";
import { SECTIONS, findSection, type SectionDef } from "./sections";
import type { Client, Env, SectionResult } from "./types";

/**
 * Interfaccia MCP (Model Context Protocol) del gateway, per far usare i dati a Claude e ad altri agenti.
 *
 * - Trasporto "Streamable HTTP" in modalità semplice: ogni richiesta è un POST JSON-RPC 2.0 con risposta JSON
 *   (nessuna sessione, nessun flusso SSE).
 * - L'autenticazione è la stessa dell'API REST (Cloudflare Access, verificata in `auth.ts`):
 *   qui si decide solo cosa può fare ciascun cliente, in base ai permessi.
 * - Oggi tutti gli strumenti sono di SOLA LETTURA.
 */

const SERVER_VERSION = "0.2.0";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 64 * 1024;

type Id = string | number | null;

interface RpcMessage {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Tool {
  name: string;
  description: string;
  scope: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, deps: McpDeps, client: Client) => Promise<{ text: string; isError?: boolean }>;
}

export interface McpDeps extends LoadDeps {
  env: Env;
  /** Secondi Unix; sostituibile nei test. */
  now?: number;
}

const ok = (id: Id, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

const sectionNames = () => SECTIONS.map((section) => section.name);

function sectionTool(section: SectionDef): Tool {
  return {
    name: `get_${section.name}`,
    description: section.description,
    scope: section.scope,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (_args, deps) => ({ text: JSON.stringify(await loadSection(section, deps.env, deps)) }),
  };
}

const overviewTool: Tool = {
  name: "get_overview",
  description:
    "Più sezioni in una sola chiamata (di default tutte quelle consentite). Ogni sezione ha uno `status`: " +
    "ok, error (servizio non raggiungibile) o unconfigured (segreto mancante).",
  scope: "media:read",
  inputSchema: {
    type: "object",
    properties: {
      sections: { type: "array", items: { type: "string", enum: sectionNames() }, description: "Sezioni richieste; se omesso, tutte." },
    },
    additionalProperties: false,
  },
  run: (args, deps, client) => overview(args, deps, client),
};

/** Il permesso della panoramica è quello di ogni singola sezione: lo si controlla sezione per sezione. */
async function overview(args: Record<string, unknown>, deps: McpDeps, client: Client): Promise<{ text: string; isError?: boolean }> {
  const requested = Array.isArray(args.sections) ? args.sections.filter((name): name is string => typeof name === "string") : null;
  const names = requested && requested.length ? requested : sectionNames();
  const sections: SectionDef[] = [];
  for (const name of names) {
    const section = findSection(name);
    if (!section) return { text: `Sezione sconosciuta: ${name}`, isError: true };
    sections.push(section);
  }
  const allowed = sections.filter((section) => hasScope(client, section.scope));
  if (requested && allowed.length < sections.length) return { text: "Permesso mancante per una delle sezioni richieste", isError: true };

  const results = await Promise.all(allowed.map((section) => loadSection(section, deps.env, deps)));
  const out: Record<string, SectionResult> = {};
  allowed.forEach((section, index) => {
    out[section.name] = results[index]!;
  });
  return { text: JSON.stringify({ generatedAt: new Date((deps.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(), sections: out }) };
}

const TOOLS: Tool[] = [overviewTool, ...SECTIONS.map(sectionTool)];

const allowedTools = (client: Client) => TOOLS.filter((tool) => hasScope(client, tool.scope));

const INSTRUCTIONS =
  "Gateway di casa Belinchebon: dati in sola lettura su Plex, Radarr, Sonarr, qBittorrent, Overseerr, Prowlarr, Bazarr e Proxmox. " +
  "Ogni risposta ha uno `status` (ok, error, unconfigured): non trattare un errore come assenza di dati. " +
  "Non contiene utenti, indirizzi né chiavi.";

async function handleMessage(message: RpcMessage, client: Client, deps: McpDeps): Promise<RpcResponse | null> {
  const isNotification = message.id === undefined;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return isNotification ? null : fail(message.id ?? null, -32600, "Richiesta non valida");
  }
  if (isNotification) return null; // notifications/initialized, notifications/cancelled...

  const id = message.id as Id;
  const params = message.params ?? {};

  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0]!;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "home-gateway", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: allowedTools(client).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return fail(id, -32602, `Strumento sconosciuto: ${name}`);
      if (!hasScope(client, tool.scope)) {
        return ok(id, { content: [{ type: "text", text: `Permesso mancante: ${tool.scope}` }], isError: true });
      }
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      // Registro minimo: chi ha chiamato cosa. Mai i dati restituiti.
      console.log(JSON.stringify({ event: "mcp_call", client: client.name, tool: tool.name }));
      const result = await tool.run(args, deps, client);
      return ok(id, { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) });
    }
    default:
      return fail(id, -32601, `Metodo non supportato: ${message.method}`);
  }
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const rpcHttp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export async function handleMcp(request: Request, client: Client, deps: McpDeps): Promise<Response> {
  if (request.method !== "POST") {
    // Nessun flusso SSE né sessioni: i client MCP lo capiscono dal 405.
    return new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "L'endpoint MCP accetta solo POST" } }), {
      status: 405,
      headers: { ...JSON_HEADERS, Allow: "POST" },
    });
  }

  // Protezione dal "DNS rebinding": le richieste dei browser portano un'intestazione Origin, quelle degli agenti no.
  if (request.headers.get("Origin")) {
    return rpcHttp(fail(null, -32600, "Origin non ammessa"), 403);
  }

  const version = request.headers.get("MCP-Protocol-Version");
  if (version && !SUPPORTED_VERSIONS.includes(version)) {
    return rpcHttp(fail(null, -32600, `Versione del protocollo non supportata: ${version}`), 400);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return rpcHttp(fail(null, -32600, "Richiesta troppo grande"), 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rpcHttp(fail(null, -32700, "JSON non valido"), 400);
  }

  const batch = Array.isArray(parsed);
  const messages = (batch ? parsed : [parsed]) as RpcMessage[];
  if (messages.length === 0 || messages.some((message) => !message || typeof message !== "object")) {
    return rpcHttp(fail(null, -32600, "Richiesta non valida"), 400);
  }

  const responses = (await Promise.all(messages.map((message) => handleMessage(message, client, deps)))).filter(
    (response): response is RpcResponse => response !== null,
  );

  // Solo notifiche: nessuna risposta da restituire.
  if (responses.length === 0) return new Response(null, { status: 202 });
  return rpcHttp(batch ? responses : responses[0]);
}
