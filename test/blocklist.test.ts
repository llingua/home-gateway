import { beforeEach, describe, expect, it } from "vitest";
import { listBlocklist } from "../src/arr-blocklist";
import { Store } from "../src/store";
import { applyPlan, decide, propose, type WriteCtx } from "../src/writes";
import { FakeKv, FakeNet, makeKey, NOW, writeEnv } from "./helpers";

/** Radarr/Sonarr finti con blocklist e coda che cambiano davvero; segreti piantati dove li mettono i servizi veri. */
const SECRET = "chiave-download-segretissima-1234567890";
interface Arr {
  blocklist: Record<string, Array<Record<string, any>>>;
  queue: Record<string, Array<Record<string, any>>>;
  deletes: string[];
  bulkBodies: unknown[];
  ignoreWrites: boolean;
}

function fresh(): Arr {
  return {
    blocklist: {
      radarr: [
        { id: 11, movieId: 486, sourceTitle: "Eddie.the.Eagle.2016.ITA.ENG.1080p.BluRay", date: "2026-11-20T10:00:00Z", quality: { quality: { name: "Bluray-1080p" } }, languages: [{ name: "Italian" }, { name: "English" }], indexer: "ilCorSaRoNeRo (Prowlarr)", protocol: "torrent", message: "Manually marked as failed", torrentInfoHash: "hash-segreto", downloadUrl: `http://192.168.0.9/dl?apikey=${SECRET}` },
        { id: 12, movieId: 486, sourceTitle: "Eddie.the.Eagle.2016.2160p.ITA", date: "2026-11-21T10:00:00Z", indexer: "X", protocol: "torrent" },
        { id: 13, movieId: 473, sourceTitle: "Crocodile.Dundee.II.1988.ITA", date: "2026-11-19T10:00:00Z" },
      ],
      sonarr: [{ id: 21, seriesId: 28, sourceTitle: "The.Big.Bang.Theory.S10E19.ITA", date: "2026-11-18T10:00:00Z" }],
    },
    queue: {
      radarr: [{ id: 501, movieId: 473, title: "Mr.Crocodile.Dundee.III.2001.iTALiAN.DVDRiP", status: "downloading", movie: { title: "Crocodile Dundee 3" }, downloadId: "hash-segreto", outputPath: "/media/downloads/x" }],
      sonarr: [{ id: 601, seriesId: 28, title: "The.Big.Bang.Theory.S11E23.ITA", status: "downloading", series: { title: "The Big Bang Theory" }, episode: { seasonNumber: 11, episodeNumber: 23 } }],
    },
    deletes: [],
    bulkBodies: [],
    ignoreWrites: false,
  };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function addArr(net: FakeNet, arr: Arr) {
  net.on(/^https:\/\/(radarr|sonarr)\.test\/api\/v3\/(movie|series)$/, () => json([{ id: 486, title: "Eddie the Eagle" }, { id: 473, title: "Crocodile Dundee 3" }, { id: 28, title: "The Big Bang Theory" }]));
  net.on(/^https:\/\/(radarr|sonarr)\.test\/api\/v3\/blocklist/, async (request) => {
    const service = /https:\/\/(\w+)\.test/.exec(request.url)![1]!;
    if (request.method === "DELETE") {
      const body = (await request.json()) as { ids: number[] };
      arr.bulkBodies.push(body);
      if (!arr.ignoreWrites) arr.blocklist[service] = arr.blocklist[service]!.filter((e) => !body.ids.includes(e.id));
      return new Response(null, { status: 200 });
    }
    return json({ page: 1, totalRecords: arr.blocklist[service]!.length, records: arr.blocklist[service] });
  });
  net.on(/^https:\/\/(radarr|sonarr)\.test\/api\/v3\/queue/, (request) => {
    const service = /https:\/\/(\w+)\.test/.exec(request.url)![1]!;
    if (request.method === "DELETE") {
      arr.deletes.push(request.url);
      const id = Number(/queue\/(\d+)/.exec(request.url)![1]);
      const item = arr.queue[service]!.find((q) => q.id === id);
      if (item && !arr.ignoreWrites) {
        arr.queue[service] = arr.queue[service]!.filter((q) => q.id !== id);
        arr.blocklist[service]!.unshift({ id: 99, movieId: item.movieId, seriesId: item.seriesId, sourceTitle: item.title, date: "2026-11-27T12:00:00Z" });
      }
      return new Response(null, { status: 200 });
    }
    return json({ page: 1, totalRecords: arr.queue[service]!.length, records: arr.queue[service] });
  });
}

let arr: Arr;
let net: FakeNet;
let ctx: WriteCtx;
beforeEach(async () => {
  arr = fresh();
  net = new FakeNet();
  addArr(net, arr);
  const kv = new FakeKv();
  await makeKey();
  ctx = { env: writeEnv(kv), fetch: net.fetch, store: new Store(kv, () => NOW), now: () => NOW, origin: "https://gateway.test" };
});

const writer = { name: "scrittore", scopes: ["config:write"] };
async function run(action: string, input: unknown) {
  const plan = await propose(ctx, writer, action, input);
  await decide(ctx, plan.planId, "persona@example.test", true);
  return { plan, result: await applyPlan(ctx, writer, plan.planId) };
}
const writes = () => net.calls.filter((c) => c.method !== "GET");

describe("get_blocklist (lettura)", () => {
  it("elenca con titolo, uscita, motivo; filtra per titolo o id; nessun segreto, hash o indirizzo", async () => {
    const all = await listBlocklist(ctx, { service: "radarr" });
    expect(all.total).toBe(3);
    expect(all.entries[0]).toEqual({ id: 11, date: "2026-11-20T10:00:00Z", release: "Eddie.the.Eagle.2016.ITA.ENG.1080p.BluRay", title: "Eddie the Eagle", mediaId: 486, quality: "Bluray-1080p", languages: ["Italian", "English"], indexer: "ilCorSaRoNeRo (Prowlarr)", protocol: "torrent", message: "Manually marked as failed" });
    expect((await listBlocklist(ctx, { service: "radarr", query: "eddie eagle" })).total).toBe(2);
    expect((await listBlocklist(ctx, { service: "radarr", mediaId: 473 })).entries.map((e) => e.id)).toEqual([13]);
    const text = JSON.stringify(all);
    for (const leak of [SECRET, "hash-segreto", "192.168", "apikey"]) expect(text).not.toContain(leak);
    expect(writes()).toHaveLength(0);
  });
});

describe("arr_blocklist_remove", () => {
  it("la proposta non scrive; l'applicazione toglie esattamente gli id e verifica", async () => {
    const plan = await propose(ctx, writer, "arr_blocklist_remove", { service: "radarr", ids: [12, 11, 11] });
    expect(writes()).toHaveLength(0);
    expect(plan.changes.map((c) => c.field)).toEqual(["#11 Eddie the Eagle: Eddie.the.Eagle.2016.ITA.ENG.1080p.BluRay", "#12 Eddie the Eagle: Eddie.the.Eagle.2016.2160p.ITA"]);
    await decide(ctx, plan.planId, "persona@example.test", true);
    expect((await applyPlan(ctx, writer, plan.planId)).status).toBe("applied");
    expect(arr.bulkBodies).toEqual([{ ids: [11, 12] }]);
    expect(arr.blocklist.radarr!.map((e) => e.id)).toEqual([13]);
    expect(arr.blocklist.sonarr).toHaveLength(1); // l'altro servizio non è toccato
  });

  it("id inesistente, troppi id, campi in più: rifiutati senza scrivere", async () => {
    await expect(propose(ctx, writer, "arr_blocklist_remove", { service: "radarr", ids: [11, 777] })).rejects.toThrow("777");
    await expect(propose(ctx, writer, "arr_blocklist_remove", { service: "radarr", ids: Array.from({ length: 51 }, (_, i) => i + 1) })).rejects.toThrow();
    await expect(propose(ctx, writer, "arr_blocklist_remove", { service: "radarr", ids: [11], path: "/x" })).rejects.toThrow();
    await expect(propose(ctx, writer, "arr_blocklist_remove", { service: "proxmox", ids: [11] })).rejects.toThrow();
    expect(writes()).toHaveLength(0);
  });

  it("se intanto la voce è già sparita, non applica", async () => {
    const plan = await propose(ctx, writer, "arr_blocklist_remove", { service: "sonarr", ids: [21] });
    await decide(ctx, plan.planId, "persona@example.test", true);
    arr.blocklist.sonarr = [];
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(arr.bulkBodies).toHaveLength(0);
  });

  it("verifica fallita se il servizio non toglie la voce", async () => {
    arr.ignoreWrites = true;
    const plan = await propose(ctx, writer, "arr_blocklist_remove", { service: "radarr", ids: [13] });
    await decide(ctx, plan.planId, "persona@example.test", true);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "apply_failed" });
  });
});

describe("arr_blocklist_add (da un download in coda)", () => {
  it("toglie dalla coda e dal client, mette in blocklist, fa cercare un'alternativa; verifica", async () => {
    const { plan, result } = await run("arr_blocklist_add", { service: "radarr", queueId: 501 });
    expect(plan.changes[0]).toMatchObject({ field: "Crocodile Dundee 3: Mr.Crocodile.Dundee.III.2001.iTALiAN.DVDRiP", from: "in coda" });
    expect(result.status).toBe("applied");
    expect(arr.deletes).toEqual(["https://radarr.test/api/v3/queue/501?removeFromClient=true&blocklist=true&skipRedownload=false"]);
    expect(arr.blocklist.radarr![0]).toMatchObject({ sourceTitle: "Mr.Crocodile.Dundee.III.2001.iTALiAN.DVDRiP" });
    expect(JSON.stringify(plan)).not.toContain("hash-segreto");
  });

  it("removeFromClient: false lascia il torrent nel client", async () => {
    const { plan } = await run("arr_blocklist_add", { service: "sonarr", queueId: 601, removeFromClient: false });
    expect(plan.changes[0]!.field).toBe("The Big Bang Theory S11E23: The.Big.Bang.Theory.S11E23.ITA");
    expect(arr.deletes[0]).toContain("removeFromClient=false&blocklist=true");
  });

  it("elemento non in coda: rifiutato; verifica fallita se il servizio non lo blocca", async () => {
    await expect(propose(ctx, writer, "arr_blocklist_add", { service: "radarr", queueId: 999 })).rejects.toThrow("999");
    arr.ignoreWrites = true;
    const plan = await propose(ctx, writer, "arr_blocklist_add", { service: "radarr", queueId: 501 });
    await decide(ctx, plan.planId, "persona@example.test", true);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "apply_failed" });
  });
});
