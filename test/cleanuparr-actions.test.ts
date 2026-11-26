import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { applyPlan, decide, getPlanView, propose, proposeUndo, type WriteCtx } from "../src/writes";
import { FakeKv, FakeNet, JWKS_URL, makeKey, NOW, writeEnv } from "./helpers";

interface Cleanuparr {
  general: Record<string, any>;
  arr: Record<string, Record<string, any>>;
  puts: Array<{ url: string; body: any; key: string | null }>;
  ignorePut: boolean;
}

const fresh = (): Cleanuparr => ({
  general: {
    displaySupportBanner: true, dryRun: false, httpMaxRetries: 0, httpTimeout: 100, httpCertificateValidation: "Enabled", httpSendUserAgent: false,
    statusCheckEnabled: true, ignoredDownloads: [], connectivityCheckEnabled: false, connectivityCheckUrls: ["http://1.1.1.1"],
    strikeInactivityWindowHours: 24, historyRetentionDays: 365,
    log: { level: "Information", rollingSizeMB: 10, retainedFileCount: 5 },
    auth: { disableAuthForLocalAddresses: true, trustForwardedHeaders: false, trustedNetworks: ["192.168.0.0/24"] },
  },
  arr: {
    sonarr: { id: "a1", type: "Sonarr", failedImportMaxStrikes: -1, instances: [{ id: "i1", name: "Sonarr", url: "http://sonarr-interno:8989", apiKey: "b".repeat(32) }] },
    radarr: { id: "a2", type: "Radarr", failedImportMaxStrikes: -1, instances: [{ id: "i2", name: "Radarr", url: "http://radarr-interno:7878", apiKey: "c".repeat(32) }] },
  },
  puts: [],
  ignorePut: false,
});

function cleanuparrNet(state: Cleanuparr, key: Awaited<ReturnType<typeof makeKey>>): FakeNet {
  const net = new FakeNet();
  net.json(JWKS_URL, { keys: [key.jwk] });
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
  net.on("https://cleanuparr.test/api/configuration/general", async (req) => {
    if (req.method === "PUT") {
      const body = (await req.json()) as Record<string, any>;
      state.puts.push({ url: req.url, body, key: req.headers.get("x-api-key") });
      if (!state.ignorePut) state.general = body;
      return json({ Message: "ok" });
    }
    return json(state.general);
  });
  net.on(/^https:\/\/cleanuparr\.test\/api\/configuration\/(sonarr|radarr)$/, async (req) => {
    const type = /(sonarr|radarr)$/.exec(req.url)![1]!;
    if (req.method === "PUT") {
      const body = (await req.json()) as Record<string, any>;
      state.puts.push({ url: req.url, body, key: req.headers.get("x-api-key") });
      const v = body.failedImportMaxStrikes;
      if (v === 1 || v === 2 || v < -1) return new Response("no", { status: 400 });
      if (!state.ignorePut) state.arr[type]!.failedImportMaxStrikes = v; // la PUT cambia solo questo campo
      return json({ Message: "ok" });
    }
    return json(state.arr[type]);
  });
  return net;
}

let kv: FakeKv;
let state: Cleanuparr;
let ctx: WriteCtx;
beforeEach(async () => {
  kv = new FakeKv();
  state = fresh();
  const net = cleanuparrNet(state, await makeKey());
  ctx = { env: writeEnv(kv, { CLEANUPARR_URL: "https://cleanuparr.test", CLEANUPARR_API_KEY: "cleanuparr-key" }), fetch: net.fetch, store: new Store(kv, () => NOW), now: () => NOW, origin: "https://gateway.test" };
});

const writer = { name: "scrittore", scopes: ["config:write"] };
const approve = (planId: string) => decide(ctx, planId, "persona@example.test", true);
async function run(action: string, input: unknown) {
  const plan = await propose(ctx, writer, action, input);
  await approve(plan.planId);
  return { plan, result: await applyPlan(ctx, writer, plan.planId) };
}

describe("cleanuparr_general", () => {
  it("la proposta non scrive; l'applicazione rimanda tutto l'oggetto cambiando solo i campi indicati", async () => {
    const plan = await propose(ctx, writer, "cleanuparr_general", { changes: { httpMaxRetries: 3, connectivityCheckEnabled: true } });
    expect(state.puts).toHaveLength(0);
    expect(plan.changes.map((c) => [c.field, c.from, c.to])).toEqual([["httpMaxRetries", 0, 3], ["connectivityCheckEnabled", false, true]]);
    await approve(plan.planId);
    expect((await applyPlan(ctx, writer, plan.planId)).status).toBe("applied");
    const sent = state.puts[0]!;
    expect(sent.key).toBe("cleanuparr-key");
    expect(sent.body).toEqual({ ...fresh().general, httpMaxRetries: 3, connectivityCheckEnabled: true });
    expect(sent.body.auth.trustedNetworks).toEqual(["192.168.0.0/24"]); // ciò che non si tocca resta
    expect(sent.body.log).toEqual(fresh().general.log);
  });

  it("reti fidate e indirizzi non compaiono mai nel piano, nella vista né nel registro", async () => {
    const { plan } = await run("cleanuparr_general", { changes: { httpMaxRetries: 2 } });
    const visible = JSON.stringify([plan, await getPlanView(ctx, plan.planId), await ctx.store.recentAudit(50)]);
    for (const leak of ["192.168", "trustedNetworks", "1.1.1.1"]) expect(visible).not.toContain(leak);
  });

  it("annullare ripristina i valori", async () => {
    const { plan } = await run("cleanuparr_general", { changes: { httpMaxRetries: 3, statusCheckEnabled: false } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(state.general).toEqual(fresh().general);
  });

  it("rifiuta limiti, tipi, impostazioni non ammesse (dry run, accesso, reti, log)", async () => {
    const bad: unknown[] = [
      { changes: { httpMaxRetries: -1 } }, { changes: { httpMaxRetries: 11 } }, { changes: { httpTimeout: 9 } }, { changes: { httpTimeout: 601 } },
      { changes: { strikeInactivityWindowHours: 0 } }, { changes: { strikeInactivityWindowHours: 169 } }, { changes: { historyRetentionDays: 0 } },
      { changes: { connectivityCheckEnabled: "si" } }, { changes: { httpMaxRetries: 1.5 } },
      { changes: { dryRun: true } }, { changes: { auth: { trustedNetworks: [] } } }, { changes: { trustedNetworks: [] } }, { changes: { log: {} } },
      { changes: { connectivityCheckUrls: ["http://x"] } }, { changes: {} }, {}, { changes: { httpMaxRetries: 1 }, extra: 1 }, null,
    ];
    for (const input of bad) await expect(propose(ctx, writer, "cleanuparr_general", input)).rejects.toMatchObject({ code: "invalid_input" });
    expect(kv.data.size).toBe(0);
  });

  it("non si accende il controllo di connettività senza indirizzi di controllo", async () => {
    state.general.connectivityCheckUrls = [];
    await expect(propose(ctx, writer, "cleanuparr_general", { changes: { connectivityCheckEnabled: true } })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("indirizzi di controllo") });
    expect((await propose(ctx, writer, "cleanuparr_general", { changes: { connectivityCheckEnabled: false, httpMaxRetries: 1 } })).status).toBe("pending");
  });

  it("nessuna modifica, deriva e verifica fallita", async () => {
    await expect(propose(ctx, writer, "cleanuparr_general", { changes: { httpMaxRetries: 0 } })).rejects.toMatchObject({ code: "no_change" });

    const plan = await propose(ctx, writer, "cleanuparr_general", { changes: { httpMaxRetries: 3 } });
    await approve(plan.planId);
    state.general.httpMaxRetries = 1; // cambiato a mano nel frattempo
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(state.puts).toHaveLength(0);

    state.ignorePut = true;
    const second = await propose(ctx, writer, "cleanuparr_general", { changes: { httpMaxRetries: 4 } });
    await approve(second.planId);
    await expect(applyPlan(ctx, writer, second.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, second.planId)).status).toBe("failed");
  });

  it("senza chiave Cleanuparr non propone nulla", async () => {
    const noKey = { ...ctx, env: writeEnv(kv, { CLEANUPARR_URL: "https://cleanuparr.test" }) };
    await expect(propose(noKey, writer, "cleanuparr_general", { changes: { httpMaxRetries: 3 } })).rejects.toThrow();
    expect(state.puts).toHaveLength(0);
  });
});

describe("cleanuparr_arr_failed_import", () => {
  it("cambia solo la soglia e manda solo quel campo (istanze con indirizzi e chiavi non toccate)", async () => {
    await run("cleanuparr_arr_failed_import", { service: "radarr", failedImportMaxStrikes: 0 });
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0]).toMatchObject({ url: "https://cleanuparr.test/api/configuration/radarr", body: { failedImportMaxStrikes: 0 }, key: "cleanuparr-key" });
    expect(Object.keys(state.puts[0]!.body)).toEqual(["failedImportMaxStrikes"]);
    expect(state.arr.radarr!.failedImportMaxStrikes).toBe(0);
    expect(state.arr.sonarr!.failedImportMaxStrikes).toBe(-1);
    expect(state.arr.radarr!.instances[0].apiKey).toBe("c".repeat(32));
  });

  it("valori ammessi: -1, 0, 3..100; 1, 2 e il resto sono rifiutati", async () => {
    for (const value of [1, 2, -2, 101, 3.5, "5", null, undefined]) {
      await expect(propose(ctx, writer, "cleanuparr_arr_failed_import", { service: "sonarr", failedImportMaxStrikes: value })).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const value of [0, 3, 5, 100]) expect((await propose(ctx, writer, "cleanuparr_arr_failed_import", { service: "sonarr", failedImportMaxStrikes: value })).status).toBe("pending");
  });

  it("servizio e campi extra", async () => {
    for (const input of [{ service: "lidarr", failedImportMaxStrikes: 5 }, { service: "proxmox", failedImportMaxStrikes: 5 }, { failedImportMaxStrikes: 5 }, { service: "sonarr", failedImportMaxStrikes: 5, url: "http://x" }, { service: "sonarr", failedImportMaxStrikes: 5, apiKey: "x" }]) {
      await expect(propose(ctx, writer, "cleanuparr_arr_failed_import", input)).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("annullare, nessuna modifica, deriva e verifica", async () => {
    const { plan } = await run("cleanuparr_arr_failed_import", { service: "sonarr", failedImportMaxStrikes: 5 });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(state.arr.sonarr!.failedImportMaxStrikes).toBe(-1);

    await expect(propose(ctx, writer, "cleanuparr_arr_failed_import", { service: "sonarr", failedImportMaxStrikes: -1 })).rejects.toMatchObject({ code: "no_change" });

    const drift = await propose(ctx, writer, "cleanuparr_arr_failed_import", { service: "sonarr", failedImportMaxStrikes: 4 });
    await approve(drift.planId);
    state.arr.sonarr!.failedImportMaxStrikes = 0;
    await expect(applyPlan(ctx, writer, drift.planId)).rejects.toMatchObject({ code: "state_changed" });

    state.arr.sonarr!.failedImportMaxStrikes = -1;
    state.ignorePut = true;
    const failed = await propose(ctx, writer, "cleanuparr_arr_failed_import", { service: "sonarr", failedImportMaxStrikes: 6 });
    await approve(failed.planId);
    await expect(applyPlan(ctx, writer, failed.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, failed.planId)).status).toBe("failed");
  });
});

