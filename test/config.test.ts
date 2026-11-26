import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { REDACTED, scrubSecrets } from "../src/scrub";
import { authedRequest, baseEnv, healthyNet, makeKey, NOW, signJwt, validClaims, type TestKey } from "./helpers";

let key: TestKey;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
});

const AGENT = () => validClaims({ common_name: "agent-id" });
const MEDIA_ONLY = () => validClaims(); // homepage: solo media:read

async function get(path: string, claims: Record<string, unknown>, net = healthyNet(key)) {
  const response = await handle(await authedRequest(key, path, claims), baseEnv(), { fetch: net.fetch, now: NOW });
  return { response, net };
}
const body = async (response: Response) => (await response.json()) as any;

const LEAKS = [
  "radarr-indexer-secret-key", "top-secret-indexer", "192.168.0", "qbt-pass-leak", "admin-user", "APP-LEAK-1234", "leak-in-spec",
  "hash-of-qbt-password", "proxy-pass", "mail-pass", "/usr/bin/autorun-segreto", "10.1.1.1", "gruppo-segreto", "/data/cestino",
  "radarr-key", "sonarr-key", "prowlarr-key", "gw-secret", "abc123",
];

describe("scrubSecrets", () => {
  it("toglie le chiavi che somigliano a segreti, a qualsiasi profondità", () => {
    const out = scrubSecrets({
      name: "ok", apiKey: "x", api_key: "x", password: "x", web_ui_password: "x", Secret: "x", accessToken: "x", cookie: "x", fields: [{ name: "a" }],
      nested: { username: "u", email: "a@b.it", keep: 1, list: [{ authorization: "z", fine: true }] },
    });
    expect(out).toEqual({ name: "ok", nested: { keep: 1, list: [{ fine: true }] } });
  });

  it("toglie le chiavi private ma conserva le impostazioni che contengono 'private' (ignorePrivate)", () => {
    const out = scrubSecrets({ privateKey: "x", private_key: "x", PrivateKey: "x", ignorePrivate: true, deletePrivate: false, privacyType: "Public" });
    expect(out).toEqual({ ignorePrivate: true, deletePrivate: false, privacyType: "Public" });
  });

  it("oscura i valori che hanno l'aspetto di una chiave, anche sotto un nome innocuo", () => {
    const out = scrubSecrets({
      a: "0123456789abcdef0123456789abcdef", b: "Bearer abc.def.ghi", c: "http://user:pass@host/x", d: "PVEAPIToken=u@pve!t=segreto",
      e: "A".repeat(50), f: "una frase normale", g: "/data/media", h: "{Movie Title} ({Release Year})", i: 42, j: true, k: null,
    });
    expect(out).toEqual({
      a: REDACTED, b: REDACTED, c: REDACTED, d: REDACTED, e: REDACTED,
      f: "una frase normale", g: "/data/media", h: "{Movie Title} ({Release Year})", i: 42, j: true, k: null,
    });
  });

  it("non va in loop su strutture molto profonde", () => {
    let deep: any = { v: "x" };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    expect(JSON.stringify(scrubSecrets(deep))).toContain(REDACTED);
  });
});

describe("sezioni di configurazione: contenuto", () => {
  it("Radarr: profili, formati, cartelle, client, indexer, naming", async () => {
    const { response } = await get("/v1/config/radarr", AGENT());
    expect(response.status).toBe(200);
    const section = await body(response);
    expect(section.status).toBe("ok");
    const d = section.data;
    expect(d.version).toBe("5.0.1");
    expect(d.qualityProfiles).toEqual([
      {
        id: 7, name: "HD-1080p", upgradeAllowed: true, cutoff: "WEB 1080p", allowed: ["WEB 1080p", "Bluray-1080p"], minFormatScore: 0, cutoffFormatScore: 100, minUpgradeFormatScore: 1,
        formatScores: [{ id: 11, name: "x265 (HD)", score: -100 }, { id: 12, name: "Repack/Proper", score: 5 }],
      },
    ]);
    expect(d.customFormats).toEqual(["x265 (HD)", "Repack/Proper"]);
    expect(d.rootFolders).toEqual([{ path: "/data/media", freeGb: 770 }]);
    expect(d.downloadClients).toEqual([{ id: 7, name: "qBittorrent", implementation: "QBittorrent", protocol: "torrent", enable: true, priority: 1, removeCompletedDownloads: true }]);
    expect(d.indexers).toEqual([
      { id: 4, name: "Prowlarr (Torznab)", implementation: "Torznab", protocol: "torrent", enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, priority: 25 },
    ]);
    expect(d.mediaManagement).toMatchObject({ copyUsingHardlinks: true, recycleBinEnabled: true, recycleBinCleanupDays: 7 });
    expect(d.naming.standardMovieFormat).toBe("{Movie Title} ({Release Year})");
    expect(d.delayProfiles[0]).toMatchObject({ preferredProtocol: "torrent", torrentDelay: 30 });
    expect(d.tags).toEqual(["4k"]);
  });

  it("Prowlarr: indexer, applicazioni, profili, client", async () => {
    const d = (await body((await get("/v1/config/prowlarr", AGENT())).response)).data.prowlarr;
    expect(d.version).toBe("1.30.0");
    expect(d.applications).toEqual([{ name: "Radarr", implementation: "Radarr", syncLevel: "fullSync" }]);
    expect(d.appProfiles[0]).toMatchObject({ name: "Standard", minimumSeeders: 1 });
    expect(d.tags).toEqual(["italia"]);
  });

  it("qBittorrent: solo le impostazioni di funzionamento e le categorie", async () => {
    const d = (await body((await get("/v1/config/qbittorrent", AGENT())).response)).data.qbittorrent;
    expect(d.version).toBe("v5.0.2");
    expect(d.preferences).toEqual({ save_path: "/downloads", max_active_downloads: 3, max_active_torrents: 5, dl_limit: 0, up_limit: 1_000_000, max_ratio_enabled: true, max_ratio: 2 });
    expect(d.categories).toEqual([{ name: "radarr", savePath: "/downloads/radarr" }, { name: "sonarr", savePath: "/downloads/sonarr" }]);
  });

  it("un sotto-elemento che fallisce non invalida il resto, e risulta un avviso", async () => {
    const healthy = healthyNet(key);
    const mixed = async (input: string, init?: RequestInit) =>
      input.startsWith("https://radarr.test/api/v3/customformat") ? new Response("boom", { status: 500 }) : healthy.fetch(input, init);
    const section = await body((await get("/v1/config/radarr", AGENT(), { fetch: mixed } as any)).response);
    expect(section.status).toBe("ok");
    expect(section.data.customFormats).toBeNull();
    expect(section.data.qualityProfiles).toHaveLength(1);
    expect(section.warnings).toEqual(["customFormats: Errore del servizio (HTTP 500)"]);
  });
});

describe("sezioni di configurazione: nessuna fuga di segreti", () => {
  it("la panoramica di configurazione non contiene chiavi, password, indirizzi né percorsi interni", async () => {
    const { response } = await get("/v1/config/overview", AGENT());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(Object.keys(JSON.parse(text).sections)).toEqual(["config_radarr", "config_sonarr", "config_prowlarr", "config_qbittorrent", "config_cleanuparr"]);
    for (const secret of LEAKS) expect(text, `trapelato: ${secret}`).not.toContain(secret);
  });

  it("anche se un adapter lasciasse passare un campo segreto, la rete di sicurezza lo toglie", async () => {
    const healthy = healthyNet(key);
    const leaky = async (input: string, init?: RequestInit) =>
      input.startsWith("https://radarr.test/api/v3/tag") ? new Response(JSON.stringify([{ label: "0123456789abcdef0123456789abcdef" }]), { status: 200 }) : healthy.fetch(input, init);
    const section = await body((await get("/v1/config/radarr", AGENT(), { fetch: leaky } as any)).response);
    expect(section.data.tags).toEqual([REDACTED]);
  });
});

describe("permessi", () => {
  it("un cliente con il solo permesso media non vede nessuna configurazione", async () => {
    for (const path of ["/v1/config/radarr", "/v1/config/overview", "/v1/media/overview?sections=config_radarr", "/v1/media/overview?sections=streams,config_qbittorrent"]) {
      const { response, net } = await get(path, MEDIA_ONLY());
      expect(response.status, path).toBe(403);
      expect(net.callsTo("https://radarr.test") + net.callsTo("https://qbt.test"), path).toBe(0);
    }
  });

  it("la panoramica 'media' di un cliente non include mai le sezioni di configurazione e non dà 403 (la homepage non si rompe)", async () => {
    for (const claims of [MEDIA_ONLY(), AGENT()]) {
      const { response } = await get("/v1/media/overview", claims);
      expect(response.status).toBe(200);
      const names = Object.keys((await body(response)).sections);
      expect(names.some((n) => n.startsWith("config_"))).toBe(false);
      expect(names).toContain("streams");
    }
  });

  it("i percorsi non si scambiano tra gruppi", async () => {
    expect((await get("/v1/media/config_radarr", AGENT())).response.status).toBe(404);
    expect((await get("/v1/config/streams", AGENT())).response.status).toBe(404);
  });

  it("/v1/capabilities mostra gruppo e permesso di ogni sezione", async () => {
    const homepage = await body((await get("/v1/capabilities", MEDIA_ONLY())).response);
    const config = homepage.sections.find((s: any) => s.name === "config_radarr");
    expect(config).toMatchObject({ group: "config", scope: "config:read", allowed: false, path: "/v1/config/radarr" });
    const agent = await body((await get("/v1/capabilities", AGENT())).response);
    expect(agent.sections.find((s: any) => s.name === "config_radarr").allowed).toBe(true);
    expect(agent.sections.find((s: any) => s.name === "streams").group).toBe("media");
  });
});

describe("MCP e configurazione", () => {
  async function rpc(claims: Record<string, unknown>, method: string, params?: unknown, net = healthyNet(key)) {
    const response = await handle(
      new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": await signJwt(key, claims) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      baseEnv(),
      { fetch: net.fetch, now: NOW },
    );
    return { json: (await response.json()) as any, net };
  }

  it("gli strumenti di configurazione si vedono solo con il permesso config:read", async () => {
    const agent = (await rpc(AGENT(), "tools/list")).json.result.tools.map((t: any) => t.name);
    expect(agent).toEqual(expect.arrayContaining(["get_config_overview", "get_config_radarr", "get_config_qbittorrent"]));
    const homepage = (await rpc(MEDIA_ONLY(), "tools/list")).json.result.tools.map((t: any) => t.name);
    expect(homepage.some((n: string) => n.startsWith("get_config"))).toBe(false);
  });

  it("get_overview di un cliente senza config:read non può farsi dare una sezione di configurazione, né toccare i servizi", async () => {
    const { json, net } = await rpc(MEDIA_ONLY(), "tools/call", { name: "get_overview", arguments: { sections: ["config_radarr"] } });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toContain("config:read");
    expect(net.callsTo("https://radarr.test")).toBe(0);
  });

  it("get_overview predefinito non include la configurazione nemmeno per l'agente", async () => {
    const { json } = await rpc(AGENT(), "tools/call", { name: "get_overview", arguments: {} });
    const names = Object.keys(JSON.parse(json.result.content[0].text).sections);
    expect(names.some((n) => n.startsWith("config_"))).toBe(false);
  });

  it("get_config_overview per l'agente: 5 sezioni, nessun segreto", async () => {
    const { json } = await rpc(AGENT(), "tools/call", { name: "get_config_overview", arguments: {} });
    const text = json.result.content[0].text;
    expect(Object.keys(JSON.parse(text).sections)).toHaveLength(5);
    for (const secret of LEAKS) expect(text, `trapelato: ${secret}`).not.toContain(secret);
  });
});
