import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { pickSimple } from "../src/services/config-common";
import { authedRequest, baseEnv, FakeNet, JWKS_URL, makeKey, NOW, validClaims, type TestKey } from "./helpers";
import type { Env } from "../src/types";

let key: TestKey;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
});

const AGENT = () => validClaims({ common_name: "agent-id" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function read(service: string, net: FakeNet, env: Env = baseEnv()) {
  const response = await handle(await authedRequest(key, `/v1/config/${service}`, AGENT()), env, { fetch: net.fetch, now: NOW });
  const text = await response.clone().text();
  return { status: response.status, body: (await response.json()) as any, text };
}

/** Mette un'eccezione IN CIMA: FakeNet usa la prima regola che corrisponde. */
function override(net: FakeNet, url: string, handler: (request: Request) => Response | Promise<Response>): void {
  (net as any).handlers.unshift([new RegExp("^" + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), handler]);
}

const noLeaks = (text: string, leaks: string[]) => {
  for (const leak of leaks) expect(text, `fuga: ${leak}`).not.toContain(leak);
};

// --- Bazarr ------------------------------------------------------------------------------------------------------
function bazarrNet(): FakeNet {
  const n = new FakeNet();
  n.json(JWKS_URL, { keys: [key.jwk] });
  n.json("https://bazarr.test/api/system/status", { data: { bazarr_version: "1.5.0", sonarr_version: "4.0.0", radarr_version: "5.0.0", operating_system: "Linux", python_version: "3.11", bazarr_directory: "/app/bazarr", bazarr_config_directory: "/config" } });
  n.json("https://bazarr.test/api/system/settings", {
    general: { use_sonarr: true, use_radarr: true, minimum_score: 90, minimum_score_movie: 70, upgrade_subs: true, days_to_upgrade_subs: 7, enabled_providers: ["opensubtitlescom", "subdl"], apikey: "bazarr-chiave-segretissima-1234567890abcdef", ip: "0.0.0.0", port: 6767, base_url: "/", postprocessing_cmd: "/bin/segreto.sh", use_postprocessing: false },
    auth: { type: "form", username: "admin-bazarr", password: "password-bazarr-segreta" },
    sonarr: { ip: "192.168.0.171", port: 8989, apikey: "sonarr-chiave-segretissima-1234567890", base_url: "/", only_monitored: false, series_sync: 60, full_update: "Daily", excluded_tags: ["no"] },
    radarr: { ip: "192.168.0.171", port: 7878, apikey: "radarr-chiave-segretissima-1234567890", only_monitored: true, movies_sync: 60 },
    opensubtitlescom: { username: "utente-os", password: "password-os-segreta", use_hash: true },
    proxy: { type: null, url: "http://proxy.interno:3128", username: "px", password: "pxpw" },
  });
  n.json("https://bazarr.test/api/system/languages/profiles", [{ profileId: 1, name: "Italiano", cutoff: null, items: [{ id: 1, language: "it", hi: "False", forced: "False", audio_exclude: "False" }], mustContain: [], mustNotContain: ["sample"], originalFormat: false, tag: "x" }]);
  return n;
}
const BAZARR_LEAKS = ["segretissima", "segreta", "admin-bazarr", "192.168", "0.0.0.0", "proxy.interno", "utente-os", "/bin/segreto", "/app/bazarr", "/config"];

describe("config_bazarr", () => {
  it("opzioni, provider (solo nomi) e profili lingua; nessun segreto", async () => {
    const { status, body, text } = await read("bazarr", bazarrNet());
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    const d = body.data;
    expect(d.version).toEqual({ bazarr_version: "1.5.0", sonarr_version: "4.0.0", radarr_version: "5.0.0", operating_system: "Linux", python_version: "3.11" });
    expect(d.settings.general).toEqual({ use_sonarr: true, use_radarr: true, minimum_score: 90, minimum_score_movie: 70, upgrade_subs: true, days_to_upgrade_subs: 7, enabled_providers: ["opensubtitlescom", "subdl"], use_postprocessing: false });
    expect(d.settings.sonarr).toEqual({ only_monitored: false, series_sync: 60, full_update: "Daily", excluded_tags: ["no"] });
    expect(d.settings.radarr).toEqual({ only_monitored: true, movies_sync: 60 });
    expect(d.languageProfiles[0]).toMatchObject({ profileId: 1, name: "Italiano", mustNotContain: ["sample"], items: [{ id: 1, language: "it", hi: "False", forced: "False", audio_exclude: "False" }] });
    expect(d.settings.auth).toBeUndefined();
    expect(d.settings.opensubtitlescom).toBeUndefined();
    noLeaks(text, BAZARR_LEAKS);
  });

  it("un endpoint che fallisce dà un avviso; senza chiave è unconfigured", async () => {
    const n = bazarrNet();
    override(n, "https://bazarr.test/api/system/languages/profiles", () => new Response("x", { status: 500 }));
    const partial = await read("bazarr", n);
    expect(partial.body.status).toBe("ok");
    expect(partial.body.warnings.some((w: string) => w.startsWith("languageProfiles"))).toBe(true);
    const none = await read("bazarr", bazarrNet(), baseEnv({ BAZARR_API_KEY: undefined }));
    expect(none.body.status).toBe("unconfigured");
  });
});

// --- Overseerr ---------------------------------------------------------------------------------------------------
function overseerrNet(): FakeNet {
  const n = new FakeNet();
  n.json(JWKS_URL, { keys: [key.jwk] });
  n.json("https://overseerr.test/api/v1/status", { version: "1.33.2", commitTag: "abc", updateAvailable: false, commitsBehind: 0, restartRequired: false });
  n.json("https://overseerr.test/api/v1/settings/main", { apiKey: "overseerr-chiave-segretissima-1234567890", applicationTitle: "Casa", applicationUrl: "https://overseerr.interno.example", hideAvailable: false, partialRequestsEnabled: true, localLogin: true, mediaServerLogin: true, newPlexLogin: false, defaultPermissions: 32, region: "IT", originalLanguage: "it", trustProxy: true, csrfProtection: false });
  // più specifica, quindi PRIMA: FakeNet usa la prima regola che corrisponde
  n.json("https://overseerr.test/api/v1/settings/radarr/0/profiles", [{ id: 9, name: "2160p Quality (IT)" }, { id: 4, name: "HD-1080p" }]);
  n.json("https://overseerr.test/api/v1/settings/radarr", [{ id: 0, name: "Radarr", hostname: "192.168.0.171", port: 7878, apiKey: "radarr-chiave-segretissima-1234567890", useSsl: false, baseUrl: "/radarr", activeProfileId: 9, activeProfileName: "2160p Quality (IT)", activeDirectory: "/media/library/Movies", is4k: false, minimumAvailability: "released", isDefault: true, externalUrl: "https://radarr.belinchebon.com", tags: [1], syncEnabled: false, preventSearch: false }]);
  n.json("https://overseerr.test/api/v1/settings/sonarr", [{ id: 0, name: "Sonarr", hostname: "192.168.0.171", apiKey: "sonarr-chiave-segretissima-1234567890", activeProfileName: "Any", activeDirectory: "/media/library/TV", activeAnimeDirectory: "/media/library/Anime", is4k: false, isDefault: true, enableSeasonFolders: true, seriesType: "standard", animeSeriesType: "anime" }]);
  n.json("https://overseerr.test/api/v1/settings/plex", { name: "Plex", ip: "192.168.0.171", port: 32400, useSsl: false, machineId: "idmacchina-segretissimo-1234567890abcdef", libraries: [{ id: "1", name: "Movies", enabled: true, type: "movie" }, { id: "2", name: "Series", enabled: false }] });
  n.json("https://overseerr.test/api/v1/settings/jobs", [{ id: "plex-recently-added-scan", name: "Plex Recently Added Scan", type: "process", interval: "minutes", cronSchedule: "0 */5 * * * *", nextExecutionTime: "2026-11-26T20:00:00Z", running: false }]);
  return n;
}
const OVERSEERR_LEAKS = ["segretissima", "192.168", "overseerr.interno", "belinchebon", "/radarr", "idmacchina"];

describe("config_overseerr", () => {
  it("opzioni, server collegati senza indirizzi né chiavi, librerie e lavori", async () => {
    const { status, body, text } = await read("overseerr", overseerrNet());
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    const d = body.data;
    expect(d.version).toEqual({ version: "1.33.2", commitTag: "abc", updateAvailable: false, commitsBehind: 0, restartRequired: false });
    expect(d.main).toEqual({ applicationTitle: "Casa", hideAvailable: false, partialRequestsEnabled: true, localLogin: true, mediaServerLogin: true, newPlexLogin: false, defaultPermissions: 32, region: "IT", originalLanguage: "it", trustProxy: true, csrfProtection: false });
    expect(d.radarr).toEqual([{ id: 0, name: "Radarr", is4k: false, isDefault: true, minimumAvailability: "released", activeProfileId: 9, activeProfileName: "2160p Quality (IT)", activeDirectory: "/media/library/Movies", tags: [1], syncEnabled: false, preventSearch: false }]);
    expect(d.sonarr[0]).toMatchObject({ name: "Sonarr", activeAnimeDirectory: "/media/library/Anime", enableSeasonFolders: true });
    expect(d.plex).toEqual({ libraries: [{ id: "1", name: "Movies", enabled: true, type: "movie" }, { id: "2", name: "Series", enabled: false }] });
    expect(d.jobs).toEqual([{ id: "plex-recently-added-scan", name: "Plex Recently Added Scan", type: "process", interval: "minutes", cronSchedule: "0 */5 * * * *", running: false }]);
    noLeaks(text, OVERSEERR_LEAKS);
  });

  it("controlla la connessione dei server Radarr con la chiave salvata in Seerr: esito e numero di profili, mai indirizzi o chiavi", async () => {
    const { body, text } = await read("overseerr", overseerrNet());
    expect(body.data.connections).toEqual([{ service: "radarr", id: 0, reachable: true, profiles: 2 }]);
    noLeaks(text, OVERSEERR_LEAKS);
  });

  it("se Seerr non riesce a parlare con Radarr (chiave persa o server giù), il controllo lo dice", async () => {
    const n = overseerrNet();
    override(n, "https://overseerr.test/api/v1/settings/radarr/0/profiles", () => new Response("no", { status: 500 }));
    const { body } = await read("overseerr", n);
    expect(body.data.connections).toEqual([{ service: "radarr", id: 0, reachable: false, profiles: null }]);
    const odd = overseerrNet();
    override(odd, "https://overseerr.test/api/v1/settings/radarr/0/profiles", () => json({ errore: "boh" }));
    expect((await read("overseerr", odd)).body.data.connections).toEqual([{ service: "radarr", id: 0, reachable: false, profiles: null }]);
  });

  it("gli id dei server fuori formato non entrano mai nell'indirizzo delle richieste", async () => {
    const n = overseerrNet();
    (n as any).handlers.unshift([/^https:\/\/overseerr\.test\/api\/v1\/settings\/radarr$/, () => json([{ id: "0/../../x" }, { id: -1 }, { id: 1.5 }, { id: 5000 }, { id: 0 }])]); // solo l'elenco, non i profili
    const { body } = await read("overseerr", n);
    expect(body.data.connections).toEqual([{ service: "radarr", id: 0, reachable: true, profiles: 2 }]);
    expect(n.calls.filter((c) => c.url.includes("/profiles")).map((c) => c.url)).toEqual(["https://overseerr.test/api/v1/settings/radarr/0/profiles"]);
  });

  it("accetta anche il nome alternativo del segreto; senza chiave è unconfigured", async () => {
    expect((await read("overseerr", overseerrNet(), baseEnv({ OVERSEERR_API_KEY: undefined, OVERSEER_API_KEY: "alias" }))).body.status).toBe("ok");
    expect((await read("overseerr", overseerrNet(), baseEnv({ OVERSEERR_API_KEY: undefined, OVERSEER_API_KEY: undefined }))).body.status).toBe("unconfigured");
  });
});

// --- Plex --------------------------------------------------------------------------------------------------------
function plexNet(): FakeNet {
  const n = new FakeNet();
  n.json(JWKS_URL, { keys: [key.jwk] });
  n.json("https://plex.test/:/prefs", { MediaContainer: { Setting: [
    { id: "TranscoderTempDirectory", value: "/transcode", type: "text" },
    { id: "TranscodeCountLimit", value: 3, type: "int" },
    { id: "ScheduledLibraryUpdatesEnabled", value: true, type: "bool" },
    { id: "ButlerTaskBackupDatabase", value: true, type: "bool" },
    { id: "WanPerStreamMaxUploadRate", value: 0, type: "int" },
    { id: "PlexOnlineToken", value: "plex-token-segretissimo-1234567890abcdef", type: "text" },
    { id: "PlexOnlineUsername", value: "persona@example.test", type: "text" },
    { id: "PlexOnlineMail", value: "persona@example.test", type: "text" },
    { id: "LanNetworksBandwidth", value: "192.168.0.0/24", type: "text" },
    { id: "allowedNetworks", value: "10.1.1.0/24", type: "text" },
    { id: "customConnections", value: "https://plex.interno.example:32400", type: "text" },
    { id: "FriendlyName", value: "Server di Persona", type: "text" },
  ] } });
  n.json("https://plex.test/library/sections", { MediaContainer: { Directory: [
    { key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Movie", language: "it-IT", refreshing: false, uuid: "uuid-segretissimo", Location: [{ id: 1, path: "/media/library/Movies" }] },
    { key: "2", title: "Anime", type: "show", agent: "tv.plex.agents.series", scanner: "Plex TV Series", language: "it-IT", Location: [{ id: 2, path: "/media/library/Anime" }, { id: 3, path: "/media/library/TV" }] },
  ] } });
  n.json("https://plex.test/", { MediaContainer: { version: "1.41.0", platform: "Linux", platformVersion: "Debian", machineIdentifier: "idmacchina-segretissimo", myPlexUsername: "persona@example.test", friendlyName: "Server di Persona", transcoderActiveVideoSessions: 0, transcoderVideo: true, allowMediaDeletion: true, myPlexSubscription: true, multiuser: true } });
  return n;
}
const PLEX_LEAKS = ["segretissimo", "persona@", "Server di Persona", "192.168", "10.1.1", "plex.interno", "uuid"];

describe("config_plex", () => {
  it("trascodifica, manutenzione e librerie; mai account, token né reti", async () => {
    const { status, body, text } = await read("plex", plexNet());
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    const d = body.data;
    expect(d.preferences).toEqual({ TranscoderTempDirectory: "/transcode", TranscodeCountLimit: 3, ScheduledLibraryUpdatesEnabled: true, ButlerTaskBackupDatabase: true, WanPerStreamMaxUploadRate: 0 });
    expect(d.libraries).toEqual([
      { key: "1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Movie", language: "it-IT", refreshing: false, locations: ["/media/library/Movies"] },
      { key: "2", title: "Anime", type: "show", agent: "tv.plex.agents.series", scanner: "Plex TV Series", language: "it-IT", locations: ["/media/library/Anime", "/media/library/TV"] },
    ]);
    expect(d.server).toEqual({ version: "1.41.0", platform: "Linux", platformVersion: "Debian", transcoderVideo: true, allowMediaDeletion: true, multiuser: true, myPlexSubscription: true, activeTranscodes: 0 });
    noLeaks(text, PLEX_LEAKS);
  });

  it("chiede JSON e usa il token; senza token è unconfigured", async () => {
    const n = plexNet();
    await read("plex", n);
    const calls = n.calls.filter((c) => c.url.startsWith("https://plex.test"));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET" && c.headers.get("x-plex-token") === "plex-token" && c.headers.get("accept") === "application/json")).toBe(true);
    expect((await read("plex", plexNet(), baseEnv({ PLEX_TOKEN: undefined }))).body.status).toBe("unconfigured");
  });
});

// --- Proxmox -----------------------------------------------------------------------------------------------------
function proxmoxNet(): FakeNet {
  const n = new FakeNet();
  n.json(JWKS_URL, { keys: [key.jwk] });
  const b = "https://pve.test/api2/json";
  n.json(new RegExp(`^${b.replace(/[.]/g, "\\.")}/nodes$`) as any, { data: [{ node: "pve", status: "online" }] });
  n.json(`${b}/nodes/pve/status`, { data: { pveversion: "pve-manager/8.3.0", kversion: "Linux 6.8", cpuinfo: { cpus: 8, model: "Intel", mhz: "3000" }, memory: { total: 32 * 1024 ** 3, used: 29 * 1024 ** 3 }, swap: { total: 8 * 1024 ** 3, used: 0 }, rootfs: { total: 100 * 1024 ** 3, used: 90 * 1024 ** 3, avail: 10 * 1024 ** 3 }, "boot-info": { mode: "efi" }, ksm: {}, loadavg: ["1", "1", "1"] } });
  n.json(`${b}/nodes/pve/apt/update`, { data: [{ Package: "a" }, { Package: "b" }] });
  n.json(`${b}/cluster/resources?type=vm`, { data: [
    { type: "qemu", vmid: 102, node: "pve", name: "haos", status: "running" },
    { type: "lxc", vmid: 101, node: "pve", name: "Plex", status: "running" },
    { type: "qemu", vmid: 9000, node: "pve", name: "modello", template: 1 },
  ] });
  n.json(`${b}/nodes/pve/qemu/102/config`, { data: { name: "haos", cores: 2, memory: 4096, balloon: 0, onboot: 1, ostype: "l26", bios: "ovmf", net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0", description: "password: nota-segretissima", scsi0: "local-lvm:vm-102-disk-0,size=32G,ssd=1", efidisk0: "local-lvm:vm-102-disk-1,size=4M", ipconfig0: "ip=192.168.0.50/24", sshkeys: "ssh-rsa%20AAAAchiavessh" } });
  n.json(`${b}/nodes/pve/lxc/101/config`, { data: { hostname: "Plex", cores: 4, memory: 8192, swap: 512, onboot: 1, protection: 1, unprivileged: 1, ostype: "debian", rootfs: "local-lvm:vm-101-disk-0,size=8G", mp0: "/mnt/media,mp=/media", net0: "name=eth0,hwaddr=AA:BB:CC:00:00:01,ip=192.168.0.60/24,bridge=vmbr0", description: "nota-segretissima" } });
  n.json(`${b}/cluster/backup`, { data: [{ id: "backup-1", enabled: 1, schedule: "sat 20:00", storage: "nas", mode: "snapshot", compress: "zstd", vmid: "100,101,102", "prune-backups": "keep-last=3", mailto: "persona@example.test", mailnotification: "always", "notification-mode": "auto" }] });
  n.json(`${b}/storage`, { data: [{ storage: "local", type: "dir", content: "iso,vztmpl,backup", path: "/var/lib/vz", shared: 0 }, { storage: "nas", type: "cifs", content: "backup", server: "192.168.0.99", share: "backup", username: "utente-nas", password: "pw-nas-segreta", "prune-backups": "keep-last=3" }] });
  n.json(`${b}/nodes/pve/disks/list`, { data: [{ devpath: "/dev/sda", type: "ssd", model: "Samsung SSD", size: 500 * 1024 ** 3, health: "PASSED", wearout: 97, used: "LVM", serial: "SERIALE-SEGRETISSIMO", wwn: "0xwwn-segretissimo", vendor: "ATA" }] });
  return n;
}
const PROXMOX_LEAKS = ["segretissima", "segreta", "AA:BB", "192.168", "persona@", "SERIALE", "wwn", "utente-nas", "/mnt/media", "/var/lib/vz", "AAAAchiavessh", "ipconfig"];

describe("config_proxmox", () => {
  it("nodo, guest, backup, storage e dischi in sola lettura; nessun indirizzo, MAC, nota né seriale", async () => {
    const n = proxmoxNet();
    const { status, body, text } = await read("proxmox", n);
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    const d = body.data;
    expect(d.node).toEqual({ node: "pve", pveversion: "pve-manager/8.3.0", kversion: "Linux 6.8", cpus: 8, memoryGb: { total: 32, used: 29 }, swapGb: { total: 8, used: 0 }, rootGb: { total: 100, used: 90, free: 10 }, pendingUpdates: 2 });
    expect(d.guests).toEqual([
      { vmid: 101, type: "lxc", hostname: "Plex", cores: 4, memory: 8192, swap: 512, onboot: 1, protection: 1, unprivileged: 1, ostype: "debian", disks: [{ disk: "rootfs", storage: "local-lvm", size: "8G" }, { disk: "mp0", storage: null, size: null }] },
      { vmid: 102, type: "qemu", name: "haos", cores: 2, memory: 4096, balloon: 0, onboot: 1, ostype: "l26", bios: "ovmf", disks: [{ disk: "scsi0", storage: "local-lvm", size: "32G" }, { disk: "efidisk0", storage: "local-lvm", size: "4M" }] },
    ]);
    expect(d.backupJobs).toEqual([{ id: "backup-1", enabled: 1, schedule: "sat 20:00", storage: "nas", mode: "snapshot", compress: "zstd", vmid: "100,101,102", "prune-backups": "keep-last=3", "notification-mode": "auto" }]);
    expect(d.storages).toEqual([{ storage: "local", type: "dir", content: "iso,vztmpl,backup", shared: 0 }, { storage: "nas", type: "cifs", content: "backup", "prune-backups": "keep-last=3" }]);
    expect(d.disks).toEqual([{ type: "ssd", health: "PASSED", wearout: 97, used: "LVM", model: "Samsung SSD", sizeGb: 500 }]);
    noLeaks(text, PROXMOX_LEAKS);
    // Solo lettura: ogni richiesta verso Proxmox è un GET con il token, senza redirect.
    const calls = n.calls.filter((c) => c.url.startsWith("https://pve.test"));
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((c) => c.method === "GET" && c.headers.get("authorization")?.startsWith("PVEAPIToken=") && c.redirect === "manual")).toBe(true);
  });

  it("un guest o un endpoint che non si legge dà un avviso o una nota, senza fermare il resto", async () => {
    const n = proxmoxNet();
    override(n, "https://pve.test/api2/json/nodes/pve/lxc/101/config", () => new Response("no", { status: 403 }));
    override(n, "https://pve.test/api2/json/nodes/pve/apt/update", () => new Response("no", { status: 403 }));
    override(n, "https://pve.test/api2/json/cluster/backup", () => new Response("no", { status: 500 }));
    const { body } = await read("proxmox", n);
    expect(body.status).toBe("ok");
    expect(body.data.guests.find((g: any) => g.vmid === 101)).toMatchObject({ error: "configurazione non leggibile" });
    expect(body.data.node.pendingUpdates).toBeNull();
    expect(body.warnings.some((w: string) => w.startsWith("backupJobs"))).toBe(true);
  });

  it("senza token è unconfigured e non chiama Proxmox", async () => {
    const n = proxmoxNet();
    const { body } = await read("proxmox", n, baseEnv({ PROXMOX_API_TOKEN: undefined }));
    expect(body.status).toBe("unconfigured");
    expect(n.callsTo("https://pve.test")).toBe(0);
  });

  it("nomi di nodo e di guest fuori formato non entrano mai nell'indirizzo", async () => {
    const n = proxmoxNet();
    override(n, "https://pve.test/api2/json/nodes", () => json({ data: [{ node: "../../etc/passwd", status: "online" }] }));
    const { body } = await read("proxmox", n);
    expect(body.data.node).toBeNull();
    expect(body.data.guests).toBeNull();
    expect(body.data.disks).toBeNull();
    expect(["node", "guests", "disks"].every((part) => body.warnings.some((w: string) => w.startsWith(part)))).toBe(true);
    expect(n.calls.some((c) => c.url.includes("passwd"))).toBe(false);
  });
});

describe("pickSimple", () => {
  it("prende solo le chiavi elencate e solo valori semplici: niente oggetti né elenchi di oggetti, anche sotto una chiave ammessa", () => {
    const source = {
      ok: "testo", num: 3, bool: false, nul: null, lista: ["a", 1, true], listaOggetti: [{ password: "segreta" }], listaMista: ["a", { x: 1 }],
      oggetto: { password: "segreta" }, funzione: () => 1, nonElencata: "x", lunga: "z".repeat(500),
    };
    const out = pickSimple(source, ["ok", "num", "bool", "nul", "lista", "listaOggetti", "listaMista", "oggetto", "lunga", "assente"]);
    expect(Object.keys(out).sort()).toEqual(["bool", "lista", "lunga", "nul", "num", "ok"]);
    expect(out.lista).toEqual(["a", 1, true]);
    expect((out.lunga as string).length).toBe(200);
    expect(JSON.stringify(out)).not.toContain("segreta");
    expect(pickSimple(null, ["a"])).toEqual({});
    expect(pickSimple([1], ["0"])).toEqual({});
  });

  it("un elenco molto lungo non passa (limite di 100 voci)", () => {
    expect(pickSimple({ a: Array.from({ length: 101 }, (_, i) => i) }, ["a"])).toEqual({});
    expect(Object.keys(pickSimple({ a: Array.from({ length: 100 }, (_, i) => i) }, ["a"]))).toEqual(["a"]);
  });
});

describe("config_proxmox: nomi fuori formato per singolo guest", () => {
  it("il nodo indicato da una risorsa non valida non entra nell'indirizzo: si usa il nodo verificato", async () => {
    const n = proxmoxNet();
    override(n, "https://pve.test/api2/json/cluster/resources?type=vm", () => json({ data: [{ type: "qemu", vmid: 102, node: "../../etc", name: "haos" }] }));
    const { body } = await read("proxmox", n);
    expect(body.data.guests[0]).toMatchObject({ vmid: 102, name: "haos" });
    expect(n.calls.some((c) => c.url.includes("etc"))).toBe(false);
    expect(n.calls.some((c) => c.url === "https://pve.test/api2/json/nodes/pve/qemu/102/config")).toBe(true);
  });

  it("vmid e tipo non validi sono ignorati", async () => {
    const n = proxmoxNet();
    override(n, "https://pve.test/api2/json/cluster/resources?type=vm", () => json({ data: [{ type: "qemu", vmid: "102/../x", node: "pve" }, { type: "storage", vmid: 5, node: "pve" }, { type: "qemu", vmid: 1.5, node: "pve" }] }));
    const { body } = await read("proxmox", n);
    expect(body.data.guests).toEqual([]);
    expect(n.calls.some((c) => c.url.includes("/config"))).toBe(false);
  });
});
