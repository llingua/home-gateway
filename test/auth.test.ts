import { beforeEach, describe, expect, it } from "vitest";
import { authenticate, clearJwksCache, hasScope, parseClients, verifyAccessJwt } from "../src/auth";
import { HttpError } from "../src/errors";
import { AUD, baseEnv, FakeNet, JWKS_URL, makeKey, NOW, signJwt, TEAM, validClaims } from "./helpers";

beforeEach(() => clearJwksCache());

async function setup() {
  const key = await makeKey();
  const net = new FakeNet().json(JWKS_URL, { keys: [key.jwk] });
  return { key, net };
}

describe("verifyAccessJwt", () => {
  it("accetta un token valido", async () => {
    const { key, net } = await setup();
    const claims = await verifyAccessJwt(await signJwt(key, validClaims()), { teamDomain: TEAM, aud: AUD, fetch: net.fetch, now: NOW });
    expect(claims.common_name).toBe("homepage-client-id");
  });

  it("rifiuta una firma fatta con un'altra chiave", async () => {
    const { net } = await setup();
    const other = await makeKey("key-1"); // stesso kid, chiave diversa
    await expect(
      verifyAccessJwt(await signJwt(other, validClaims()), { teamDomain: TEAM, aud: AUD, fetch: net.fetch, now: NOW }),
    ).rejects.toThrow("bad_signature");
  });

  it("rifiuta token scaduti, di un'altra app o di un altro emittente", async () => {
    const { key, net } = await setup();
    const check = async (claims: Record<string, unknown>) =>
      verifyAccessJwt(await signJwt(key, claims), { teamDomain: TEAM, aud: AUD, fetch: net.fetch, now: NOW });
    await expect(check(validClaims({ exp: NOW - 1 }))).rejects.toThrow("expired");
    await expect(check(validClaims({ aud: ["altra-app"] }))).rejects.toThrow("bad_audience");
    await expect(check(validClaims({ iss: "https://evil.example.com" }))).rejects.toThrow("bad_issuer");
    await expect(check(validClaims({ nbf: NOW + 100 }))).rejects.toThrow("not_yet_valid");
  });

  it("rifiuta algoritmi diversi da RS256 e token malformati", async () => {
    const { key, net } = await setup();
    const opts = { teamDomain: TEAM, aud: AUD, fetch: net.fetch, now: NOW };
    await expect(verifyAccessJwt(await signJwt(key, validClaims(), { alg: "none" }), opts)).rejects.toThrow("unsupported_alg");
    await expect(verifyAccessJwt("non.un.jwt.valido", opts)).rejects.toThrow();
    await expect(verifyAccessJwt("abc", opts)).rejects.toThrow("malformed");
  });

  it("ricarica le chiavi una volta se il kid è nuovo (rotazione)", async () => {
    const oldKey = await makeKey("old");
    const newKey = await makeKey("new");
    let rotated = false;
    const net = new FakeNet().on(JWKS_URL, () => new Response(JSON.stringify({ keys: [rotated ? newKey.jwk : oldKey.jwk] })));

    const opts = { teamDomain: TEAM, aud: AUD, fetch: net.fetch, now: NOW };
    await verifyAccessJwt(await signJwt(oldKey, validClaims()), opts);
    rotated = true;
    await verifyAccessJwt(await signJwt(newKey, validClaims()), opts);
    expect(net.callsTo(JWKS_URL)).toBe(2);
  });

  it("non riscarica le chiavi a ogni richiesta", async () => {
    const { key, net } = await setup();
    const opts = { teamDomain: TEAM, aud: AUD, fetch: net.fetch, now: NOW };
    await verifyAccessJwt(await signJwt(key, validClaims()), opts);
    await verifyAccessJwt(await signJwt(key, validClaims()), opts);
    expect(net.callsTo(JWKS_URL)).toBe(1);
  });
});

describe("parseClients / hasScope", () => {
  it("normalizza le chiavi in minuscolo e ignora voci malformate", () => {
    const clients = parseClients(JSON.stringify({ "A@B.it": { name: "x", scopes: ["media:read"] }, rotto: { name: 1 } }));
    expect(Object.keys(clients)).toEqual(["a@b.it"]);
  });

  it("restituisce un elenco vuoto se il JSON non è valido", () => {
    expect(parseClients("{non json")).toEqual({});
    expect(parseClients(undefined)).toEqual({});
  });

  it("riconosce permessi esatti e il jolly", () => {
    expect(hasScope({ name: "x", scopes: ["media:read"] }, "media:read")).toBe(true);
    expect(hasScope({ name: "x", scopes: ["media:read"] }, "media:write")).toBe(false);
    expect(hasScope({ name: "x", scopes: ["*"] }, "media:write")).toBe(true);
  });
});

describe("authenticate", () => {
  const req = (token?: string) => new Request("https://gateway.test/v1/capabilities", token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : {});

  async function status(promise: Promise<unknown>): Promise<number | "ok"> {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return error instanceof HttpError ? error.status : -1;
    }
  }

  it("chiude tutto (500) se manca la configurazione", async () => {
    const { net } = await setup();
    expect(await status(authenticate(req("x"), baseEnv({ ACCESS_AUD: undefined }), { fetch: net.fetch, now: NOW }))).toBe(500);
    expect(await status(authenticate(req("x"), baseEnv({ ACCESS_TEAM_DOMAIN: undefined }), { fetch: net.fetch, now: NOW }))).toBe(500);
  });

  it("401 senza token o con token non valido", async () => {
    const { net } = await setup();
    expect(await status(authenticate(req(), baseEnv(), { fetch: net.fetch, now: NOW }))).toBe(401);
    expect(await status(authenticate(req("a.b.c"), baseEnv(), { fetch: net.fetch, now: NOW }))).toBe(401);
  });

  it("riconosce un token di servizio dal Client ID", async () => {
    const { key, net } = await setup();
    const client = await authenticate(req(await signJwt(key, validClaims())), baseEnv(), { fetch: net.fetch, now: NOW });
    expect(client).toEqual({ name: "homepage", scopes: ["media:read"] });
  });

  it("riconosce un utente dall'email, senza distinguere maiuscole", async () => {
    const { key, net } = await setup();
    const token = await signJwt(key, validClaims({ common_name: undefined, email: "admin@example.com" }));
    expect((await authenticate(req(token), baseEnv(), { fetch: net.fetch, now: NOW })).name).toBe("admin");
  });

  it("403 se il token è valido ma il cliente non è in elenco", async () => {
    const { key, net } = await setup();
    const token = await signJwt(key, validClaims({ common_name: "sconosciuto" }));
    expect(await status(authenticate(req(token), baseEnv(), { fetch: net.fetch, now: NOW }))).toBe(403);
  });
});
