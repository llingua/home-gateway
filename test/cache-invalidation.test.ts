import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { invalidateAllSections, withCache } from "../src/cache";
import { SECTIONS } from "../src/sections";
import { Store } from "../src/store";
import { applyPlan, decide, propose, type WriteCtx } from "../src/writes";
import { authedRequest, FakeKv, makeKey, MemoryCache, NOW, signJwt, validClaims, writeEnv, writeNet, writeState, type TestKey, type WriteState } from "./helpers";
import type { CacheLike } from "../src/types";

let key: TestKey;
let kv: FakeKv;
let state: WriteState;
let cache: MemoryCache;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
  kv = new FakeKv();
  state = writeState();
  cache = new MemoryCache();
});

const writer = { name: "scrittore", scopes: ["config:write"] };
const AGENT = () => validClaims({ common_name: "agent-id" });

function setup(options: { ignoreSetPreferences?: boolean } = {}) {
  const net = writeNet(key, state, options);
  net.json("https://qbt.test/api/v2/torrents/categories", {});
  net.on("https://qbt.test/api/v2/app/version", () => new Response("v5.0.2"));
  const env = writeEnv(kv);
  const ctx: WriteCtx = { env, fetch: net.fetch, store: new Store(kv, () => NOW), now: () => NOW, origin: "https://gateway.test", cache };
  const read = async () => {
    const response = await handle(await authedRequest(key, "/v1/config/qbittorrent", AGENT()), env, { fetch: net.fetch, cache, now: NOW });
    return (await response.json()) as any;
  };
  return { ctx, read, net };
}

describe("svuotare la cache dopo le modifiche", () => {
  it("senza svuotamento la lettura resta in cache; dopo una modifica applicata mostra subito il valore nuovo", async () => {
    const { ctx, read } = setup();
    const first = await read();
    expect(first.data.qbittorrent.preferences.max_active_torrents).toBe(3);
    const second = await read();
    expect(second.cached).toBe(true);

    const plan = await propose(ctx, writer, "qbittorrent_preferences", { changes: { max_active_torrents: 10 } });
    await decide(ctx, plan.planId, "persona@example.test", true);
    await applyPlan(ctx, writer, plan.planId);

    const after = await read();
    expect(after.cached).toBeUndefined();
    expect(after.data.qbittorrent.preferences.max_active_torrents).toBe(10);
    expect((await read()).cached).toBe(true); // e torna in cache
  });

  it("dal connettore (strumento apply_plan dell'MCP) la cache si svuota allo stesso modo", async () => {
    const { ctx, read, net } = setup();
    const env = ctx.env;
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const response = await handle(
        new Request("https://gateway.test/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await signJwt(key, validClaims({ common_name: "writer-id" })) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        }),
        env,
        { fetch: net.fetch, cache, now: NOW },
      );
      const json = (await response.json()) as any;
      return { isError: Boolean(json.result?.isError), data: JSON.parse(json.result.content[0].text) };
    };
    await read();
    expect((await read()).cached).toBe(true);
    const proposed = await mcp("propose_qbittorrent_preferences", { changes: { max_active_torrents: 12 } });
    expect(proposed.isError).toBe(false);
    expect((await read()).cached).toBe(true); // la proposta non svuota
    await decide(ctx, proposed.data.planId, "persona@example.test", true);
    expect((await mcp("apply_plan", { planId: proposed.data.planId })).data.status).toBe("applied");
    const after = await read();
    expect(after.cached).toBeUndefined();
    expect(after.data.qbittorrent.preferences.max_active_torrents).toBe(12);
  });

  it("anche un'applicazione fallita svuota la cache (può aver cambiato qualcosa a metà)", async () => {
    const { ctx, read } = setup({ ignoreSetPreferences: true });
    await read();
    expect((await read()).cached).toBe(true);
    const plan = await propose(ctx, writer, "qbittorrent_preferences", { changes: { max_active_torrents: 10 } });
    await decide(ctx, plan.planId, "persona@example.test", true);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow();
    expect((await read()).cached).toBeUndefined();
  });

  it("anche quando lo stato è cambiato e la modifica non parte, la cache si svuota", async () => {
    const { ctx, read } = setup();
    await read();
    const plan = await propose(ctx, writer, "qbittorrent_preferences", { changes: { max_active_torrents: 10 } });
    await decide(ctx, plan.planId, "persona@example.test", true);
    state.prefs.max_active_torrents = 8;
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "state_changed" });
    const after = await read();
    expect(after.cached).toBeUndefined();
    expect(after.data.qbittorrent.preferences.max_active_torrents).toBe(8);
  });

  it("la proposta (che non cambia nulla) NON svuota la cache", async () => {
    const { ctx, read } = setup();
    await read();
    await propose(ctx, writer, "qbittorrent_preferences", { changes: { max_active_torrents: 10 } });
    expect((await read()).cached).toBe(true);
  });

  it("funziona anche senza cache e con una cache che dà errore", async () => {
    const { ctx } = setup();
    const plan = await propose({ ...ctx, cache: undefined }, writer, "qbittorrent_preferences", { changes: { max_active_torrents: 10 } });
    await decide(ctx, plan.planId, "persona@example.test", true);
    const broken: CacheLike = { match: async () => undefined, put: async () => {}, delete: async () => { throw new Error("cache rotta"); } };
    const done = await applyPlan({ ...ctx, cache: broken }, writer, plan.planId);
    expect(done.status).toBe("applied"); // la modifica è fatta: la cache non può farla fallire
  });
});

describe("invalidateAllSections", () => {
  it("toglie dalla cache tutte le sezioni e solo quelle", async () => {
    for (const section of SECTIONS) await withCache(cache, section.name, 60, async () => ({ status: "ok", data: { n: section.name } }));
    await cache.put(new Request("https://home-gateway.cache/v1/altro"), new Response("x"));
    for (const section of SECTIONS) expect(await cache.match(new Request(`https://home-gateway.cache/v1/${encodeURIComponent(section.name)}`))).toBeDefined();

    await invalidateAllSections(cache);

    for (const section of SECTIONS) expect(await cache.match(new Request(`https://home-gateway.cache/v1/${encodeURIComponent(section.name)}`))).toBeUndefined();
    expect(await cache.match(new Request("https://home-gateway.cache/v1/altro"))).toBeDefined();
    await expect(invalidateAllSections(undefined)).resolves.toBeUndefined();
  });
});
