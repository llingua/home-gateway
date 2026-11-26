import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { applyPlan, decide, getPlanView, propose, type WriteCtx } from "../src/writes";
import { FakeKv, FakeNet, JWKS_URL, makeKey, NOW, writeEnv } from "./helpers";

interface Row { id: number; title: string; profileId: number | null; path: string }
interface State {
  series: Row[];
  movies: Row[];
  profiles: any[];
  posts: Array<{ url: string; form: URLSearchParams; key: string | null; type: string | null }>;
  ignorePost: boolean;
  wrongProfile: boolean;
  ignoreFilter: boolean;
  ignoreLength: boolean;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const rows = (n: number, withProfile = 0, offset = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: offset + i + 1, title: `Titolo ${String(offset + i + 1).padStart(3, "0")}`, profileId: i < withProfile ? 2 : null, path: `/media/library/segreto/${offset + i + 1}` }));

const fresh = (): State => ({
  series: rows(130, 10),
  movies: rows(5),
  profiles: [{ profileId: 1, name: "Italiano", items: [{ id: 1, language: "it" }] }, { profileId: 2, name: "Inglese", items: [] }],
  posts: [], ignorePost: false, wrongProfile: false, ignoreFilter: false, ignoreLength: false,
});

function net(s: State, key: Awaited<ReturnType<typeof makeKey>>): FakeNet {
  const n = new FakeNet();
  n.json(JWKS_URL, { keys: [key.jwk] });
  n.json("https://bazarr.test/api/system/languages/profiles", s.profiles);
  for (const kind of ["series", "movies"] as const) {
    const idKey = kind === "series" ? "sonarrSeriesId" : "radarrId";
    const idsParam = kind === "series" ? "seriesid[]" : "radarrid[]";
    const formIds = kind === "series" ? "seriesid" : "radarrid";
    n.on(new RegExp(`^https://bazarr\\.test/api/${kind}(\\?|$)`), async (req) => {
      if (req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        s.posts.push({ url: req.url, form, key: req.headers.get("x-api-key"), type: req.headers.get("content-type") });
        const ids = form.getAll(formIds).map(Number);
        const profiles = form.getAll("profileid");
        if (profiles.length < ids.length) return new Response("IndexError", { status: 500 }); // come Bazarr: coppie per posizione
        if (!s.ignorePost) ids.forEach((id, i) => { const row = s[kind].find((r) => r.id === id); if (row) row.profileId = s.wrongProfile ? 99 : Number(profiles[i]); });
        return new Response(null, { status: 204 });
      }
      const url = new URL(req.url);
      let list = [...s[kind]].sort((a, b) => a.title.localeCompare(b.title));
      if (url.searchParams.get("profileid") === "none" && !s.ignoreFilter) list = list.filter((r) => r.profileId === null);
      const wanted = url.searchParams.getAll(idsParam).map(Number);
      if (wanted.length) list = list.filter((r) => wanted.includes(r.id));
      const start = Number(url.searchParams.get("start") ?? 0);
      const length = s.ignoreLength && !wanted.length ? -1 : Number(url.searchParams.get("length") ?? -1);
      const page = length > 0 ? list.slice(start, start + length) : list.slice(start);
      return json({ data: page.map((r) => ({ [idKey]: r.id, title: r.title, profileId: r.profileId, path: r.path, overview: "trama" })), total: list.length });
    });
  }
  return n;
}

let kv: FakeKv;
let state: State;
let ctx: WriteCtx;
beforeEach(async () => {
  kv = new FakeKv();
  state = fresh();
  const f = net(state, await makeKey());
  ctx = { env: writeEnv(kv, { BAZARR_URL: "https://bazarr.test", BAZARR_API_KEY: "bazarr-key" }), fetch: f.fetch, store: new Store(kv, () => NOW), now: () => NOW, origin: "https://gateway.test" };
});

const writer = { name: "scrittore", scopes: ["config:write"] };
const approve = (id: string) => decide(ctx, id, "persona@example.test", true);
const rejects = (input: unknown, code = "invalid_input") => expect(propose(ctx, writer, "bazarr_assign_profile", input)).rejects.toMatchObject({ code });

describe("bazarr_assign_profile", () => {
  it("la proposta elenca i primi 100 senza profilo (per titolo) e non scrive; nessun percorso nel piano", async () => {
    const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "series", profileId: 1 });
    expect(state.posts).toHaveLength(0);
    expect(plan.changes).toHaveLength(100);
    expect(plan.changes[0]).toMatchObject({ target: 'Bazarr: serie "Titolo 011"', field: "profileId[11]", from: null, to: 1 }); // le prime 10 hanno già il profilo 2
    expect(plan.summary).toBe('Bazarr: assegna il profilo "Italiano" a 100 serie senza profilo (ne restano altri 20: si ripropone)');
    const visible = JSON.stringify([plan, await getPlanView(ctx, plan.planId)]);
    expect(visible).not.toContain("segreto");
    expect(visible).not.toContain("trama");
  });

  it("applica ESATTAMENTE i 100 approvati, in coppia id/profilo, e non tocca né gli altri né quelli con un profilo già assegnato", async () => {
    const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "series", profileId: 1 });
    const approved = plan.changes.map((c) => Number(/\[(\d+)\]/.exec(c.field)![1]));
    await approve(plan.planId);
    // dopo l'approvazione compare una serie nuova senza profilo: non deve essere toccata
    state.series.push({ id: 999, title: "Aaa Nuova", profileId: null, path: "/x" });
    const done = await applyPlan(ctx, writer, plan.planId);
    expect(done.status).toBe("applied");
    expect(state.posts).toHaveLength(1);
    const post = state.posts[0]!;
    expect(post.url).toBe("https://bazarr.test/api/series");
    expect(post.key).toBe("bazarr-key");
    expect(post.type).toBe("application/x-www-form-urlencoded");
    expect(post.form.getAll("seriesid").map(Number)).toEqual(approved);
    expect(post.form.getAll("profileid")).toEqual(approved.map(() => "1"));
    expect(state.series.filter((r) => r.profileId === 1).map((r) => r.id).sort((a, b) => a - b)).toEqual([...approved].sort((a, b) => a - b));
    expect(state.series.filter((r) => r.profileId === 2)).toHaveLength(10); // già assegnati: intatti
    expect(state.series.find((r) => r.id === 999)!.profileId).toBeNull();
    expect(state.series.filter((r) => r.profileId === null && r.id !== 999)).toHaveLength(20); // restano da fare
  });

  it("anche se Bazarr ignora il filtro, non si toccano elementi che hanno già un profilo", async () => {
    state.ignoreFilter = true;
    const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "series", profileId: 1 });
    const ids = plan.changes.map((c) => Number(/\[(\d+)\]/.exec(c.field)![1]));
    expect(ids.every((id) => state.series.find((r) => r.id === id)!.profileId === null)).toBe(true);
    await approve(plan.planId);
    await applyPlan(ctx, writer, plan.planId);
    expect(state.series.filter((r) => r.profileId === 2)).toHaveLength(10);
  });

  it("anche se Bazarr ignora il limite di elementi, il piano non supera 100", async () => {
    state.ignoreLength = true;
    state.series = rows(300);
    const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "series", profileId: 1 });
    expect(plan.changes).toHaveLength(100);
    await approve(plan.planId);
    await applyPlan(ctx, writer, plan.planId);
    expect(state.series.filter((r) => r.profileId === 1)).toHaveLength(100);
    expect(state.posts[0]!.form.getAll("seriesid")).toHaveLength(100);
  });

  it("si ripropone per i rimanenti e si arriva a zero; poi non c'è più niente da assegnare", async () => {
    for (let i = 0; i < 2; i += 1) {
      const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "series", profileId: 1 });
      await approve(plan.planId);
      await applyPlan(ctx, writer, plan.planId);
    }
    expect(state.series.filter((r) => r.profileId === null)).toHaveLength(0);
    await rejects({ target: "series", profileId: 1 }, "no_change");
  });

  it("film: usa radarrid e radarrId", async () => {
    const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "movies", profileId: 2 });
    expect(plan.changes).toHaveLength(5);
    await approve(plan.planId);
    await applyPlan(ctx, writer, plan.planId);
    expect(state.posts[0]!.url).toBe("https://bazarr.test/api/movies");
    expect(state.posts[0]!.form.getAll("radarrid")).toHaveLength(5);
    expect(state.movies.every((m) => m.profileId === 2)).toBe(true);
  });

  it("deriva: un elemento approvato ha già ricevuto un profilo, o è sparito: non si applica", async () => {
    const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "movies", profileId: 1 });
    await approve(plan.planId);
    state.movies[0]!.profileId = 2;
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(state.posts).toHaveLength(0);

    state.movies[0]!.profileId = null;
    const second = await propose(ctx, writer, "bazarr_assign_profile", { target: "movies", profileId: 1 });
    await approve(second.planId);
    state.movies.splice(1, 1);
    await expect(applyPlan(ctx, writer, second.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(state.posts).toHaveLength(0);
  });

  it("profilo inesistente, input non valido", async () => {
    await rejects({ target: "series", profileId: 77 });
    const bad: unknown[] = [{ target: "episodi", profileId: 1 }, { target: "series", profileId: 0 }, { target: "series", profileId: -1 }, { target: "series", profileId: 1.5 }, { target: "series", profileId: "1" }, { target: "series" }, { profileId: 1 }, { target: "series", profileId: 1, extra: 1 }, { target: "series", profileId: 1, ids: [1] }, null];
    for (const input of bad) await rejects(input);
    expect(kv.data.size).toBe(0);
  });

  it("verifica fallita: Bazarr non applica o applica un altro profilo", async () => {
    state.ignorePost = true;
    const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "movies", profileId: 1 });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow("Verifica fallita");
    expect((await getPlanView(ctx, plan.planId)).status).toBe("failed");

    state.ignorePost = false;
    state.wrongProfile = true;
    const second = await propose(ctx, writer, "bazarr_assign_profile", { target: "movies", profileId: 1 });
    await approve(second.planId);
    await expect(applyPlan(ctx, writer, second.planId)).rejects.toThrow("Verifica fallita");
  });

  it("senza chiave Bazarr non propone nulla", async () => {
    const noKey = { ...ctx, env: writeEnv(kv, { BAZARR_URL: "https://bazarr.test", BAZARR_API_KEY: undefined }) };
    await expect(propose(noKey, writer, "bazarr_assign_profile", { target: "series", profileId: 1 })).rejects.toThrow();
  });

  it("i titoli con caratteri di controllo sono ripuliti", async () => {
    state.movies[0]!.title = "Film\u0000\n<b>x</b>";
    const plan = await propose(ctx, writer, "bazarr_assign_profile", { target: "movies", profileId: 1 });
    expect(JSON.stringify(plan)).not.toMatch(/\\u0000|\\n/);
  });
});
