import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { applyPlan, decide, propose, type WriteCtx } from "../src/writes";
import { FakeKv, makeKey, NOW, writeEnv, writeNet, writeState, type WriteState } from "./helpers";

/**
 * Le funzioni di scrittura controllano i permessi anche da sole, senza contare sullo strato MCP che le chiama:
 * se un giorno venissero usate da un altro punto, il permesso resterebbe obbligatorio.
 */

let kv: FakeKv;
let state: WriteState;
let ctx: WriteCtx;

beforeEach(async () => {
  kv = new FakeKv();
  state = writeState();
  const net = writeNet(await makeKey(), state);
  ctx = { env: writeEnv(kv), fetch: net.fetch, store: new Store(kv, () => NOW), now: () => NOW, origin: "https://gateway.test" };
});

const writer = { name: "scrittore", scopes: ["config:write"] };
const reader = { name: "lettore", scopes: ["media:read", "config:read"] };
const nobody = { name: "nessuno", scopes: [] as string[] };

describe("permessi nelle funzioni di scrittura", () => {
  it("propose: senza config:write non crea nessun piano e non interroga i servizi", async () => {
    for (const client of [reader, nobody]) {
      await expect(propose(ctx, client, "qbittorrent_preferences", { changes: { max_active_torrents: 10 } })).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(kv.data.size).toBe(0);
  });

  it("propose: con config:write funziona; il jolly * basta", async () => {
    expect((await propose(ctx, writer, "qbittorrent_preferences", { changes: { max_active_torrents: 10 } })).status).toBe("pending");
    expect((await propose(ctx, { name: "admin", scopes: ["*"] }, "qbittorrent_preferences", { changes: { max_active_torrents: 11 } })).status).toBe("pending");
  });

  it("apply: senza config:write non applica nemmeno un piano approvato", async () => {
    const plan = await propose(ctx, writer, "qbittorrent_preferences", { changes: { max_active_torrents: 10 } });
    await decide(ctx, plan.planId, "persona@example.test", true);
    await expect(applyPlan(ctx, reader, plan.planId)).rejects.toMatchObject({ code: "forbidden" });
    expect(state.posts).toHaveLength(0);
    expect((await applyPlan(ctx, writer, plan.planId)).status).toBe("applied");
  });

  it("azione sconosciuta", async () => {
    await expect(propose(ctx, writer, "formatta_tutto", {})).rejects.toMatchObject({ code: "unknown_action" });
  });
});
