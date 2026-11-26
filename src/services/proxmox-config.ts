import { baseUrl, getJson, requireSecret } from "../upstream";
import type { Ctx } from "../types";
import { isRecord, list, pickSimple } from "./config-common";

/**
 * Configurazione di Proxmox per l'audit, SOLO LETTURA (token con ruolo PVEAuditor; ogni richiesta è un GET e `upstream.request`
 * rifiuta comunque qualsiasi altro metodo verso Proxmox). Non escono indirizzi IP, MAC, utenti, note né indirizzi email:
 * si leggono solo opzioni di funzionamento elencate per nome.
 */

const get = async (ctx: Ctx, path: string): Promise<unknown> => {
  const token = requireSecret(ctx.env.PROXMOX_API_TOKEN, "proxmox");
  return ((await getJson<{ data?: unknown }>(ctx, `${baseUrl(ctx.env, "proxmox")}/api2/json${path}`, { headers: { Authorization: `PVEAPIToken=${token}` } })).data) ?? null;
};

const GB = 1024 ** 3;
const gb = (value: unknown): number | null => (typeof value === "number" ? Math.round((value / GB) * 10) / 10 : null);

async function firstNode(ctx: Ctx): Promise<string> {
  const nodes = list(await get(ctx, "/nodes"), 20).filter(isRecord);
  const node = nodes.find((n) => n.status === "online") ?? nodes[0];
  if (!node || typeof node.node !== "string" || !/^[A-Za-z0-9-]{1,63}$/.test(node.node)) throw new Error("nodo");
  return node.node;
}

/** Stato del nodo: versioni, CPU, memoria, spazio della radice e aggiornamenti in attesa (solo il numero). */
export async function fetchProxmoxNode(ctx: Ctx) {
  const node = await firstNode(ctx);
  const status = await get(ctx, `/nodes/${node}/status`);
  const s = isRecord(status) ? status : {};
  const cpuinfo = isRecord(s.cpuinfo) ? s.cpuinfo : {};
  const mem = isRecord(s.memory) ? s.memory : {};
  const swap = isRecord(s.swap) ? s.swap : {};
  const root = isRecord(s.rootfs) ? s.rootfs : {};
  let pendingUpdates: number | null = null;
  try {
    pendingUpdates = list(await get(ctx, `/nodes/${node}/apt/update`), 1000).length;
  } catch {
    /* lettura non permessa o non disponibile */
  }
  return {
    node,
    ...pickSimple(s, ["pveversion", "kversion"]),
    cpus: typeof cpuinfo.cpus === "number" ? cpuinfo.cpus : null,
    memoryGb: { total: gb(mem.total), used: gb(mem.used) },
    swapGb: { total: gb(swap.total), used: gb(swap.used) },
    rootGb: { total: gb(root.total), used: gb(root.used), free: gb(root.avail) },
    pendingUpdates,
  };
}

const GUEST_KEYS = ["name", "hostname", "cores", "sockets", "memory", "balloon", "swap", "cpu", "onboot", "startup", "protection", "agent", "ostype", "arch", "bios", "machine", "unprivileged", "boot"] as const;
const DISK_KEY = /^(scsi|virtio|sata|ide|rootfs|mp|efidisk|tpmstate)\d*$/;

/** Dischi di un guest: solo storage e dimensione (la stringa completa può contenere percorsi o opzioni). */
function disks(config: Record<string, unknown>) {
  const out: Array<{ disk: string; storage: string | null; size: string | null }> = [];
  for (const [key, value] of Object.entries(config)) {
    if (!DISK_KEY.test(key) || typeof value !== "string") continue;
    const storage = /^([A-Za-z0-9_.-]+):/.exec(value)?.[1] ?? null;
    const size = /(?:^|,)size=([0-9]+[KMGT]?)/.exec(value)?.[1] ?? null;
    out.push({ disk: key, storage, size });
  }
  return out;
}

/** Configurazione dei guest (VM e container): risorse, avvio automatico, protezione, dischi. Niente rete, note né credenziali. */
export async function fetchProxmoxGuests(ctx: Ctx) {
  const node = await firstNode(ctx);
  const resources = list(await get(ctx, "/cluster/resources?type=vm"), 100).filter(isRecord);
  const result = [];
  for (const resource of resources) {
    const vmid = resource.vmid;
    const type = resource.type === "lxc" ? "lxc" : resource.type === "qemu" ? "qemu" : null;
    if (typeof vmid !== "number" || !Number.isInteger(vmid) || !type || resource.template) continue;
    const nodeName = typeof resource.node === "string" && /^[A-Za-z0-9-]{1,63}$/.test(resource.node) ? resource.node : node;
    try {
      const config = await get(ctx, `/nodes/${nodeName}/${type}/${vmid}/config`);
      const c = isRecord(config) ? config : {};
      result.push({ vmid, type, ...pickSimple(c, GUEST_KEYS), disks: disks(c) });
    } catch {
      result.push({ vmid, type, name: typeof resource.name === "string" ? resource.name : null, error: "configurazione non leggibile" });
    }
  }
  return result.sort((a, b) => a.vmid - b.vmid);
}

/** Lavori di backup pianificati: quando, dove, quali guest, conservazione (senza indirizzi email). */
export async function fetchProxmoxBackups(ctx: Ctx) {
  return list(await get(ctx, "/cluster/backup"), 50).map((job) =>
    pickSimple(job, ["id", "enabled", "schedule", "starttime", "dow", "storage", "mode", "compress", "vmid", "all", "exclude", "prune-backups", "maxfiles", "notification-mode", "repeat-missed"]),
  );
}

/** Storage configurati: tipo, contenuti, conservazione (senza server, utenti né percorsi di rete). */
export async function fetchProxmoxStorages(ctx: Ctx) {
  return list(await get(ctx, "/storage"), 50).map((storage) => pickSimple(storage, ["storage", "type", "content", "shared", "nodes", "disable", "prune-backups", "maxfiles", "thinpool", "vgname"]));
}

/** Dischi fisici: tipo, capacità, stato di salute e usura (senza seriali né identificativi). */
export async function fetchProxmoxDisks(ctx: Ctx) {
  const node = await firstNode(ctx);
  return list(await get(ctx, `/nodes/${node}/disks/list`), 50).map((disk) => {
    const d = isRecord(disk) ? disk : {};
    return { ...pickSimple(d, ["type", "health", "wearout", "used", "model"]), sizeGb: gb(d.size) };
  });
}
