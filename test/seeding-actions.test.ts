import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { applyPlan, decide, getPlanView, propose, proposeUndo, type WriteCtx } from "../src/writes";
import { FakeKv, FakeNet, JWKS_URL, makeKey, NOW, writeEnv } from "./helpers";

const CLIENT = "8b954584-bb1a-42ff-b46e-90cfd76874ab";
const RULE1 = "185b7a04-abe5-4e0b-b671-b3addd064dce";
const RULE2 = "d6c7677d-bd85-4f21-9737-52974849c4e3";

interface State {
  rules: Array<Record<string, any>>;
  puts: Array<{ url: string; body: any; key: string | null }>;
  posts: Array<{ url: string; body: any }>;
  ignoreWrites: boolean;
  corruptOthers: boolean;
  hideAction: boolean;
  indexer: Record<string, any>;
  indexerPuts: Array<{ url: string; body: any }>;
}

const SECRET = { name: "apikey", value: "chiave-indexer-segretissima" };

const fresh = (): State => ({
  rules: [
    { id: RULE1, name: "Tutte le categorie", categories: ["tv", "anime", "movies"], trackerPatterns: [], tagsAny: ["x"], tagsAll: [], priority: 1, privacyType: "Both", maxRatio: 2, minSeedTime: 48, maxSeedTime: 168, minSeeders: 0, maxInactiveDays: -1, deleteSourceFiles: true, action: "Delete" },
    { id: RULE2, name: "Unlinked Cleanup", categories: ["cleanuparr-unlinked"], trackerPatterns: [], tagsAny: [], tagsAll: [], priority: 2, privacyType: "Both", maxRatio: -1, minSeedTime: 0, maxSeedTime: 24, minSeeders: 0, maxInactiveDays: -1, deleteSourceFiles: false, action: "Delete" },
  ],
  puts: [], posts: [], ignoreWrites: false, corruptOthers: false, hideAction: false,
  indexer: {
    id: 9, name: "FutureTorrent", enable: true,
    fields: [SECRET, { name: "baseUrl", value: "http://192.168.0.9/" }, { name: "torrentBaseSettings.seedRatio", value: null }, { name: "torrentBaseSettings.seedTime", value: 60 }, { name: "torrentBaseSettings.packSeedTime", value: 120 }],
  },
  indexerPuts: [],
});

/** Come Cleanuparr: i campi omessi tornano ai valori predefiniti; le regole non coerenti sono rifiutate. */
function normalize(body: any, base: Record<string, any>): Record<string, any> {
  return {
    ...base, name: body.name ?? "", categories: body.categories ?? [], trackerPatterns: body.trackerPatterns ?? [], tagsAny: body.tagsAny ?? [], tagsAll: body.tagsAll ?? [],
    privacyType: body.privacyType ?? "Public", maxRatio: body.maxRatio ?? -1, minSeedTime: body.minSeedTime ?? 0, maxSeedTime: body.maxSeedTime ?? -1,
    minSeeders: body.minSeeders ?? 0, maxInactiveDays: body.maxInactiveDays ?? -1, deleteSourceFiles: body.deleteSourceFiles ?? true, action: body.action ?? "Delete",
  };
}
const invalid = (r: Record<string, any>) => !r.name || r.categories.length === 0 || (r.maxRatio < 0 && r.maxSeedTime < 0) || r.minSeedTime < 0;

function net(state: State, key: Awaited<ReturnType<typeof makeKey>>): FakeNet {
  const n = new FakeNet();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  n.json(JWKS_URL, { keys: [key.jwk] });
  n.on(`https://cleanuparr.test/api/seeding-rules/${CLIENT}`, async (req) => {
    if (req.method === "POST") {
      const body = await req.json();
      state.posts.push({ url: req.url, body });
      const rule = normalize(body, { id: crypto.randomUUID(), priority: Math.max(0, ...state.rules.map((r) => r.priority)) + 1 });
      if (invalid(rule)) return new Response("no", { status: 400 });
      if (!state.ignoreWrites) state.rules.push(rule);
      return json(rule, 201);
    }
    return json(state.hideAction ? state.rules.map(({ action: _a, ...rest }) => rest) : state.rules);
  });
  n.on(/^https:\/\/cleanuparr\.test\/api\/seeding-rules\/[0-9a-f-]{36}$/, async (req) => {
    const id = /([0-9a-f-]{36})$/.exec(req.url)![1]!;
    const index = state.rules.findIndex((r) => r.id === id);
    if (req.method === "PUT") {
      const body = await req.json();
      state.puts.push({ url: req.url, body, key: req.headers.get("x-api-key") });
      if (index < 0) return new Response("no", { status: 404 });
      const rule = normalize(body, { id, priority: state.rules[index]!.priority });
      if (invalid(rule)) return new Response("no", { status: 400 });
      if (state.corruptOthers) rule.trackerPatterns = ["altro.example"];
      if (!state.ignoreWrites) state.rules[index] = rule;
      return json(rule);
    }
    return new Response("no", { status: 404 });
  });
  n.on(/^https:\/\/prowlarr\.test\/api\/v1\/indexer\/9/, async (req) => {
    if (req.method === "PUT") {
      const body = await req.json();
      state.indexerPuts.push({ url: req.url, body });
      if (!state.ignoreWrites) state.indexer = body as any;
      return json(body);
    }
    return json(state.indexer);
  });
  return n;
}

let kv: FakeKv;
let state: State;
let ctx: WriteCtx;
beforeEach(async () => {
  kv = new FakeKv();
  state = fresh();
  const f = net(state, await makeKey());
  ctx = { env: writeEnv(kv, { CLEANUPARR_URL: "https://cleanuparr.test", CLEANUPARR_API_KEY: "cleanuparr-key" }), fetch: f.fetch, store: new Store(kv, () => NOW), now: () => NOW, origin: "https://gateway.test" };
});

const writer = { name: "scrittore", scopes: ["config:write"] };
const approve = (planId: string) => decide(ctx, planId, "persona@example.test", true);
async function run(action: string, input: unknown) {
  const plan = await propose(ctx, writer, action, input);
  await approve(plan.planId);
  return { plan, result: await applyPlan(ctx, writer, plan.planId) };
}
const rule1 = () => state.rules.find((r) => r.id === RULE1)!;

describe("cleanuparr_seeding_rule_update", () => {
  it("cambia solo i campi indicati e rimanda la regola intera (niente ritorno ai valori predefiniti)", async () => {
    const plan = await propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { privacyType: "Public" } });
    expect(state.puts).toHaveLength(0);
    expect(plan.changes.map((c) => [c.field, c.from, c.to])).toEqual([["privacyType", "Both", "Public"]]);
    await approve(plan.planId);
    await applyPlan(ctx, writer, plan.planId);
    expect(state.puts[0]).toMatchObject({ url: `https://cleanuparr.test/api/seeding-rules/${RULE1}`, key: "cleanuparr-key" });
    expect(rule1()).toEqual({ ...fresh().rules[0], privacyType: "Public" }); // categorie, tag, priorità, deleteSourceFiles... uguali
    expect(state.rules[1]).toEqual(fresh().rules[1]);
  });

  it("deleteSourceFiles false resta false (il valore predefinito di Cleanuparr sarebbe true)", async () => {
    await run("cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE2, changes: { maxSeedTime: 48 } });
    expect(state.rules[1]).toMatchObject({ maxSeedTime: 48, deleteSourceFiles: false });
  });

  it("annullare ripristina i valori", async () => {
    const { plan } = await run("cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { minSeedTime: 168, maxSeedTime: 336, privacyType: "Private" } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(state.rules).toEqual(fresh().rules);
  });

  it("il tempo massimo non può essere minore del minimo (rimuoverebbe prima del minimo)", async () => {
    for (const changes of [{ minSeedTime: 200 }, { minSeedTime: 100, maxSeedTime: 50 }]) {
      await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("minore del minimo") });
    }
    expect(state.puts).toHaveLength(0);
  });

  it("serve almeno un criterio: non si spengono insieme rapporto e tempo massimo", async () => {
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { maxRatio: -1, maxSeedTime: -1 } })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rifiuta valori e campi non ammessi (maxSeedTime 0 = cancella subito)", async () => {
    const bad: unknown[] = [
      { changes: { maxSeedTime: 0 } }, { changes: { maxSeedTime: -2 } }, { changes: { maxSeedTime: 9000 } }, { changes: { minSeedTime: -1 } }, { changes: { minSeedTime: 9000 } },
      { changes: { maxRatio: -2 } }, { changes: { maxRatio: 1001 } }, { changes: { maxRatio: "2" } }, { changes: { privacyType: "Tutti" } }, { changes: { action: "Remove" } },
      { changes: { deleteSourceFiles: "si" } }, { changes: { name: "x" } }, { changes: { categories: ["tv"] } }, { changes: { priority: 1 } }, { changes: { trackerPatterns: [] } },
      { changes: {} }, {},
    ];
    for (const extra of bad) await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, ...(extra as object) })).rejects.toMatchObject({ code: "invalid_input" });
    for (const input of [{ clientId: "x", ruleId: RULE1, changes: { maxRatio: 1 } }, { clientId: CLIENT, ruleId: "../etc", changes: { maxRatio: 1 } }, { clientId: CLIENT, ruleId: RULE1, changes: { maxRatio: 1 }, extra: 1 }, null]) {
      await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(kv.data.size).toBe(0);
  });

  it("maxSeedTime 0 (cancella subito) è rifiutato anche quando il minimo è 0 e la coerenza non basta", async () => {
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE2, changes: { maxSeedTime: 0 } })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("maxSeedTime") });
  });

  it("se la versione di Cleanuparr non riporta action, cambiarla è rifiutato (non verificabile)", async () => {
    state.hideAction = true;
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { action: "Stop" } })).rejects.toMatchObject({ code: "not_supported" });
    expect((await propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { maxRatio: 3 } })).status).toBe("pending");
  });

  it("un campo non modificabile accanto a uno valido blocca tutta la richiesta", async () => {
    for (const extra of [{ name: "x" }, { categories: ["tv"] }, { priority: 1 }, { trackerPatterns: ["a.it"] }]) {
      await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { maxRatio: 3, ...extra } })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("non modificabili") });
    }
  });

  it("se Cleanuparr cambia anche altri campi della regola, l'applicazione è segnalata come fallita", async () => {
    state.corruptOthers = true;
    const plan = await propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { maxRatio: 3 } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, plan.planId)).status).toBe("failed");
  });

  it("regola inesistente, nessuna modifica, deriva e verifica fallita", async () => {
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: "11111111-1111-1111-1111-111111111111", changes: { maxRatio: 3 } })).rejects.toMatchObject({ code: "not_found" });
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { maxRatio: 2 } })).rejects.toMatchObject({ code: "no_change" });

    const drift = await propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { maxRatio: 3 } });
    await approve(drift.planId);
    rule1().maxRatio = 5; // cambiata a mano nel frattempo
    await expect(applyPlan(ctx, writer, drift.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(state.puts).toHaveLength(0);

    rule1().maxRatio = 2;
    state.ignoreWrites = true;
    const failed = await propose(ctx, writer, "cleanuparr_seeding_rule_update", { clientId: CLIENT, ruleId: RULE1, changes: { maxRatio: 4 } });
    await approve(failed.planId);
    await expect(applyPlan(ctx, writer, failed.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, failed.planId)).status).toBe("failed");
  });
});

describe("cleanuparr_seeding_rule_create", () => {
  const rule = { name: "Privati", categories: ["tv", "anime", "movies"], privacyType: "Private", maxRatio: 2, minSeedTime: 168, maxSeedTime: 336 };

  it("crea la regola senza priorità (va in fondo), con i valori indicati, e la verifica", async () => {
    const plan = await propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule });
    expect(state.posts).toHaveLength(0);
    expect(plan.changes.map((c) => c.field)).toEqual(["name", "categories", "privacyType", "maxRatio", "minSeedTime", "maxSeedTime", "deleteSourceFiles", "action"]);
    await approve(plan.planId);
    expect((await applyPlan(ctx, writer, plan.planId)).status).toBe("applied");
    expect(state.posts[0]!.url).toBe(`https://cleanuparr.test/api/seeding-rules/${CLIENT}`);
    expect(state.posts[0]!.body.priority).toBeUndefined();
    expect(state.rules).toHaveLength(3);
    expect(state.rules[2]).toMatchObject({ name: "Privati", priority: 3, privacyType: "Private", maxRatio: 2, minSeedTime: 168, maxSeedTime: 336, deleteSourceFiles: true, action: "Delete" });
    expect(state.rules[0]).toEqual(fresh().rules[0]); // le altre regole non cambiano
    const audit = await ctx.store.recentAudit(10);
    expect(audit.map((e) => e.event)).toContain("applicata");
  });

  it("nome duplicato, input non valido e campi non ammessi", async () => {
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule: { ...rule, name: "tutte le categorie" } })).rejects.toMatchObject({ code: "already_exists" });
    const bad: unknown[] = [
      { ...rule, name: "" }, { ...rule, name: "x".repeat(61) }, { ...rule, name: "<script>" }, { ...rule, categories: [] }, { ...rule, categories: ["a/b"] },
      { ...rule, categories: Array.from({ length: 11 }, (_, i) => `c${i}`) }, { ...rule, trackerPatterns: ["http://x"] }, { ...rule, trackerPatterns: Array.from({ length: 11 }, (_, i) => `t${i}.it`) },
      { ...rule, privacyType: undefined }, { ...rule, privacyType: "Tutti" }, { ...rule, maxSeedTime: 0 }, { ...rule, minSeedTime: 400 },
      { ...rule, maxRatio: -1, maxSeedTime: -1 }, { ...rule, priority: 1 }, { ...rule, id: "x" }, { ...rule, tagsAny: ["x"] }, { ...rule, minSeeders: 5 },
    ];
    for (const r of bad) await expect(propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule: r })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: "x", rule })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule, extra: 1 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("privacyType è obbligatorio anche quando la chiave manca del tutto, e maxSeedTime 0 è rifiutato con minimo 0", async () => {
    const { privacyType: _omit, ...withoutPrivacy } = rule;
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule: withoutPrivacy })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("privacyType è obbligatorio") });
    await expect(propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule: { ...rule, minSeedTime: 0, maxSeedTime: 0 } })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("maxSeedTime") });
  });

  it("categorie e tracker duplicati sono uniti; i tracker validi passano", async () => {
    await run("cleanuparr_seeding_rule_create", { clientId: CLIENT, rule: { ...rule, categories: ["tv", "tv", "anime"], trackerPatterns: ["futuretorrent.org", "futuretorrent.org"] } });
    expect(state.rules[2]).toMatchObject({ categories: ["tv", "anime"], trackerPatterns: ["futuretorrent.org"] });
  });

  it("deriva (nome apparso nel frattempo) e verifica fallita", async () => {
    const plan = await propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule });
    await approve(plan.planId);
    state.rules.push({ ...fresh().rules[0], id: "22222222-2222-2222-2222-222222222222", name: "Privati", priority: 3 });
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(state.posts).toHaveLength(0);

    state.rules.pop();
    state.ignoreWrites = true;
    const failed = await propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule: { ...rule, name: "Privati 2" } });
    await approve(failed.planId);
    await expect(applyPlan(ctx, writer, failed.planId)).rejects.toThrow("Verifica fallita");
    expect((await getPlanView(ctx, failed.planId)).status).toBe("failed");
  });

  it("se la versione di Cleanuparr non riporta action, la creazione riesce lo stesso e viene verificata sul resto", async () => {
    state.hideAction = true;
    const { result } = await run("cleanuparr_seeding_rule_create", { clientId: CLIENT, rule });
    expect(result.status).toBe("applied");
    expect(state.rules[2]).toMatchObject({ name: "Privati", privacyType: "Private", maxSeedTime: 336 });
  });

  it("anche senza action riportata, un valore sbagliato negli altri campi fa fallire la verifica", async () => {
    state.hideAction = true;
    const plan = await propose(ctx, writer, "cleanuparr_seeding_rule_create", { clientId: CLIENT, rule: { ...rule, name: "Privati 3" } });
    await approve(plan.planId);
    // il finto server qui non altera la creazione: si simula un valore diverso cambiando la regola creata dopo la POST
    state.rules.push = ((...items: any[]) => Array.prototype.push.call(state.rules, ...items.map((i) => ({ ...i, maxSeedTime: 5 })))) as any;
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow("Verifica fallita");
  });

  it("non si può annullare con una proposta (la creazione non ha un annullo automatico)", async () => {
    const { plan } = await run("cleanuparr_seeding_rule_create", { clientId: CLIENT, rule });
    await expect(proposeUndo(ctx, writer, plan.planId)).rejects.toBeTruthy();
  });
});

describe("prowlarr_indexer_seed_goals", () => {
  it("imposta rapporto e tempi, conserva credenziali e indirizzi, usa forceSave, e non mostra segreti", async () => {
    const { plan } = await run("prowlarr_indexer_seed_goals", { indexerId: 9, changes: { seedRatio: 1.5, seedTimeMinutes: 10080 } });
    expect(state.indexerPuts[0]!.url).toBe("https://prowlarr.test/api/v1/indexer/9?forceSave=true");
    const fields = state.indexerPuts[0]!.body.fields as Array<{ name: string; value: unknown }>;
    expect(fields).toContainEqual(SECRET);
    expect(fields).toContainEqual({ name: "baseUrl", value: "http://192.168.0.9/" });
    expect(fields.find((f) => f.name === "torrentBaseSettings.seedRatio")!.value).toBe(1.5);
    expect(fields.find((f) => f.name === "torrentBaseSettings.seedTime")!.value).toBe(10080);
    expect(fields.find((f) => f.name === "torrentBaseSettings.packSeedTime")!.value).toBe(120); // non toccato
    const visible = JSON.stringify([plan, await getPlanView(ctx, plan.planId), await ctx.store.recentAudit(50)]);
    for (const leak of ["segretissima", "192.168", "baseUrl", "apikey"]) expect(visible).not.toContain(leak);
  });

  it("annullare ripristina i valori numerici; da 'non impostato' non c'è annullo automatico", async () => {
    const { plan } = await run("prowlarr_indexer_seed_goals", { indexerId: 9, changes: { seedTimeMinutes: 1000 } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(state.indexer.fields.find((f: any) => f.name === "torrentBaseSettings.seedTime").value).toBe(60);
    const first = await run("prowlarr_indexer_seed_goals", { indexerId: 9, changes: { seedRatio: 2 } });
    expect((await getPlanView(ctx, first.plan.planId)).canUndo).toBe(false);
  });

  it("rifiuta valori fuori limite, campi non ammessi e indexer senza quell'impostazione", async () => {
    for (const changes of [{ seedRatio: -1 }, { seedRatio: 101 }, { seedTimeMinutes: -1 }, { seedTimeMinutes: 525_601 }, { seedTimeMinutes: 1.5 }, { seedRatio: "2" }, { apikey: "x" }, { fields: [] }, { seedRatio: Infinity }, {}, { seedRatio: 1, sconosciuta: 5 }, { seedTimeMinutes: 100, "torrentBaseSettings.seedTime": 5 }]) {
      await expect(propose(ctx, writer, "prowlarr_indexer_seed_goals", { indexerId: 9, changes })).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(propose(ctx, writer, "prowlarr_indexer_seed_goals", { indexerId: 0, changes: { seedRatio: 1 } })).rejects.toMatchObject({ code: "invalid_input" });
    state.indexer.fields = [SECRET];
    await expect(propose(ctx, writer, "prowlarr_indexer_seed_goals", { indexerId: 9, changes: { seedRatio: 1 } })).rejects.toMatchObject({ code: "not_supported" });
  });

  it("nessuna modifica, deriva e verifica fallita", async () => {
    await expect(propose(ctx, writer, "prowlarr_indexer_seed_goals", { indexerId: 9, changes: { seedTimeMinutes: 60 } })).rejects.toMatchObject({ code: "no_change" });
    const drift = await propose(ctx, writer, "prowlarr_indexer_seed_goals", { indexerId: 9, changes: { seedTimeMinutes: 500 } });
    await approve(drift.planId);
    state.indexer.fields.find((f: any) => f.name === "torrentBaseSettings.seedTime").value = 99;
    await expect(applyPlan(ctx, writer, drift.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(state.indexerPuts).toHaveLength(0);
    state.indexer.fields.find((f: any) => f.name === "torrentBaseSettings.seedTime").value = 60;
    state.ignoreWrites = true;
    const failed = await propose(ctx, writer, "prowlarr_indexer_seed_goals", { indexerId: 9, changes: { seedTimeMinutes: 700 } });
    await approve(failed.planId);
    await expect(applyPlan(ctx, writer, failed.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, failed.planId)).status).toBe("failed");
  });
});
