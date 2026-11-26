import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { authedRequest, baseEnv, FakeNet, JWKS_URL, makeKey, NOW, validClaims, type TestKey } from "./helpers";
import type { Env } from "../src/types";

let key: TestKey;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
});

const AGENT = () => validClaims({ common_name: "agent-id" });
const env = (extra: Partial<Env> = {}): Env => baseEnv({ CLEANUPARR_URL: "https://cleanuparr.test", CLEANUPARR_API_KEY: "cleanuparr-key", ...extra });

/** Risposte come le dà Cleanuparr, con segreti piantati nei punti dove il programma vero li mette. */
function cleanuparrNet(options: { pascal?: boolean; failStall?: boolean } = {}): FakeNet {
  const net = new FakeNet();
  net.json(JWKS_URL, { keys: [key.jwk] });
  const base = "https://cleanuparr.test";
  net.json(`${base}/api/configuration/queue_cleaner`, {
    enabled: true, cronExpression: "0 0/5 * * * ?", useAdvancedScheduling: false,
    ignoredDownloads: ["tracker-privato"], processNoContentId: false, downloadingMetadataMaxStrikes: 3,
    failedImport: { maxStrikes: 3, ignorePrivate: false, deletePrivate: false, patterns: ["unable to import"], notifyUrl: "https://hooks.example.test/webhook-segreto" },
    errored: { maxStrikes: 5, apiKey: "q".repeat(40), note: "avvisa il server 10.20.30.40 se fallisce" },
    serverUrl: "http://192.168.0.171:11011",
  });
  if (options.failStall) net.on(`${base}/api/queue-rules/stall`, () => new Response("boom", { status: 500 }));
  else net.json(`${base}/api/queue-rules/stall`, [{ id: "r1", name: "Stallo", maxStrikes: 5, resetStrikesOnProgress: true, privacyType: "Public", minCompletionPercentage: 0, deletePrivateTorrentsFromClient: false, trackerHost: "tracker.example.test" }]);
  net.json(`${base}/api/queue-rules/slow`, [{ id: "r2", name: "Lenti", maxStrikes: 3, minSpeed: "100KB", maxTimeHours: 12 }]);
  net.json(`${base}/api/configuration/malware_blocker`, {
    enabled: true, cronExpression: "0 0/5 * * * ?", deleteIfAnyFileBlocked: false,
    sonarr: { enabled: true, blocklistPath: "https://raw.githubusercontent.com/utente/lista/main/blocklist.txt", blocklistType: "Blacklist" },
  });
  net.json(`${base}/api/configuration/download_cleaner`, {
    enabled: true, cronExpression: "0 0 * * * ?", useAdvancedScheduling: false, ignoredDownloads: [],
    clients: [{
      downloadClientId: "c1", downloadClientName: "qBittorrent", downloadClientEnabled: true, downloadClientTypeName: "qBittorrent", downloadClientUrl: "http://192.168.0.171:8080", downloadClientHost: "qbt-interno.lan",
      seedingRules: [{ name: "Regola", maxRatio: 2, minSeedTime: 0 }],
      unlinkedConfig: { enabled: false, targetCategory: "cleanuparr-unlinked", downloadDirectorySource: "/media/downloads/torrents", ignoredRootDirs: ["/media/privata"] },
    }],
  });
  const general = { dryRun: false, httpMaxRetries: 3, httpTimeout: 100, httpCertificateValidation: "Enabled", statusCheckEnabled: true, ignoredDownloads: [], connectivityCheckEnabled: true,
    connectivityCheckUrls: ["http://1.1.1.1"], strikeInactivityWindowHours: 24, historyRetentionDays: 30, displaySupportBanner: true,
    log: { level: "Information", path: "/config/logs" }, auth: { disableAuthForLocalAddresses: true, trustForwardedHeaders: false, trustedNetworks: ["192.168.0.0/24"] } };
  net.json(`${base}/api/configuration/general`, options.pascal ? Object.fromEntries(Object.entries(general).map(([k, v]) => [k[0]!.toUpperCase() + k.slice(1), v])) : general);
  net.json(`${base}/api/configuration/download_client`, { clients: [{
    id: "c1", enabled: true, name: "qBittorrent", typeName: "qBittorrent", type: "Torrent", host: "http://192.168.0.171:8080",
    username: "admin-qbt", password: "hunter2-segreto", apiKey: "k".repeat(32), httpAuthType: "Basic", httpAuthUsername: "utente-http", httpAuthPassword: "pw-http-segreta",
    urlBase: "/qbt", externalUrl: "https://qbt.belinchebon.com", downloadDirectorySource: "/downloads", downloadDirectoryTarget: "/media/dl",
  }] });
  for (const service of ["sonarr", "radarr"]) {
    net.json(`${base}/api/configuration/${service}`, { id: "a1", type: service, failedImportMaxStrikes: 3, instances: [{
      id: "i1", enabled: true, version: 4, name: service === "sonarr" ? "Sonarr" : "Radarr",
      url: `http://${service}-interno:8989`, apiKey: "b".repeat(32), externalUrl: `https://${service}.belinchebon.com`,
    }] });
  }
  return net;
}

async function config(net: FakeNet, e: Env = env()) {
  const response = await handle(await authedRequest(key, "/v1/config/cleanuparr", AGENT()), e, { fetch: net.fetch, now: NOW });
  return { status: response.status, body: (await response.json()) as any };
}

const LEAKS = [
  "192.168", "10.20.30.40", "qbt-interno", "1.1.1.1", "http://", "https://", "hunter2", "pw-http", "admin-qbt", "utente-http", "kkkkkkkk", "bbbbbbbb", "qqqqqqqq",
  "hooks.example", "webhook-segreto", "raw.githubusercontent", "tracker.example", "belinchebon.com", "trustedNetworks", "interno", "/config/logs",
];

describe("config_cleanuparr", () => {
  it("restituisce le impostazioni utili e non fa che richieste GET con la chiave", async () => {
    const net = cleanuparrNet();
    const { status, body } = await config(net);
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.warnings).toBeUndefined();
    const data = body.data;
    expect(data.queueCleaner).toMatchObject({ enabled: true, downloadingMetadataMaxStrikes: 3, failedImport: { maxStrikes: 3, ignorePrivate: false } });
    expect(data.stallRules[0]).toMatchObject({ name: "Stallo", maxStrikes: 5, resetStrikesOnProgress: true });
    expect(data.slowRules[0]).toMatchObject({ name: "Lenti", maxStrikes: 3 });
    expect(data.general).toEqual({ dryRun: false, httpMaxRetries: 3, httpTimeout: 100, httpCertificateValidation: "Enabled", statusCheckEnabled: true, ignoredDownloads: [], connectivityCheckEnabled: true, strikeInactivityWindowHours: 24, historyRetentionDays: 30 });
    expect(data.downloadClients).toEqual([{ name: "qBittorrent", typeName: "qBittorrent", type: "Torrent", enabled: true }]);
    expect(data.sonarr).toEqual({ failedImportMaxStrikes: 3, instances: [{ name: "Sonarr", enabled: true, version: 4 }] });
    expect(data.radarr.instances[0].name).toBe("Radarr");
    expect(data.downloadCleaner.clients[0]).toMatchObject({ downloadClientName: "qBittorrent", seedingRules: [{ maxRatio: 2 }] });

    expect(net.calls.filter((c) => c.url.startsWith("https://cleanuparr.test")).every((c) => c.method === "GET")).toBe(true);
    expect(net.calls.filter((c) => c.url.startsWith("https://cleanuparr.test")).every((c) => c.headers.get("x-api-key") === "cleanuparr-key" && c.redirect === "manual")).toBe(true);
  });

  it("non lascia uscire indirizzi, reti, percorsi privati, chiavi né password", async () => {
    for (const pascal of [false, true]) {
      const { body } = await config(cleanuparrNet({ pascal }));
      const text = JSON.stringify(body);
      for (const leak of LEAKS) expect(text, `${leak} (pascal=${pascal})`).not.toContain(leak);
    }
  });

  it("le impostazioni generali funzionano anche con i nomi in maiuscolo iniziale", async () => {
    const { body } = await config(cleanuparrNet({ pascal: true }));
    expect(body.data.general.HttpTimeout).toBe(100);
  });

  it("un endpoint che fallisce dà un avviso e le altre parti restano", async () => {
    const { body } = await config(cleanuparrNet({ failStall: true }));
    expect(body.status).toBe("ok");
    expect(body.warnings.some((w: string) => w.startsWith("stallRules"))).toBe(true);
    expect(body.data.queueCleaner.enabled).toBe(true);
    expect(body.data.stallRules).toBeNull();
  });

  it("senza chiave la sezione risulta unconfigured e non chiama Cleanuparr", async () => {
    const net = cleanuparrNet();
    const { body } = await config(net, env({ CLEANUPARR_API_KEY: undefined }));
    expect(body.status).toBe("unconfigured");
    expect(net.callsTo("https://cleanuparr.test")).toBe(0);
  });

  it("la homepage (solo media:read) non vede la configurazione di Cleanuparr", async () => {
    const response = await handle(await authedRequest(key, "/v1/config/cleanuparr", validClaims()), env(), { fetch: cleanuparrNet().fetch, now: NOW });
    expect(response.status).toBe(403);
  });
});
