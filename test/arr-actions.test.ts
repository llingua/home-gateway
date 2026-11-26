import { beforeEach, describe, expect, it } from "vitest";
import { ACTIONS } from "../src/actions";
import { Store } from "../src/store";
import { applyPlan, decide, getPlanView, propose, proposeUndo, type WriteCtx } from "../src/writes";
import { FakeKv, makeKey, NOW, writeEnv, writeNet, writeState, type FakeNet, type WriteState } from "./helpers";

/** Radarr e Sonarr finti, con stato che cambia davvero e segreti piantati dove li mette il servizio vero. */
interface ArrState {
  objects: Record<string, Record<string, any>>; // "service/resource/id" -> oggetto
  puts: Array<{ url: string; body: any }>;
  ignorePut: boolean;
}

const SECRET_INDEXER = { name: "apiKey", value: "chiave-indexer-segretissima" };
const SECRET_CLIENT = { name: "password", value: "password-client-segretissima" };

function freshArr(): ArrState {
  const objects: ArrState["objects"] = {};
  for (const service of ["radarr", "sonarr"]) {
    objects[`${service}/delayprofile/1`] = { id: 1, enableUsenet: true, enableTorrent: true, preferredProtocol: "torrent", usenetDelay: 0, torrentDelay: 30, bypassIfHighestQuality: false, bypassIfAboveCustomFormatScore: false, minimumCustomFormatScore: 0, order: 2147483647, tags: [] };
    objects[`${service}/indexer/4`] = { id: 4, name: "Prowlarr (Torznab)", enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, priority: 25, tags: [], fields: [SECRET_INDEXER, { name: "baseUrl", value: "http://192.168.0.9:9696/1/" }] };
    objects[`${service}/downloadclient/7`] = { id: 7, name: "qBittorrent", enable: true, priority: 1, removeCompletedDownloads: false, removeFailedDownloads: false, tags: [], fields: [{ name: "username", value: "admin-user" }, SECRET_CLIENT] };
    objects[`${service}/qualityprofile/7`] = {
      id: 7, name: "HD-1080p", upgradeAllowed: true, cutoff: 1001, minFormatScore: 0, cutoffFormatScore: 100, minUpgradeFormatScore: 1,
      items: [{ id: 1001, name: "WEB 1080p", allowed: true, items: [] }],
      formatItems: [{ format: 11, name: "x265 (HD)", score: -100 }, { format: 12, name: "Repack/Proper", score: 5 }, { format: 13, name: "Extra", score: 0 }],
    };
  }
  return { objects, puts: [], ignorePut: false };
}

function addArr(net: FakeNet, arr: ArrState): void {
  net.on(/^https:\/\/(radarr|sonarr)\.test\/api\/v3\/(delayprofile|indexer|downloadclient|qualityprofile)\/(\d+)/, async (request) => {
    const [, service, resource, id] = /https:\/\/(\w+)\.test\/api\/v3\/(\w+)\/(\d+)/.exec(request.url)!;
    const key = `${service}/${resource}/${id}`;
    if (request.method === "PUT") {
      const body = await request.json();
      arr.puts.push({ url: request.url, body });
      if (!arr.ignorePut && arr.objects[key]) arr.objects[key] = body as any;
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }
    const object = arr.objects[key];
    return object ? new Response(JSON.stringify(object), { headers: { "Content-Type": "application/json" } }) : new Response("no", { status: 404 });
  });
}

let kv: FakeKv;
let state: WriteState;
let arr: ArrState;
let ctx: WriteCtx;
let net: FakeNet;

beforeEach(async () => {
  kv = new FakeKv();
  state = writeState();
  arr = freshArr();
  net = writeNet(await makeKey(), state);
  addArr(net, arr);
  ctx = { env: writeEnv(kv), fetch: net.fetch, store: new Store(kv, () => NOW), now: () => NOW, origin: "https://gateway.test" };
});

const writer = { name: "scrittore", scopes: ["config:write"] };
const approve = (planId: string) => decide(ctx, planId, "persona@example.test", true);
const get = (service: string, resource: string, id: number) => arr.objects[`${service}/${resource}/${id}`]!;
async function run(action: string, input: unknown) {
  const plan = await propose(ctx, writer, action, input);
  await approve(plan.planId);
  return { plan, result: await applyPlan(ctx, writer, plan.planId) };
}

describe("arr_delay_profile", () => {
  it("la proposta non scrive; l'applicazione cambia solo i campi indicati e verifica", async () => {
    const plan = await propose(ctx, writer, "arr_delay_profile", { service: "sonarr", id: 1, changes: { torrentDelay: 0, bypassIfHighestQuality: true } });
    expect(arr.puts).toHaveLength(0);
    expect(plan.changes.map((c) => [c.field, c.from, c.to])).toEqual([["torrentDelay", 30, 0], ["bypassIfHighestQuality", false, true]]);
    await approve(plan.planId);
    const done = await applyPlan(ctx, writer, plan.planId);
    expect(done.status).toBe("applied");
    expect(arr.puts).toHaveLength(1);
    expect(arr.puts[0]!.url).toBe("https://sonarr.test/api/v3/delayprofile/1");
    expect(arr.puts[0]!.body).toEqual({ ...freshArr().objects["sonarr/delayprofile/1"], torrentDelay: 0, bypassIfHighestQuality: true });
    expect(get("radarr", "delayprofile", 1).torrentDelay).toBe(30); // l'altro servizio non è toccato
  });

  it("si può annullare con una nuova proposta", async () => {
    const { plan } = await run("arr_delay_profile", { service: "radarr", id: 1, changes: { preferredProtocol: "usenet", usenetDelay: 60 } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(get("radarr", "delayprofile", 1)).toMatchObject({ preferredProtocol: "torrent", usenetDelay: 0 });
  });

  it("rifiuta valori fuori limite, campi sconosciuti e input malformato", async () => {
    const bad: unknown[] = [
      { service: "sonarr", id: 1, changes: { torrentDelay: -1 } },
      { service: "sonarr", id: 1, changes: { torrentDelay: 99999 } },
      { service: "sonarr", id: 1, changes: { preferredProtocol: "ftp" } },
      { service: "sonarr", id: 1, changes: { order: 5 } },
      { service: "sonarr", id: 1, changes: { tags: [1] } },
      { service: "sonarr", id: 1, changes: { enableTorrent: "si" } },
      { service: "sonarr", id: 1, changes: {} },
      { service: "lidarr", id: 1, changes: { enableTorrent: true } },
      { service: "proxmox", id: 1, changes: { enableTorrent: true } },
      { service: "sonarr", id: 0, changes: { enableTorrent: true } },
      { service: "sonarr", id: 1.5, changes: { enableTorrent: true } },
      { service: "sonarr", id: 1, changes: { enableTorrent: true }, extra: 1 },
      { service: "sonarr", id: 1 },
      null,
    ];
    for (const input of bad) await expect(propose(ctx, writer, "arr_delay_profile", input)).rejects.toMatchObject({ code: "invalid_input" });
    expect(kv.data.size).toBe(0);
  });

  it("nessuna modifica e profilo inesistente", async () => {
    await expect(propose(ctx, writer, "arr_delay_profile", { service: "sonarr", id: 1, changes: { torrentDelay: 30 } })).rejects.toMatchObject({ code: "no_change" });
    await expect(propose(ctx, writer, "arr_delay_profile", { service: "sonarr", id: 99, changes: { torrentDelay: 0 } })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("arr_indexer_flags e arr_download_client_flags", () => {
  it("indexer: cambia i flag, usa forceSave e conserva le credenziali, che non compaiono mai nel piano", async () => {
    const plan = await propose(ctx, writer, "arr_indexer_flags", { service: "radarr", id: 4, changes: { enableRss: false, priority: 10 } });
    await approve(plan.planId);
    await applyPlan(ctx, writer, plan.planId);
    expect(arr.puts[0]!.url).toBe("https://radarr.test/api/v3/indexer/4?forceSave=true");
    expect(arr.puts[0]!.body.fields).toContainEqual(SECRET_INDEXER); // il segreto passa solo dal gateway al servizio
    expect(arr.puts[0]!.body).toMatchObject({ enableRss: false, priority: 10, enableAutomaticSearch: true });
    const visible = JSON.stringify([plan, await getPlanView(ctx, plan.planId), await ctx.store.recentAudit(50)]);
    for (const leak of ["segretissima", "192.168", "baseUrl"]) expect(visible).not.toContain(leak);
  });

  it("client di download: attiva/disattiva e rimozione dei falliti, credenziali conservate", async () => {
    await run("arr_download_client_flags", { service: "sonarr", id: 7, changes: { enable: false, removeFailedDownloads: true } });
    expect(arr.puts[0]!.url).toBe("https://sonarr.test/api/v3/downloadclient/7?forceSave=true");
    expect(arr.puts[0]!.body.fields).toContainEqual(SECRET_CLIENT);
    expect(get("sonarr", "downloadclient", 7)).toMatchObject({ enable: false, removeFailedDownloads: true, removeCompletedDownloads: false });
  });

  it("priorità fuori limite e campi di credenziali rifiutati", async () => {
    for (const changes of [{ priority: 0 }, { priority: 51 }, { fields: [] }, { name: "x" }, { implementation: "Torznab" }]) {
      await expect(propose(ctx, writer, "arr_indexer_flags", { service: "sonarr", id: 4, changes })).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(propose(ctx, writer, "arr_download_client_flags", { service: "sonarr", id: 7, changes: { password: "x" } })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("se il servizio non applica la modifica, il piano risulta fallito", async () => {
    arr.ignorePut = true;
    const plan = await propose(ctx, writer, "arr_indexer_flags", { service: "radarr", id: 4, changes: { enableRss: false } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, plan.planId)).status).toBe("failed");
  });

  it("se lo stato cambia dopo la proposta, non si applica", async () => {
    const plan = await propose(ctx, writer, "arr_indexer_flags", { service: "radarr", id: 4, changes: { enableRss: false } });
    await approve(plan.planId);
    get("radarr", "indexer", 4).enableRss = false; // qualcuno l'ha già cambiato a mano
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(arr.puts).toHaveLength(0);
  });
});

describe("arr_quality_profile", () => {
  it("soglie e punteggi: cambia solo ciò che è indicato e lascia gli altri formati com'erano", async () => {
    const { plan } = await run("arr_quality_profile", { service: "radarr", id: 7, changes: { minFormatScore: -50, upgradeAllowed: false }, scores: { "11": 0, "12": 10 } });
    expect(plan.changes.map((c) => c.field)).toEqual(["minFormatScore", "upgradeAllowed", "score[11] x265 (HD)", "score[12] Repack/Proper"]);
    const body = arr.puts[0]!.body;
    expect(arr.puts[0]!.url).toBe("https://radarr.test/api/v3/qualityprofile/7");
    expect(body).toMatchObject({ minFormatScore: -50, upgradeAllowed: false, cutoffFormatScore: 100 });
    expect(body.formatItems).toEqual([{ format: 11, name: "x265 (HD)", score: 0 }, { format: 12, name: "Repack/Proper", score: 10 }, { format: 13, name: "Extra", score: 0 }]);
    expect(body.items).toEqual(freshArr().objects["radarr/qualityprofile/7"]!.items);
  });

  it("annullare ripristina soglie e punteggi", async () => {
    const { plan } = await run("arr_quality_profile", { service: "sonarr", id: 7, changes: { cutoffFormatScore: 50 }, scores: { "11": 500 } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(get("sonarr", "qualityprofile", 7)).toEqual(freshArr().objects["sonarr/qualityprofile/7"]);
  });

  it("solo formati già presenti, punteggi nei limiti, max 30", async () => {
    await expect(propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7, scores: { "99": 5 } })).rejects.toMatchObject({ code: "invalid_input" });
    for (const scores of [{ "11": 10001 }, { "11": -10001 }, { "11": 1.5 }, { "11": "5" }, { "abc": 1 }, { "-1": 1 }, [1], Object.fromEntries(Array.from({ length: 31 }, (_, i) => [String(i + 1), 1]))]) {
      await expect(propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7, scores })).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const changes of [{ cutoff: 5 }, { items: [] }, { name: "x" }, { minUpgradeFormatScore: 0 }, { cutoffFormatScore: -1 }]) {
      await expect(propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7, changes })).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(arr.puts).toHaveLength(0);
  });

  it("il tetto di 30 punteggi vale anche quando i formati esistono davvero", async () => {
    const profile = get("radarr", "qualityprofile", 7);
    profile.formatItems = Array.from({ length: 40 }, (_, i) => ({ format: i + 1, name: `F${i + 1}`, score: 0 }));
    const make = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), 5]));
    await expect(propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7, scores: make(31) })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("30") });
    expect((await propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7, scores: make(30) })).status).toBe("pending");
  });

  it("se il servizio non applica i punteggi, il piano risulta fallito", async () => {
    arr.ignorePut = true;
    const plan = await propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7, scores: { "11": 0 } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, plan.planId)).status).toBe("failed");
  });

  it("nessuna modifica se i punteggi sono già questi", async () => {
    await expect(propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7, scores: { "11": -100 } })).rejects.toMatchObject({ code: "no_change" });
  });

  it("deriva: se il punteggio cambia dopo la proposta, non si applica", async () => {
    const plan = await propose(ctx, writer, "arr_quality_profile", { service: "radarr", id: 7, scores: { "11": 0 } });
    await approve(plan.planId);
    get("radarr", "qualityprofile", 7).formatItems[0].score = 42;
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(arr.puts).toHaveLength(0);
  });
});

describe("qBittorrent: nuove impostazioni", () => {
  it("accetta interi e vero/falso, e le impostazioni non elencate restano vietate", async () => {
    state.prefs = { ...state.prefs, dont_count_slow_torrents: false, slow_torrent_dl_rate_threshold: 2, max_connec: 500 };
    await run("qbittorrent_preferences", { changes: { dont_count_slow_torrents: true, slow_torrent_dl_rate_threshold: 50, max_connec: 300 } });
    expect(state.posts[0]).toEqual({ dont_count_slow_torrents: true, slow_torrent_dl_rate_threshold: 50, max_connec: 300 });
    for (const changes of [{ web_ui_password: "x" }, { save_path: "/" }, { max_ratio_act: 1 }, { max_ratio_enabled: true }, { dont_count_slow_torrents: 1 }, { queueing_enabled: "true" }, { max_connec: 0 }, { max_connec: 5001 }, { max_active_checking_torrents: 11 }, { slow_torrent_inactive_timer: 0 }]) {
      await expect(propose(ctx, writer, "qbittorrent_preferences", { changes })).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("annullare ripristina anche i booleani", async () => {
    state.prefs = { ...state.prefs, dont_count_slow_torrents: false };
    const { plan } = await run("qbittorrent_preferences", { changes: { dont_count_slow_torrents: true } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(state.prefs.dont_count_slow_torrents).toBe(false);
  });
});

describe("elenco delle azioni", () => {
  it("contiene le nuove azioni e nessuna tocca Proxmox", () => {
    expect(ACTIONS.map((a) => a.name)).toEqual(expect.arrayContaining(["arr_delay_profile", "arr_indexer_flags", "arr_download_client_flags", "arr_quality_profile"]));
    for (const action of ACTIONS) expect(action.services as string[]).not.toContain("proxmox");
  });
});
