import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { APPROVAL_AUD, APPROVER_EMAIL, AUD, FakeKv, makeKey, NOW, signJwt, TEAM, validClaims, writeEnv, writeNet, writeState, type TestKey, type WriteState } from "./helpers";
import type { Env } from "../src/types";

let key: TestKey;
let kv: FakeKv;
let state: WriteState;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
  kv = new FakeKv();
  state = writeState();
});

const WRITER = () => ({ common_name: "writer-id" });
const READER = () => ({ common_name: "agent-id" });
const HOMEPAGE = () => ({ common_name: "homepage-client-id" });

interface Opts {
  claims?: Record<string, unknown>;
  now?: number;
  env?: Env;
  ignoreSet?: boolean;
}

/** Chiamata MCP come agente (token di servizio). */
async function tool(name: string, args: Record<string, unknown>, who: () => Record<string, unknown>, opts: Opts = {}) {
  const now = opts.now ?? NOW;
  const net = writeNet(key, state, { ignoreSetPreferences: opts.ignoreSet });
  const response = await handle(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await signJwt(key, validClaims({ ...who(), exp: now + 600 })) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    opts.env ?? writeEnv(kv),
    { fetch: net.fetch, now },
  );
  const json = (await response.json()) as any;
  const result = json.result;
  const text: string = result?.content?.[0]?.text ?? "";
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* messaggio di errore in chiaro */ }
  return { isError: Boolean(result?.isError), text, data, json };
}

async function list(who: () => Record<string, unknown>, env?: Env) {
  const net = writeNet(key, state);
  const response = await handle(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await signJwt(key, validClaims(who())) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env ?? writeEnv(kv),
    { fetch: net.fetch, now: NOW },
  );
  return ((await response.json()) as any).result.tools.map((t: any) => t.name) as string[];
}

/** Richiesta alla pagina di approvazione come persona (JWT dell'app di approvazione, con email). */
async function approvalRequest(planId: string, options: { method?: string; claims?: Record<string, unknown>; now?: number; form?: Record<string, string>; origin?: string | null; token?: boolean; aud?: string } = {}) {
  const now = options.now ?? NOW;
  const headers: Record<string, string> = {};
  if (options.token !== false) {
    headers["Cf-Access-Jwt-Assertion"] = await signJwt(key, {
      iss: `https://${TEAM}`, aud: [options.aud ?? APPROVAL_AUD], exp: now + 600, iat: now - 10, email: APPROVER_EMAIL, ...options.claims,
    });
  }
  const method = options.method ?? "GET";
  let body: string | undefined;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (options.origin !== null) headers["Origin"] = options.origin ?? "https://gateway.test";
    body = new URLSearchParams(options.form ?? {}).toString();
  }
  const net = writeNet(key, state);
  return handle(new Request(`https://gateway.test/approve/${planId}`, { method, headers, body }), writeEnv(kv), { fetch: net.fetch, now });
}

async function csrfOf(planId: string, claims?: Record<string, unknown>): Promise<string> {
  const html = await (await approvalRequest(planId, { claims })).text();
  const match = /name="csrf" value="([a-f0-9]+)"/.exec(html);
  if (!match) throw new Error("token CSRF non trovato nella pagina");
  return match[1]!;
}

async function approve(planId: string, now = NOW) {
  const csrf = await csrfOf(planId);
  return approvalRequest(planId, { method: "POST", form: { csrf, decision: "approve" }, now });
}

const proposeQbt = (changes: Record<string, unknown>, who = WRITER, opts: Opts = {}) => tool("propose_qbittorrent_preferences", { changes }, who, opts);

describe("strumenti disponibili", () => {
  it("chi ha config:write vede proposta e applicazione; chi legge soltanto vede solo piano e registro; la homepage nulla", async () => {
    const writer = await list(WRITER);
    expect(writer).toEqual(expect.arrayContaining(["propose_qbittorrent_preferences", "propose_prowlarr_indexer_enabled", "propose_undo", "apply_plan", "get_plan", "get_audit_log"]));
    const reader = await list(READER);
    expect(reader).toEqual(expect.arrayContaining(["get_plan", "get_audit_log"]));
    expect(reader.some((n) => n.startsWith("propose_") || n === "apply_plan")).toBe(false);
    const home = await list(HOMEPAGE);
    expect(home.some((n) => ["get_plan", "get_audit_log", "apply_plan"].includes(n) || n.startsWith("propose_"))).toBe(false);
  });

  it("senza l'archivio dei piani le scritture non esistono", async () => {
    const names = await list(WRITER, writeEnv(kv, { STATE: undefined }));
    expect(names.some((n) => n.startsWith("propose_") || n === "apply_plan" || n === "get_plan")).toBe(false);
  });

  it("non esiste nessuno strumento per approvare: l'agente non può farlo", async () => {
    const names = await list(WRITER);
    expect(names.some((n) => /approv/i.test(n))).toBe(false);
  });

  it("apply_plan è dichiarato distruttivo, le proposte no", async () => {
    const net = writeNet(key, state);
    const response = await handle(
      new Request("https://gateway.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await signJwt(key, validClaims(WRITER())) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
      writeEnv(kv), { fetch: net.fetch, now: NOW },
    );
    const tools = ((await response.json()) as any).result.tools;
    expect(tools.find((t: any) => t.name === "apply_plan").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t: any) => t.name === "propose_qbittorrent_preferences").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("link di approvazione", () => {
  it("con APPROVAL_ORIGIN punta sempre lì, anche se l'agente è entrato da un altro indirizzo (es. mcp.belinchebon.com)", async () => {
    const r = await proposeQbt({ max_active_torrents: 10 }, WRITER, { env: writeEnv(kv, { APPROVAL_ORIGIN: "https://approva.test/qualcosa?x=1" }) });
    expect(r.data.approvalUrl).toBe(`https://approva.test/approve/${r.data.planId}`);
    const again = await tool("get_plan", { planId: r.data.planId }, WRITER, { env: writeEnv(kv, { APPROVAL_ORIGIN: "https://approva.test" }) });
    expect(again.data.approvalUrl).toBe(`https://approva.test/approve/${r.data.planId}`);
  });

  it("valore non valido o non https: si usa l'indirizzo della richiesta", async () => {
    for (const bad of ["http://approva.test", "javascript:alert(1)", "non un url"]) {
      const r = await proposeQbt({ max_active_torrents: 10 }, WRITER, { env: writeEnv(kv, { APPROVAL_ORIGIN: bad }) });
      expect(r.data.approvalUrl).toBe(`https://gateway.test/approve/${r.data.planId}`);
    }
  });
});

describe("proposta", () => {
  it("calcola cosa cambierebbe e NON modifica nulla", async () => {
    const r = await proposeQbt({ max_active_torrents: 10 });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: "pending", summary: "qBittorrent: cambia max_active_torrents", proposedBy: "scrittore" });
    expect(r.data.changes).toEqual([{ target: "qBittorrent", field: "max_active_torrents", from: 3, to: 10 }]);
    expect(r.data.approvalUrl).toBe(`https://gateway.test/approve/${r.data.planId}`);
    expect(state.posts).toHaveLength(0);
    expect(state.prefs.max_active_torrents).toBe(3);
  });

  it("registra la proposta nel registro", async () => {
    await proposeQbt({ max_active_torrents: 10 });
    const log = await tool("get_audit_log", {}, WRITER);
    expect(log.data.entries.map((e: any) => e.event)).toEqual(["proposta"]);
    expect(log.data.entries[0]).toMatchObject({ actor: "scrittore", action: "qbittorrent_preferences" });
  });

  it("rifiuta impostazioni sconosciute, valori fuori limite e proposte senza effetto", async () => {
    expect((await proposeQbt({ web_ui_password: 1 })).text).toContain("invalid_input");
    expect((await proposeQbt({ max_active_torrents: 0 })).text).toContain("tra 1 e 200");
    expect((await proposeQbt({ max_active_torrents: 9999 })).isError).toBe(true);
    expect((await proposeQbt({ max_active_torrents: 5.5 })).isError).toBe(true);
    expect((await proposeQbt({ max_active_torrents: "10" })).isError).toBe(true);
    expect((await proposeQbt({})).isError).toBe(true);
    expect((await proposeQbt({ max_active_torrents: 3 })).text).toContain("no_change");
  });

  it("chi legge soltanto non può proporre", async () => {
    const r = await proposeQbt({ max_active_torrents: 10 }, READER);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("config:write");
    expect(kv.data.size).toBe(0);
  });

  it("al massimo 10 proposte in attesa", async () => {
    for (let i = 0; i < 10; i += 1) expect((await proposeQbt({ max_active_torrents: 10 + i })).isError).toBe(false);
    const r = await proposeQbt({ max_active_torrents: 50 });
    expect(r.text).toContain("too_many_pending");
  });

  it("Prowlarr: proposta con nome dell'indexer, senza esporre le credenziali", async () => {
    const r = await tool("propose_prowlarr_indexer_enabled", { indexerId: 3, enable: false }, WRITER);
    expect(r.data.summary).toBe('Prowlarr: disattiva l\'indexer "The Pirate Bay"');
    expect(r.data.changes[0]).toMatchObject({ field: "enable", from: true, to: false });
    expect(r.text).not.toContain("chiave-indexer-segreta");
    expect(r.text).not.toContain("192.168.0.9");
    expect(state.puts).toHaveLength(0);
  });

  it("Prowlarr: indexer inesistente o già nello stato richiesto", async () => {
    expect((await tool("propose_prowlarr_indexer_enabled", { indexerId: 99, enable: false }, WRITER)).text).toContain("not_found");
    expect((await tool("propose_prowlarr_indexer_enabled", { indexerId: 3, enable: true }, WRITER)).text).toContain("no_change");
    expect((await tool("propose_prowlarr_indexer_enabled", { indexerId: "3", enable: false }, WRITER)).isError).toBe(true);
    expect((await tool("propose_prowlarr_indexer_enabled", { indexerId: 3, enable: false, extra: 1 }, WRITER)).isError).toBe(true);
  });
});

describe("approvazione: chi può approvare", () => {
  it("una persona nell'elenco vede la modifica esatta e i pulsanti", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    const response = await approvalRequest(data.planId);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("qBittorrent: cambia max_active_torrents");
    expect(html).toContain("max_active_torrents");
    expect(html).toContain("<strong>10</strong>");
    expect(html).toContain('name="decision" value="approve"');
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("un token di servizio (l'agente) NON può approvare, nemmeno con l'audience giusta", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    const agentClaims = { email: undefined, common_name: "writer-id" };
    const response = await approvalRequest(data.planId, { claims: agentClaims });
    expect(response.status).toBe(403);
    const post = await approvalRequest(data.planId, { method: "POST", claims: agentClaims, form: { csrf: "x", decision: "approve" } });
    expect(post.status).toBe(403);
    expect((await tool("get_plan", { planId: data.planId }, WRITER)).data.status).toBe("pending");
  });

  it("un'email non autorizzata non approva", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    expect((await approvalRequest(data.planId, { claims: { email: "intruso@example.test" } })).status).toBe(403);
  });

  it("l'email si confronta senza distinguere maiuscole", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    expect((await approvalRequest(data.planId, { claims: { email: APPROVER_EMAIL.toUpperCase() } })).status).toBe(200);
  });

  it("senza accesso o con accesso dell'altra app (audience sbagliata) -> 401", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    expect((await approvalRequest(data.planId, { token: false })).status).toBe(401);
    expect((await approvalRequest(data.planId, { aud: AUD })).status).toBe(401);
  });

  it("percorsi strani non portano a nulla", async () => {
    // "../../etc" viene normalizzato prima di arrivare al gateway e non entra nella pagina di approvazione.
    expect((await approvalRequest("../../etc")).status).not.toBe(200);
    expect((await approvalRequest("a".repeat(31))).status).toBe(404);
    expect((await approvalRequest("a".repeat(33))).status).toBe(404);
    expect((await approvalRequest("A".repeat(32))).status).toBe(404);
  });

  it("se mancano APPROVERS o il segreto, la pagina è spenta (503)", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    for (const extra of [{ APPROVERS: undefined }, { APPROVAL_SECRET: undefined }, { ACCESS_AUD_APPROVAL: undefined }]) {
      const net = writeNet(key, state);
      const res = await handle(
        new Request(`https://gateway.test/approve/${data.planId}`, { headers: { "Cf-Access-Jwt-Assertion": await signJwt(key, { iss: `https://${TEAM}`, aud: [APPROVAL_AUD], exp: NOW + 600, email: APPROVER_EMAIL }) } }),
        writeEnv(kv, extra), { fetch: net.fetch, now: NOW },
      );
      expect(res.status).toBe(503);
    }
  });

  it("il nome dell'indexer, scelto da un servizio esterno, non può iniettare HTML nella pagina", async () => {
    const { data } = await tool("propose_prowlarr_indexer_enabled", { indexerId: 4, enable: false }, WRITER);
    const html = await (await approvalRequest(data.planId)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("approvazione: la decisione", () => {
  it("serve il token anti-CSRF e l'origine corretta", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    const csrf = await csrfOf(data.planId);
    const post = (form: Record<string, string>, origin?: string | null) => approvalRequest(data.planId, { method: "POST", form, origin });
    expect((await post({ decision: "approve" })).status).toBe(403);
    expect((await post({ csrf: "sbagliato", decision: "approve" })).status).toBe(403);
    expect((await post({ csrf: csrf.slice(0, -1) + (csrf.endsWith("0") ? "1" : "0"), decision: "approve" })).status).toBe(403);
    expect((await post({ csrf, decision: "approve" }, "https://evil.example.com")).status).toBe(403);
    expect((await post({ csrf, decision: "approve" }, null)).status).toBe(403);
    expect((await post({ csrf, decision: "boh" })).status).toBe(403);
    expect((await tool("get_plan", { planId: data.planId }, WRITER)).data.status).toBe("pending");
    expect((await post({ csrf, decision: "approve" })).status).toBe(200);
    expect((await tool("get_plan", { planId: data.planId }, WRITER)).data.status).toBe("approved");
  });

  it("la pagina non usa Referrer-Policy no-referrer (i browser manderebbero Origin: null e ogni clic verrebbe rifiutato)", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    const res = await approvalRequest(data.planId, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
  });

  it("il token anti-CSRF di un altro piano non vale", async () => {
    const a = await proposeQbt({ max_active_torrents: 10 });
    const b = await proposeQbt({ max_active_torrents: 11 });
    const csrfA = await csrfOf(a.data.planId);
    const res = await approvalRequest(b.data.planId, { method: "POST", form: { csrf: csrfA, decision: "approve" } });
    expect(res.status).toBe(403);
  });

  it("rifiutare impedisce ogni applicazione", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    const csrf = await csrfOf(data.planId);
    expect((await approvalRequest(data.planId, { method: "POST", form: { csrf, decision: "reject" } })).status).toBe(200);
    const r = await tool("apply_plan", { planId: data.planId }, WRITER);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("rejected: Il piano è stato rifiutato");
    expect(state.posts).toHaveLength(0);
  });

  it("non si può decidere due volte né dopo la scadenza", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    const csrf = await csrfOf(data.planId); // dopo l'approvazione la pagina non ha più il modulo
    await approve(data.planId);
    const again = await approvalRequest(data.planId, { method: "POST", form: { csrf, decision: "reject" } });
    expect(await again.text()).toContain("non è più in attesa");
    expect((await tool("get_plan", { planId: data.planId }, WRITER)).data.status).toBe("approved");

    const late = await proposeQbt({ max_active_torrents: 12 });
    const csrfLate = await csrfOf(late.data.planId);
    const res = await approvalRequest(late.data.planId, { method: "POST", form: { csrf: csrfLate, decision: "approve" }, now: NOW + 16 * 60 });
    expect(await res.text()).toContain("scaduto");
  });
});

describe("applicazione", () => {
  it("senza approvazione non si applica nulla", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    const r = await tool("apply_plan", { planId: data.planId }, WRITER);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_approved");
    expect(state.posts).toHaveLength(0);
    expect(state.prefs.max_active_torrents).toBe(3);
  });

  it("percorso completo: proponi → approva → applica → verificato", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10, max_active_downloads: 5 });
    await approve(data.planId, NOW + 10);
    const r = await tool("apply_plan", { planId: data.planId }, WRITER, { now: NOW + 20 });
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe("applied");
    expect(r.data.result).toContain("Applicato e verificato");
    expect(state.posts).toEqual([{ max_active_torrents: 10, max_active_downloads: 5 }]);
    expect(state.prefs).toMatchObject({ max_active_torrents: 10, max_active_downloads: 5 });
    expect(state.prefs.web_ui_password).toBe("hash-segreto"); // nient'altro è stato toccato

    const log = await tool("get_audit_log", {}, WRITER, { now: NOW + 30 });
    expect(log.data.entries.map((e: any) => e.event)).toEqual(["applicata", "approvata", "proposta"]);
    expect(log.data.entries.find((e: any) => e.event === "approvata").actor).toBe(APPROVER_EMAIL);
  });

  it("ogni piano si applica una volta sola", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    await approve(data.planId);
    await tool("apply_plan", { planId: data.planId }, WRITER);
    const second = await tool("apply_plan", { planId: data.planId }, WRITER);
    expect(second.isError).toBe(true);
    expect(second.text).toContain("already_used");
    expect(state.posts).toHaveLength(1);
  });

  it("chi legge soltanto non può applicare, nemmeno un piano approvato", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    await approve(data.planId);
    const r = await tool("apply_plan", { planId: data.planId }, READER);
    expect(r.isError).toBe(true);
    expect(state.posts).toHaveLength(0);
  });

  it("se lo stato cambia dopo la proposta, non si applica e bisogna riproporre", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    await approve(data.planId);
    state.prefs.max_active_torrents = 7; // qualcuno ha cambiato il valore nel frattempo
    const r = await tool("apply_plan", { planId: data.planId }, WRITER);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("state_changed");
    expect(state.posts).toHaveLength(0);
    expect(state.prefs.max_active_torrents).toBe(7);
    expect((await tool("get_plan", { planId: data.planId }, WRITER)).data.status).toBe("failed");
  });

  it("un piano approvato ma non applicato entro 10 minuti scade", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    await approve(data.planId);
    const r = await tool("apply_plan", { planId: data.planId }, WRITER, { now: NOW + 11 * 60 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("expired");
    expect(state.posts).toHaveLength(0);
  });

  it("un piano mai approvato scade dopo 15 minuti", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    const r = await tool("apply_plan", { planId: data.planId }, WRITER, { now: NOW + 16 * 60 });
    expect(r.text).toContain("expired");
    expect((await tool("get_plan", { planId: data.planId }, WRITER, { now: NOW + 16 * 60 })).data.status).toBe("failed");
  });

  it("identificativi sbagliati non portano a nulla", async () => {
    for (const planId of ["", "zzz", "../x", "a".repeat(32)]) {
      const r = await tool("apply_plan", { planId }, WRITER);
      expect(r.isError).toBe(true);
    }
    expect(state.posts).toHaveLength(0);
  });

  it("Prowlarr: disattivare un indexer tiene intatte le sue credenziali e non le rivela all'agente", async () => {
    const { data } = await tool("propose_prowlarr_indexer_enabled", { indexerId: 3, enable: false }, WRITER);
    await approve(data.planId);
    const r = await tool("apply_plan", { planId: data.planId }, WRITER);
    expect(r.data.status).toBe("applied");
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0]!.url).toContain("forceSave=true");
    expect(state.puts[0]!.body.enable).toBe(false);
    expect(state.puts[0]!.body.fields).toEqual([{ name: "apiKey", value: "chiave-indexer-segreta" }, { name: "baseUrl", value: "http://192.168.0.9/x" }]);
    expect(r.text).not.toContain("chiave-indexer-segreta");
    expect(r.text).not.toContain("192.168.0.9");
    expect(state.indexers[3]!.enable).toBe(false);
  });

  it("se il servizio non riporta i nuovi valori, l'applicazione risulta FALLITA (non riuscita)", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    await approve(data.planId);
    const r = await tool("apply_plan", { planId: data.planId }, WRITER, { ignoreSet: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Verifica fallita");
    expect((await tool("get_plan", { planId: data.planId }, WRITER)).data.status).toBe("failed");
    const log = await tool("get_audit_log", {}, WRITER);
    expect(log.data.entries.some((e: any) => e.event === "fallita")).toBe(true);
  });

  it("annullamento: si propone il ripristino, che richiede una nuova approvazione", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    await approve(data.planId);
    await tool("apply_plan", { planId: data.planId }, WRITER);

    const undo = await tool("propose_undo", { planId: data.planId }, WRITER);
    expect(undo.data.status).toBe("pending");
    expect(undo.data.changes).toEqual([{ target: "qBittorrent", field: "max_active_torrents", from: 10, to: 3 }]);
    expect(state.prefs.max_active_torrents).toBe(10); // ancora applicato: serve l'approvazione
    expect((await tool("apply_plan", { planId: undo.data.planId }, WRITER)).text).toContain("not_approved");

    await approve(undo.data.planId);
    expect((await tool("apply_plan", { planId: undo.data.planId }, WRITER)).data.status).toBe("applied");
    expect(state.prefs.max_active_torrents).toBe(3);
  });

  it("non si annulla un piano non applicato", async () => {
    const { data } = await proposeQbt({ max_active_torrents: 10 });
    expect((await tool("propose_undo", { planId: data.planId }, WRITER)).text).toContain("not_applicable");
  });
});
