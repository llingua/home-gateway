import { beforeEach, describe, expect, it } from "vitest";
import { ACTIONS } from "../src/actions";
import { Store } from "../src/store";
import { applyPlan, decide, getPlanView, propose, proposeUndo, type WriteCtx } from "../src/writes";
import { FakeKv, FakeNet, JWKS_URL, makeKey, NOW, writeEnv } from "./helpers";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ============================================================ stato dei finti servizi
interface World {
  plex: { prefs: Record<string, any>; puts: string[]; ignorePut: boolean };
  seerr: { main: Record<string, any>; mainPosts: any[]; servers: { radarr: any[]; sonarr: any[] }; serverPuts: any[]; ignoreWrite: boolean; dropApiKey: boolean };
  bazarr: { general: Record<string, any>; languages: Array<{ code2: string; enabled: boolean }>; profiles: any[]; forms: URLSearchParams[]; ignorePost: boolean; damageProfiles: boolean; damageLanguages: boolean; resetLanguagesWhenAbsent: boolean };
}

const API_KEY_SEERR = "seerr-chiave-segretissima-1234567890";
const fresh = (): World => ({
  plex: {
    prefs: { TranscodeCountLimit: 0, OnDeckWindow: 16, TranscoderThrottleBuffer: 60, TranscoderH264BackgroundPreset: "veryfast", HardwareAcceleratedCodecs: true, ScheduledLibraryUpdatesEnabled: false, ScheduledLibraryUpdateInterval: 86400, FSEventLibraryUpdatesEnabled: true, autoEmptyTrash: true, ButlerStartHour: 2, ButlerEndHour: 5, ButlerTaskBackupDatabase: true, WanTotalMaxUploadRate: 0, RelayEnabled: true, TranscoderTempDirectory: "/transcode", PlexOnlineToken: "plex-token-segretissimo" },
    puts: [], ignorePut: false,
  },
  seerr: {
    main: { apiKey: API_KEY_SEERR, applicationTitle: "Seerr", applicationUrl: "https://seerr.interno.example", partialRequestsEnabled: true, hideAvailable: false, localLogin: true, mediaServerLogin: true, newPlexLogin: true, cacheImages: false, versionCheck: true, defaultPermissions: 32 },
    mainPosts: [], serverPuts: [], ignoreWrite: false, dropApiKey: false,
    servers: {
      radarr: [{ id: 0, name: "Radarr", hostname: "192.168.0.171", port: 7878, apiKey: "radarr-chiave-segretissima-1234567890", useSsl: false, baseUrl: "/radarr", activeProfileId: 9, activeProfileName: "2160p Quality (IT)", activeDirectory: "/media/library/Movies", is4k: false, minimumAvailability: "released", isDefault: true, tags: [], syncEnabled: true, preventSearch: false, tagRequests: false, overrideRule: [] }],
      sonarr: [{ id: 0, name: "Sonarr", hostname: "192.168.0.171", port: 8989, apiKey: "sonarr-chiave-segretissima-1234567890", useSsl: false, activeProfileId: 10, activeProfileName: "1080p Quality", activeDirectory: "/media/library/TV", activeAnimeProfileId: 8, activeAnimeProfileName: "Anime HD", activeAnimeDirectory: "/media/library/Anime", is4k: false, isDefault: true, tags: [1], animeTags: [2], seriesType: "standard", animeSeriesType: "anime", enableSeasonFolders: true, monitorNewItems: "all", syncEnabled: true, preventSearch: false, tagRequests: false, overrideRule: [] }],
    },
  },
  bazarr: {
    general: { serie_default_enabled: false, serie_default_profile: "", movie_default_enabled: false, movie_default_profile: "", minimum_score: 90, minimum_score_movie: 70, upgrade_subs: true, upgrade_manual: true, days_to_upgrade_subs: 7, upgrade_frequency: 12, wanted_search_frequency: 6, wanted_search_frequency_movie: 6, adaptive_searching: true, adaptive_searching_delay: "3w", adaptive_searching_delta: "1w", use_scenename: true, single_language: false, utf8_encode: true, apikey: "bazarr-chiave-segretissima-1234567890" },
    languages: [{ code2: "it", enabled: true }, { code2: "en", enabled: true }, { code2: "fr", enabled: false }],
    profiles: [{ profileId: 1, name: "Italiano", cutoff: null, items: [{ id: 1, language: "it", hi: "False", forced: "False" }], mustContain: [], mustNotContain: [], originalFormat: 0 }, { profileId: 2, name: "Inglese", cutoff: null, items: [], mustContain: [], mustNotContain: [], originalFormat: 0 }],
    forms: [], ignorePost: false, damageProfiles: false, damageLanguages: false, resetLanguagesWhenAbsent: true,
  },
});

function net(w: World, key: Awaited<ReturnType<typeof makeKey>>): FakeNet {
  const n = new FakeNet();
  n.json(JWKS_URL, { keys: [key.jwk] });

  // --- Plex
  n.on(/^https:\/\/plex\.test\/:\/prefs/, async (req) => {
    if (req.method === "PUT") {
      const url = new URL(req.url);
      w.plex.puts.push(url.search);
      if (!w.plex.ignorePut) {
        for (const [k, v] of url.searchParams) {
          const old = w.plex.prefs[k];
          w.plex.prefs[k] = typeof old === "boolean" ? v === "1" : typeof old === "number" ? Number(v) : v;
        }
      }
      return new Response("", { status: 200 });
    }
    return json({ MediaContainer: { Setting: Object.entries(w.plex.prefs).map(([id, value]) => ({ id, value })) } });
  });

  // --- Seerr
  n.on("https://seerr.test/api/v1/settings/main", async (req) => {
    if (req.method === "POST") {
      const body = await req.json();
      w.seerr.mainPosts.push(body);
      if (!w.seerr.ignoreWrite) Object.assign(w.seerr.main, body);
      return json(w.seerr.main); // come Seerr: la risposta contiene la chiave
    }
    return json(w.seerr.main);
  });
  for (const service of ["radarr", "sonarr"] as const) {
    n.on(new RegExp(`^https://seerr\\.test/api/v1/settings/${service}(/\\d+)?$`), async (req) => {
      const id = /\/(\d+)$/.exec(req.url)?.[1];
      if (req.method === "PUT") {
        const body = (await req.json()) as any;
        w.seerr.serverPuts.push({ service, id, body });
        if ("id" in body) return new Response("request.body.id is read-only", { status: 400 }); // come la validazione di Seerr
        const i = w.seerr.servers[service].findIndex((s) => String(s.id) === id);
        if (i < 0) return new Response("no", { status: 404 });
        if (!w.seerr.ignoreWrite) w.seerr.servers[service][i] = { ...body, id: Number(id) }; // sostituzione completa
        return json(w.seerr.servers[service][i]);
      }
      const list = w.seerr.servers[service].map((s) => (w.seerr.dropApiKey ? { ...s, apiKey: undefined } : s));
      return json(list);
    });
  }
  n.json("https://radarr.test/api/v3/qualityprofile", [{ id: 9, name: "2160p Quality (IT)" }, { id: 4, name: "HD-1080p" }]);
  n.json("https://sonarr.test/api/v3/qualityprofile", [{ id: 10, name: "1080p Quality" }, { id: 8, name: "Anime HD" }, { id: 3, name: "HD-720p" }]);

  // --- Bazarr
  n.on("https://bazarr.test/api/system/settings", async (req) => {
    if (req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      w.bazarr.forms.push(form);
      const sent = form.getAll("languages-enabled");
      if (w.bazarr.resetLanguagesWhenAbsent && sent.length === 0) w.bazarr.languages.forEach((l) => (l.enabled = false)); // il comportamento temuto
      if (sent.length) w.bazarr.languages.forEach((l) => (l.enabled = sent.includes(l.code2)));
      const parsed: Record<string, any> = {};
      for (const [k, v] of form) {
        const m = /^settings-general-(.+)$/.exec(k);
        if (!m) continue;
        parsed[m[1]!] = v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v;
      }
      const bad = (parsed.minimum_score !== undefined && (parsed.minimum_score < 0 || parsed.minimum_score > 100)) || (parsed.wanted_search_frequency !== undefined && ![6, 12, 24, 168, 876000].includes(parsed.wanted_search_frequency));
      if (bad) return new Response("validation", { status: 406 });
      if (!w.bazarr.ignorePost) Object.assign(w.bazarr.general, parsed);
      if (w.bazarr.damageProfiles) w.bazarr.profiles = [];
      if (w.bazarr.damageLanguages) w.bazarr.languages.forEach((l) => (l.enabled = false));
      return new Response(null, { status: 204 });
    }
    return json({ general: w.bazarr.general, auth: { username: "admin", password: "password-segreta" } });
  });
  n.on("https://bazarr.test/api/system/languages/profiles", () => json(w.bazarr.profiles));
  n.on("https://bazarr.test/api/system/languages", () => json(w.bazarr.languages));
  return n;
}

let kv: FakeKv;
let w: World;
let ctx: WriteCtx;
let f: FakeNet;
beforeEach(async () => {
  kv = new FakeKv();
  w = fresh();
  f = net(w, await makeKey());
  ctx = {
    env: writeEnv(kv, { PLEX_URL: "https://plex.test", PLEX_TOKEN: "plex-token", OVERSEERR_URL: "https://seerr.test", OVERSEERR_API_KEY: "seerr-key", BAZARR_URL: "https://bazarr.test", BAZARR_API_KEY: "bazarr-key" }),
    fetch: f.fetch, store: new Store(kv, () => NOW), now: () => NOW, origin: "https://gateway.test",
  };
});

const writer = { name: "scrittore", scopes: ["config:write"] };
const approve = (id: string) => decide(ctx, id, "persona@example.test", true);
async function run(action: string, input: unknown) {
  const plan = await propose(ctx, writer, action, input);
  await approve(plan.planId);
  return { plan, result: await applyPlan(ctx, writer, plan.planId) };
}
const visible = async (planId: string) => JSON.stringify([await getPlanView(ctx, planId), await ctx.store.recentAudit(50)]);
const rejects = (action: string, input: unknown, code = "invalid_input") => expect(propose(ctx, writer, action, input)).rejects.toMatchObject({ code });

// ============================================================ Plex
describe("plex_preferences", () => {
  it("cambia le preferenze (bool come 1/0, numeri, testo) e verifica; il resto resta com'è", async () => {
    const { plan } = await run("plex_preferences", { changes: { TranscodeCountLimit: 3, ScheduledLibraryUpdatesEnabled: true, TranscoderH264BackgroundPreset: "fast", RelayEnabled: false } });
    expect(plan.changes.map((c) => [c.field, c.from, c.to])).toEqual([["TranscodeCountLimit", 0, 3], ["ScheduledLibraryUpdatesEnabled", false, true], ["TranscoderH264BackgroundPreset", "veryfast", "fast"], ["RelayEnabled", true, false]]);
    expect(w.plex.puts).toHaveLength(1);
    const q = new URLSearchParams(w.plex.puts[0]);
    expect(Object.fromEntries(q)).toEqual({ TranscodeCountLimit: "3", ScheduledLibraryUpdatesEnabled: "1", TranscoderH264BackgroundPreset: "fast", RelayEnabled: "0" });
    expect(w.plex.prefs).toMatchObject({ TranscodeCountLimit: 3, ScheduledLibraryUpdatesEnabled: true, RelayEnabled: false, TranscoderTempDirectory: "/transcode", PlexOnlineToken: "plex-token-segretissimo" });
    const calls = f.calls.filter((c) => c.url.startsWith("https://plex.test"));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(calls.every((c) => c.headers.get("x-plex-token") === "plex-token" && c.redirect === "manual")).toBe(true);
  });

  it("annullare ripristina; il token e gli altri valori non compaiono mai", async () => {
    const { plan } = await run("plex_preferences", { changes: { OnDeckWindow: 20, ButlerStartHour: 3, autoEmptyTrash: false } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(w.plex.prefs).toMatchObject({ ButlerStartHour: 2, autoEmptyTrash: true });
    for (const leak of ["segretissimo", "/transcode"]) expect(await visible(plan.planId)).not.toContain(leak);
  });

  it("rifiuta percorsi, account, reti, accesso remoto e valori fuori limite", async () => {
    const bad: unknown[] = [
      { changes: { TranscoderTempDirectory: "/tmp/x" } }, { changes: { PlexOnlineToken: "x" } }, { changes: { allowedNetworks: "x" } }, { changes: { secureConnections: 0 } },
      { changes: { allowMediaDeletion: true } }, { changes: { TranscodeCountLimit: -1 } }, { changes: { TranscodeCountLimit: 51 } }, { changes: { TranscoderThrottleBuffer: 9 } },
      { changes: { ButlerStartHour: 24 } }, { changes: { OnDeckWindow: 0 } }, { changes: { WanTotalMaxUploadRate: 1_000_001 } }, { changes: { ScheduledLibraryUpdateInterval: 899 } },
      { changes: { TranscoderH264BackgroundPreset: "placebo" } }, { changes: { RelayEnabled: 1 } }, { changes: { autoEmptyTrash: "si" } }, { changes: { __proto__x: 1, constructor: 1 } },
      { changes: {} }, {}, { changes: { RelayEnabled: true }, extra: 1 }, null,
    ];
    for (const input of bad) await rejects("plex_preferences", input);
    expect(kv.data.size).toBe(0);
  });

  it("impostazione assente, nessuna modifica, deriva e verifica fallita", async () => {
    delete w.plex.prefs.ButlerEndHour;
    await rejects("plex_preferences", { changes: { ButlerEndHour: 10 } }, "not_supported");
    await rejects("plex_preferences", { changes: { TranscodeCountLimit: 0 } }, "no_change");
    const drift = await propose(ctx, writer, "plex_preferences", { changes: { TranscodeCountLimit: 4 } });
    await approve(drift.planId);
    w.plex.prefs.TranscodeCountLimit = 9;
    await expect(applyPlan(ctx, writer, drift.planId)).rejects.toMatchObject({ code: "state_changed" });
    expect(w.plex.puts).toHaveLength(0);
    w.plex.prefs.TranscodeCountLimit = 0;
    w.plex.ignorePut = true;
    const failed = await propose(ctx, writer, "plex_preferences", { changes: { TranscodeCountLimit: 5 } });
    await approve(failed.planId);
    await expect(applyPlan(ctx, writer, failed.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, failed.planId)).status).toBe("failed");
  });
});

// ============================================================ Seerr
describe("seerr_main_settings", () => {
  it("invia solo i campi indicati e non espone mai la chiave API (presente nella risposta di Seerr)", async () => {
    const { plan } = await run("seerr_main_settings", { changes: { hideAvailable: true, cacheImages: true } });
    expect(w.seerr.mainPosts).toEqual([{ hideAvailable: true, cacheImages: true }]);
    expect(w.seerr.main).toMatchObject({ hideAvailable: true, cacheImages: true, localLogin: true, mediaServerLogin: true, apiKey: API_KEY_SEERR });
    expect(await visible(plan.planId)).not.toContain("segretissima");
    expect(JSON.stringify(plan)).not.toContain("segretissima");
  });

  it("annullare ripristina", async () => {
    const { plan } = await run("seerr_main_settings", { changes: { partialRequestsEnabled: false } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(w.seerr.main.partialRequestsEnabled).toBe(true);
  });

  it("rifiuta accessi (rischio di restare chiusi fuori), permessi, indirizzi, chiave e valori non booleani", async () => {
    const bad: unknown[] = [
      { changes: { localLogin: false } }, { changes: { mediaServerLogin: false } }, { changes: { defaultPermissions: 2 } }, { changes: { apiKey: "x" } },
      { changes: { applicationUrl: "https://x" } }, { changes: { applicationTitle: "x" } }, { changes: { hideAvailable: "si" } }, { changes: { hideAvailable: 1 } }, { changes: {} }, {}, null,
      { changes: { hideAvailable: true }, extra: 1 },
    ];
    for (const input of bad) await rejects("seerr_main_settings", input);
  });

  it("nessuna modifica, deriva e verifica fallita", async () => {
    await rejects("seerr_main_settings", { changes: { hideAvailable: false } }, "no_change");
    const drift = await propose(ctx, writer, "seerr_main_settings", { changes: { hideAvailable: true } });
    await approve(drift.planId);
    w.seerr.main.hideAvailable = true;
    await expect(applyPlan(ctx, writer, drift.planId)).rejects.toMatchObject({ code: "state_changed" });
    w.seerr.main.hideAvailable = false;
    w.seerr.ignoreWrite = true;
    const failed = await propose(ctx, writer, "seerr_main_settings", { changes: { hideAvailable: true } });
    await approve(failed.planId);
    await expect(applyPlan(ctx, writer, failed.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, failed.planId)).status).toBe("failed");
  });
});

describe("seerr_server_settings", () => {
  it("rimanda l'oggetto intero (chiave, indirizzo, cartelle comprese) cambiando solo il campo; il nome del profilo lo legge il gateway", async () => {
    const { plan } = await run("seerr_server_settings", { service: "radarr", id: 0, changes: { activeProfileId: 4, minimumAvailability: "inCinemas" } });
    const sent = w.seerr.serverPuts[0]!;
    expect(sent).toMatchObject({ service: "radarr", id: "0" });
    const { id: _id, ...expected } = fresh().seerr.servers.radarr[0];
    expect(sent.body).toEqual({ ...expected, activeProfileId: 4, activeProfileName: "HD-1080p", minimumAvailability: "inCinemas" });
    expect("id" in sent.body).toBe(false);
    expect(w.seerr.servers.radarr[0]).toMatchObject({ apiKey: "radarr-chiave-segretissima-1234567890", hostname: "192.168.0.171", activeDirectory: "/media/library/Movies", baseUrl: "/radarr" });
    expect(w.seerr.servers.sonarr[0]).toEqual(fresh().seerr.servers.sonarr[0]);
    const text = await visible(plan.planId);
    for (const leak of ["segretissima", "192.168", "/radarr", "/media/library"]) expect(text).not.toContain(leak);
  });

  it("Sonarr: profilo anime con nome, tipo di serie, cartelle per stagione", async () => {
    await run("seerr_server_settings", { service: "sonarr", id: 0, changes: { activeAnimeProfileId: 3, seriesType: "daily", enableSeasonFolders: false, monitorNewItems: "none" } });
    expect(w.seerr.servers.sonarr[0]).toMatchObject({ activeAnimeProfileId: 3, activeAnimeProfileName: "HD-720p", seriesType: "daily", enableSeasonFolders: false, monitorNewItems: "none", activeProfileName: "1080p Quality" });
  });

  it("annullare ripristina anche il nome del profilo", async () => {
    const { plan } = await run("seerr_server_settings", { service: "radarr", id: 0, changes: { activeProfileId: 4 } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(w.seerr.servers.radarr[0]).toEqual(fresh().seerr.servers.radarr[0]);
  });

  it("profilo inesistente, campi non ammessi (cartelle, indirizzi, chiave), campi dell'altro servizio, id e servizio non validi", async () => {
    await rejects("seerr_server_settings", { service: "radarr", id: 0, changes: { activeProfileId: 77 } });
    const bad: unknown[] = [
      { service: "radarr", id: 0, changes: { activeDirectory: "/x" } }, { service: "radarr", id: 0, changes: { hostname: "x" } }, { service: "radarr", id: 0, changes: { apiKey: "x" } },
      { service: "radarr", id: 0, changes: { isDefault: false } }, { service: "radarr", id: 0, changes: { seriesType: "daily" } }, { service: "sonarr", id: 0, changes: { minimumAvailability: "released" } },
      { service: "radarr", id: 0, changes: { minimumAvailability: "mai" } }, { service: "radarr", id: 0, changes: { syncEnabled: "si" } }, { service: "radarr", id: 0, changes: { activeProfileId: 0 } },
      { service: "lidarr", id: 0, changes: { syncEnabled: false } }, { service: "radarr", id: -1, changes: { syncEnabled: false } }, { service: "radarr", id: 1001, changes: { syncEnabled: false } },
      { service: "radarr", id: 0, changes: {} }, { service: "radarr", id: 0, changes: { syncEnabled: false }, extra: 1 }, { service: "radarr", changes: { syncEnabled: false } }, null,
    ];
    for (const input of bad) await rejects("seerr_server_settings", input);
    expect(w.seerr.serverPuts).toHaveLength(0);
  });

  it("server inesistente, nessuna modifica, deriva e verifica fallita", async () => {
    await rejects("seerr_server_settings", { service: "radarr", id: 5, changes: { syncEnabled: false } }, "not_found");
    await rejects("seerr_server_settings", { service: "radarr", id: 0, changes: { syncEnabled: true } }, "no_change");
    const drift = await propose(ctx, writer, "seerr_server_settings", { service: "radarr", id: 0, changes: { preventSearch: true } });
    await approve(drift.planId);
    w.seerr.servers.radarr[0].preventSearch = true;
    await expect(applyPlan(ctx, writer, drift.planId)).rejects.toMatchObject({ code: "state_changed" });
    w.seerr.servers.radarr[0].preventSearch = false;
    w.seerr.ignoreWrite = true;
    const failed = await propose(ctx, writer, "seerr_server_settings", { service: "radarr", id: 0, changes: { preventSearch: true } });
    await approve(failed.planId);
    await expect(applyPlan(ctx, writer, failed.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, failed.planId)).status).toBe("failed");
  });

  it("se Seerr non mostra la chiave del server, non scrive (la PUT la cancellerebbe)", async () => {
    w.seerr.dropApiKey = true;
    const plan = await propose(ctx, writer, "seerr_server_settings", { service: "radarr", id: 0, changes: { preventSearch: true } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "apikey_unavailable" });
    expect(w.seerr.serverPuts).toHaveLength(0);
  });

  it("se la scrittura cambia anche altro (es. un campo sparisce), l'applicazione risulta fallita", async () => {
    // il finto Seerr perde `tags` quando riceve la PUT
    const base = ctx.fetch;
    ctx = { ...ctx, fetch: async (url, init) => {
      const res = await base(url, init);
      if (init?.method === "PUT" && String(url).includes("/settings/radarr/")) delete w.seerr.servers.radarr[0].tags;
      return res;
    } };
    const plan = await propose(ctx, writer, "seerr_server_settings", { service: "radarr", id: 0, changes: { preventSearch: true } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, plan.planId)).status).toBe("failed");
  });
});

// ============================================================ Bazarr
describe("bazarr_general", () => {
  const CHANGE = { serie_default_enabled: true, serie_default_profile: 1, movie_default_enabled: true, movie_default_profile: 1 };

  it("attiva il profilo predefinito: modulo con chiavi settings-general-*, valori testuali, lingue attive rimandate identiche", async () => {
    const plan = await propose(ctx, writer, "bazarr_general", { changes: CHANGE });
    expect(w.bazarr.forms).toHaveLength(0);
    expect(plan.changes.map((c) => [c.field, c.from, c.to])).toEqual([["serie_default_enabled", false, true], ["serie_default_profile", "", 1], ["movie_default_enabled", false, true], ["movie_default_profile", "", 1]]);
    await approve(plan.planId);
    expect((await applyPlan(ctx, writer, plan.planId)).status).toBe("applied");
    const form = w.bazarr.forms[0]!;
    expect(Object.fromEntries([...form].filter(([k]) => k !== "languages-enabled"))).toEqual({
      "settings-general-serie_default_enabled": "true", "settings-general-serie_default_profile": "1", "settings-general-movie_default_enabled": "true", "settings-general-movie_default_profile": "1",
    });
    expect(form.getAll("languages-enabled")).toEqual(["it", "en"]);
    expect(form.has("languages-profiles")).toBe(false);
    expect(w.bazarr.general).toMatchObject({ serie_default_enabled: true, serie_default_profile: 1, movie_default_profile: 1, minimum_score: 90 });
    expect(w.bazarr.languages.filter((l) => l.enabled).map((l) => l.code2)).toEqual(["it", "en"]);
    expect(w.bazarr.profiles).toHaveLength(2);
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(post.headers.get("x-api-key")).toBe("bazarr-key");
  });

  it("senza rimandare le lingue il finto Bazarr le disattiverebbe: il gateway le rimanda sempre", async () => {
    await run("bazarr_general", { changes: { minimum_score: 80 } });
    expect(w.bazarr.languages.filter((l) => l.enabled)).toHaveLength(2);
  });

  it("se le lingue attive non si leggono, non scrive", async () => {
    (f as any).handlers.unshift([/^https:\/\/bazarr\.test\/api\/system\/languages$/, () => new Response("no", { status: 500 })]);
    const plan = await propose(ctx, writer, "bazarr_general", { changes: { minimum_score: 80 } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow();
    expect(w.bazarr.forms).toHaveLength(0);
  });

  it("se le lingue attive arrivano in un formato inatteso (risposta 200 ma non un elenco), non scrive", async () => {
    (f as any).handlers.unshift([/^https:\/\/bazarr\.test\/api\/system\/languages$/, () => json({ error: "boh" })]);
    const plan = await propose(ctx, writer, "bazarr_general", { changes: { minimum_score: 80 } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toMatchObject({ code: "languages_unavailable" });
    expect(w.bazarr.forms).toHaveLength(0);
  });

  it("se Bazarr disattiva delle lingue durante la scrittura, il piano risulta fallito", async () => {
    w.bazarr.damageLanguages = true;
    const plan = await propose(ctx, writer, "bazarr_general", { changes: { minimum_score: 80 } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow("lingue attive");
    expect((await getPlanView(ctx, plan.planId)).status).toBe("failed");
  });

  it("se Bazarr cambia profili o lingue durante la scrittura, il piano risulta fallito", async () => {
    w.bazarr.damageProfiles = true;
    const plan = await propose(ctx, writer, "bazarr_general", { changes: { minimum_score: 80 } });
    await approve(plan.planId);
    await expect(applyPlan(ctx, writer, plan.planId)).rejects.toThrow("profili lingua");
    expect((await getPlanView(ctx, plan.planId)).status).toBe("failed");
  });

  it("profilo inesistente, valori e campi non ammessi", async () => {
    await rejects("bazarr_general", { changes: { serie_default_profile: 99 } });
    const bad: unknown[] = [
      { changes: { minimum_score: 101 } }, { changes: { minimum_score: -1 } }, { changes: { days_to_upgrade_subs: 31 } }, { changes: { wanted_search_frequency: 876000 } }, { changes: { wanted_search_frequency: 7 } },
      { changes: { adaptive_searching_delay: "9w" } }, { changes: { upgrade_subs: "si" } }, { changes: { serie_default_profile: "1" } }, { changes: { serie_default_profile: 0 } }, { changes: { serie_default_profile: "" } },
      { changes: { enabled_providers: ["x"] } }, { changes: { apikey: "x" } }, { changes: { use_sonarr: false } }, { changes: { postprocessing_cmd: "rm -rf /" } }, { changes: { "languages-profiles": "[]" } },
      { changes: {} }, {}, { changes: { minimum_score: 80 }, extra: 1 }, null,
    ];
    for (const input of bad) await rejects("bazarr_general", input);
    expect(w.bazarr.forms).toHaveLength(0);
  });

  it("nessuna modifica, deriva, verifica fallita, errore di validazione (406)", async () => {
    await rejects("bazarr_general", { changes: { minimum_score: 90 } }, "no_change");
    const drift = await propose(ctx, writer, "bazarr_general", { changes: { minimum_score: 85 } });
    await approve(drift.planId);
    w.bazarr.general.minimum_score = 50;
    await expect(applyPlan(ctx, writer, drift.planId)).rejects.toMatchObject({ code: "state_changed" });
    w.bazarr.general.minimum_score = 90;
    w.bazarr.ignorePost = true;
    const failed = await propose(ctx, writer, "bazarr_general", { changes: { minimum_score: 85 } });
    await approve(failed.planId);
    await expect(applyPlan(ctx, writer, failed.planId)).rejects.toThrow();
    expect((await getPlanView(ctx, failed.planId)).status).toBe("failed");
  });

  it("annullare ripristina; da profilo vuoto non c'è annullo automatico; la chiave API non compare", async () => {
    const { plan } = await run("bazarr_general", { changes: { minimum_score: 70, upgrade_subs: false } });
    const undo = await proposeUndo(ctx, writer, plan.planId);
    await approve(undo.planId);
    await applyPlan(ctx, writer, undo.planId);
    expect(w.bazarr.general).toMatchObject({ minimum_score: 90, upgrade_subs: true });
    const profile = await run("bazarr_general", { changes: { serie_default_profile: 2 } });
    expect((await getPlanView(ctx, profile.plan.planId)).canUndo).toBe(false);
    for (const leak of ["segretissima", "password-segreta", "admin"]) expect(await visible(plan.planId)).not.toContain(leak);
  });
});

describe("elenco delle azioni", () => {
  it("contiene le nuove azioni e nessuna tocca Proxmox", () => {
    expect(ACTIONS.map((a) => a.name)).toEqual(expect.arrayContaining(["plex_preferences", "seerr_main_settings", "seerr_server_settings", "bazarr_general"]));
    for (const action of ACTIONS) expect(action.services as string[]).not.toContain("proxmox");
  });
});
