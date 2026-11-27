import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { MAX_QUICK_CHANGES_PER_DAY } from "../src/quick-actions";
import { APPROVER_EMAIL, FakeKv, makeKey, NOW, signJwt, TEAM, validClaims, writeEnv, writeNet, writeState, type TestKey, type WriteState } from "./helpers";

/** Modifica rapida dei limiti di qBittorrent confermata in chat: solo per la persona che entra dall'app (OAuth). */
const OAUTH_AUD = "aud-oauth-789";
let key: TestKey;
let kv: FakeKv;
let state: WriteState;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
  kv = new FakeKv();
  state = writeState();
});

const env = () => writeEnv(kv, { ACCESS_AUD_OAUTH: OAUTH_AUD });
const PERSON = async () => signJwt(key, { iss: `https://${TEAM}`, aud: [OAUTH_AUD], email: APPROVER_EMAIL, exp: NOW + 600, iat: NOW - 10 });
const AGENT_TOKEN = async () => signJwt(key, validClaims({ common_name: "writer-id" })); // token di servizio con config:write

async function rpc(token: string, method: string, params?: unknown, options: { ignoreSet?: boolean } = {}) {
  const net = writeNet(key, state, { ignoreSetPreferences: options.ignoreSet });
  const response = await handle(
    new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    }),
    env(),
    { fetch: net.fetch, now: NOW },
  );
  return (await response.json()) as any;
}
async function setQbt(args: Record<string, unknown>, token?: string, options: { ignoreSet?: boolean } = {}) {
  const body = await rpc(token ?? (await PERSON()), "tools/call", { name: "set_qbittorrent_preferences", arguments: args }, options);
  const text: string = body.result?.content?.[0]?.text ?? JSON.stringify(body);
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* errore in chiaro */ }
  return { isError: Boolean(body.result?.isError), text, data };
}
const auditEvents = async () => (await kv.list({ prefix: "audit:" })).keys.length;

describe("set_qbittorrent_preferences (conferma in chat)", () => {
  it("dalla app, dopo il sì: applica, verifica, registra e restituisce i valori per tornare indietro", async () => {
    const r = await setQbt({ changes: { max_active_downloads: 8, max_active_torrents: 30 }, confirmedByUser: true });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ applied: true, verified: true, quickChangesToday: 1, dailyLimit: MAX_QUICK_CHANGES_PER_DAY });
    expect(r.data.changes).toEqual([{ field: "max_active_downloads", from: 3, to: 8 }, { field: "max_active_torrents", from: 3, to: 30 }]);
    expect(r.data.toUndo.changes).toEqual({ max_active_downloads: 3, max_active_torrents: 3 });
    expect(state.prefs).toMatchObject({ max_active_downloads: 8, max_active_torrents: 30 });
    expect(state.posts).toEqual([{ max_active_downloads: 8, max_active_torrents: 30 }]);
    expect(await auditEvents()).toBe(1);
    expect(r.text).not.toContain("hash-segreto");
  });

  it("senza confirmedByUser: true non scrive nulla", async () => {
    for (const confirmedByUser of [false, "true", undefined]) {
      const r = await setQbt({ changes: { max_active_downloads: 8 }, confirmedByUser });
      expect(r.isError).toBe(true);
    }
    expect(state.posts).toHaveLength(0);
  });

  it("stesse chiavi e stessi limiti delle proposte: niente percorsi, credenziali o valori fuori limite", async () => {
    for (const changes of [{ save_path: "/tmp" }, { web_ui_password: "x" }, { max_active_downloads: 0 }, { max_active_downloads: 101 }, { max_active_downloads: 2.5 }, {}]) {
      expect((await setQbt({ changes, confirmedByUser: true })).isError).toBe(true);
    }
    expect(state.posts).toHaveLength(0);
  });

  it("il token di servizio dell'agente (config:write) NON può usarla e non la vede: resta l'approvazione dal browser", async () => {
    const token = await AGENT_TOKEN();
    const names = (await rpc(token, "tools/list")).result.tools.map((t: any) => t.name);
    expect(names).not.toContain("set_qbittorrent_preferences");
    expect(names).toContain("propose_qbittorrent_preferences");
    const r = await setQbt({ changes: { max_active_downloads: 8 }, confirmedByUser: true }, token);
    expect(r.isError).toBe(true);
    expect(state.posts).toHaveLength(0);
  });

  it("verifica fallita: errore e voce nel registro", async () => {
    const r = await setQbt({ changes: { max_active_downloads: 8 }, confirmedByUser: true }, undefined, { ignoreSet: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("apply_failed");
    expect(await auditEvents()).toBe(1);
  });

  it("valori già uguali: nessuna scrittura e il tetto non si consuma", async () => {
    const r = await setQbt({ changes: { max_active_downloads: 3 }, confirmedByUser: true });
    expect(r.text).toContain("no_change");
    const ok = await setQbt({ changes: { max_active_downloads: 4 }, confirmedByUser: true });
    expect(ok.data.quickChangesToday).toBe(1);
  });

  it(`tetto di ${MAX_QUICK_CHANGES_PER_DAY} al giorno, poi rimanda alle proposte`, async () => {
    for (let i = 0; i < MAX_QUICK_CHANGES_PER_DAY; i++) {
      expect((await setQbt({ changes: { max_active_downloads: 10 + i }, confirmedByUser: true })).isError).toBe(false);
    }
    const r = await setQbt({ changes: { max_active_downloads: 50 }, confirmedByUser: true });
    expect(r.text).toContain("daily_limit");
    expect(state.posts).toHaveLength(MAX_QUICK_CHANGES_PER_DAY);
  });
});
