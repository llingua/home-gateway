import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { baseEnv, healthyNet, makeKey, NOW, signJwt, validClaims, type TestKey } from "./helpers";

let key: TestKey;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
});

async function post(body: unknown, options: { claims?: Record<string, unknown>; headers?: Record<string, string>; raw?: string; method?: string; token?: boolean } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...options.headers };
  if (options.token !== false) headers["Cf-Access-Jwt-Assertion"] = await signJwt(key, options.claims ?? validClaims());
  const net = healthyNet(key);
  const response = await handle(
    new Request("https://gateway.test/mcp", { method: options.method ?? "POST", headers, body: options.method === "GET" ? undefined : (options.raw ?? JSON.stringify(body)) }),
    baseEnv(),
    { fetch: net.fetch, now: NOW },
  );
  return { response, net };
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });
const json = async (response: Response) => (await response.json()) as any;

describe("protocollo", () => {
  it("initialize: conferma la versione richiesta e dichiara solo gli strumenti", async () => {
    const { response } = await post(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(body.result.serverInfo.name).toBe("home-gateway");
    expect(body.id).toBe(1);
  });

  it("initialize con una versione sconosciuta propone la più recente supportata", async () => {
    const { response } = await post(rpc("initialize", { protocolVersion: "1999-01-01" }));
    expect((await json(response)).result.protocolVersion).toBe("2025-06-18");
  });

  it("le notifiche non hanno risposta (202)", async () => {
    const { response } = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("ping e metodi sconosciuti", async () => {
    expect((await json((await post(rpc("ping"))).response)).result).toEqual({});
    expect((await json((await post(rpc("resources/list"))).response)).error.code).toBe(-32601);
  });

  it("JSON non valido -> errore di parsing", async () => {
    const { response } = await post(null, { raw: "{non json" });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe(-32700);
  });

  it("richieste in blocco (batch): una risposta per ogni richiesta con id", async () => {
    const { response } = await post([rpc("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("ping", undefined, "b")]);
    const body = await json(response);
    expect(body.map((r: any) => r.id)).toEqual([1, "b"]);
  });

  it("un blocco vuoto è una richiesta non valida", async () => {
    expect((await post([])).response.status).toBe(400);
  });

  it("rifiuta versioni del protocollo sconosciute nell'intestazione", async () => {
    const { response } = await post(rpc("ping"), { headers: { "MCP-Protocol-Version": "1999-01-01" } });
    expect(response.status).toBe(400);
  });
});

describe("accesso", () => {
  it("senza token: 401", async () => {
    expect((await post(rpc("ping"), { token: false })).response.status).toBe(401);
  });

  it("solo POST (nessun flusso SSE)", async () => {
    const { response } = await post(null, { method: "GET" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rifiuta le richieste con intestazione Origin (browser)", async () => {
    const { response } = await post(rpc("ping"), { headers: { Origin: "https://evil.example.com" } });
    expect(response.status).toBe(403);
  });

  it("rifiuta richieste troppo grandi", async () => {
    const { response } = await post(null, { raw: JSON.stringify(rpc("ping", { x: "a".repeat(70_000) })) });
    expect(response.status).toBe(413);
  });

  it("gli altri percorsi restano di sola lettura: POST su /v1/... è ancora 405", async () => {
    const net = healthyNet(key);
    const res = await handle(
      new Request("https://gateway.test/v1/media/streams", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": await signJwt(key, validClaims()) } }),
      baseEnv(),
      { fetch: net.fetch, now: NOW },
    );
    expect(res.status).toBe(405);
  });
});

describe("strumenti", () => {
  it("tools/list: un cliente vede tutti gli strumenti, tutti di sola lettura", async () => {
    const body = await json((await post(rpc("tools/list"))).response);
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("get_overview");
    expect(names).toContain("get_streams");
    expect(names).toContain("get_proxmox");
    expect(body.result.tools.every((t: any) => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false)).toBe(true);
    expect(body.result.tools.every((t: any) => t.inputSchema.type === "object")).toBe(true);
  });

  it("tools/list: un cliente senza permessi non vede nessuno strumento", async () => {
    const body = await json((await post(rpc("tools/list"), { claims: validClaims({ common_name: "no-scope-id" }) })).response);
    expect(body.result.tools).toEqual([]);
  });

  it("tools/call: restituisce i dati di una sezione come testo JSON", async () => {
    const body = await json((await post(rpc("tools/call", { name: "get_requests", arguments: {} }))).response);
    expect(body.result.isError).toBeUndefined();
    const section = JSON.parse(body.result.content[0].text);
    expect(section).toMatchObject({ status: "ok", data: { pending: 2, processing: 34 } });
  });

  it("tools/call get_overview: tutte le sezioni o solo quelle richieste", async () => {
    const all = JSON.parse((await json((await post(rpc("tools/call", { name: "get_overview", arguments: {} }))).response)).result.content[0].text);
    expect(Object.keys(all.sections).length).toBeGreaterThanOrEqual(12);
    const some = JSON.parse((await json((await post(rpc("tools/call", { name: "get_overview", arguments: { sections: ["streams", "requests"] } }))).response)).result.content[0].text);
    expect(Object.keys(some.sections)).toEqual(["streams", "requests"]);
  });

  it("tools/call: sezione sconosciuta -> errore dello strumento (non del protocollo)", async () => {
    const body = await json((await post(rpc("tools/call", { name: "get_overview", arguments: { sections: ["boh"] } }))).response);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("boh");
  });

  it("tools/call: strumento sconosciuto -> errore JSON-RPC", async () => {
    const body = await json((await post(rpc("tools/call", { name: "cancella_tutto", arguments: {} }))).response);
    expect(body.error.code).toBe(-32602);
  });

  it("tools/call: senza permesso non interroga nessun servizio", async () => {
    const { response, net } = await post(rpc("tools/call", { name: "get_streams", arguments: {} }), { claims: validClaims({ common_name: "no-scope-id" }) });
    const body = await json(response);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Permesso mancante");
    expect(net.callsTo("https://plex.test")).toBe(0);
  });

  it("tools/call get_overview: un cliente senza permessi non ottiene niente", async () => {
    const { response, net } = await post(rpc("tools/call", { name: "get_overview", arguments: { sections: ["streams"] } }), { claims: validClaims({ common_name: "no-scope-id" }) });
    expect((await json(response)).result.isError).toBe(true);
    expect(net.callsTo("https://plex.test")).toBe(0);
  });

  it("non espone mai utenti, indirizzi, chiavi o token", async () => {
    const { response } = await post(rpc("tools/call", { name: "get_overview", arguments: {} }));
    const text = JSON.stringify(await json(response));
    for (const secret of ["mario.rossi", "segreto@example.com", "192.168", "radarr-key", "sonarr-key", "seerr-key", "plex-token", "prowlarr-key", "bazarr-key", "pve-secret-token", "gw-secret", "abc123"]) {
      expect(text).not.toContain(secret);
    }
  });
});
