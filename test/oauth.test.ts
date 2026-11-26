import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { APPROVER_EMAIL, FakeKv, makeKey, NOW, signJwt, TEAM, writeEnv, writeNet, writeState, type TestKey } from "./helpers";
import type { Env } from "../src/types";

/** Accesso da app come Claude: JWT dell'app Access con Managed OAuth (AUD diverso, utente con email). */
const OAUTH_AUD = "aud-oauth-789";

let key: TestKey;
let kv: FakeKv;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
  kv = new FakeKv();
});

const env = (extra: Partial<Env> = {}) => writeEnv(kv, { ACCESS_AUD_OAUTH: OAUTH_AUD, ...extra });

async function call(claims: Record<string, unknown>, e: Env, method = "tools/list") {
  const net = writeNet(key, writeState());
  const token = await signJwt(key, { iss: `https://${TEAM}`, exp: NOW + 600, iat: NOW - 10, ...claims });
  const response = await handle(
    new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    }),
    e,
    { fetch: net.fetch, now: NOW },
  );
  return { status: response.status, body: (await response.json()) as any };
}

describe("ingresso OAuth (app Claude)", () => {
  it("una persona approvatore entra e vede strumenti di lettura e di scrittura", async () => {
    const r = await call({ aud: [OAUTH_AUD], email: APPROVER_EMAIL }, env());
    expect(r.status).toBe(200);
    const names = r.body.result.tools.map((t: any) => t.name);
    expect(names).toContain("get_overview");
    expect(names).toContain("get_config_qbittorrent");
    expect(names).toContain("propose_qbittorrent_preferences");
    expect(names).toContain("apply_plan");
  });

  it("l'email non fa differenza tra maiuscole e minuscole", async () => {
    const r = await call({ aud: [OAUTH_AUD], email: APPROVER_EMAIL.toUpperCase() }, env());
    expect(r.status).toBe(200);
  });

  it("una persona sconosciuta è rifiutata (403)", async () => {
    expect((await call({ aud: [OAUTH_AUD], email: "estraneo@example.test" }, env())).status).toBe(403);
  });

  it("senza email (token di servizio) non entra dall'ingresso OAuth", async () => {
    expect((await call({ aud: [OAUTH_AUD], common_name: "agent-id" }, env())).status).toBe(403);
    expect((await call({ aud: [OAUTH_AUD], common_name: APPROVER_EMAIL }, env())).status).toBe(403);
  });

  it("se ACCESS_AUD_OAUTH non è configurato, l'AUD OAuth non vale (401)", async () => {
    expect((await call({ aud: [OAUTH_AUD], email: APPROVER_EMAIL }, env({ ACCESS_AUD_OAUTH: undefined }))).status).toBe(401);
  });

  it("un AUD sconosciuto è rifiutato (401)", async () => {
    expect((await call({ aud: ["altro"], email: APPROVER_EMAIL }, env())).status).toBe(401);
  });

  it("l'AUD della pagina di approvazione non apre l'API", async () => {
    expect((await call({ aud: ["aud-approvazione-456"], email: APPROVER_EMAIL }, env())).status).toBe(401);
  });

  it("un cliente elencato con la sua email in CLIENTS ha i permessi di quella riga", async () => {
    const clients = JSON.stringify({ "lettore@example.test": { name: "lettore", scopes: ["media:read"] } });
    const r = await call({ aud: [OAUTH_AUD], email: "lettore@example.test" }, env({ CLIENTS: clients }));
    const names = r.body.result.tools.map((t: any) => t.name);
    expect(names).toContain("get_overview");
    expect(names).not.toContain("get_config_qbittorrent");
    expect(names).not.toContain("propose_qbittorrent_preferences");
  });

  it("l'ingresso con token di servizio continua a funzionare", async () => {
    const r = await call({ aud: ["aud-test-123"], common_name: "agent-id" }, env());
    expect(r.status).toBe(200);
  });
});
