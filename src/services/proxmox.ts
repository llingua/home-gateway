import { getJson, baseUrl, requireSecret } from "../upstream";
import type { Ctx } from "../types";

interface Resource {
  type?: string;
  node?: string;
  name?: string;
  storage?: string;
  vmid?: number;
  status?: string;
  template?: number;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
}

export interface Guest {
  vmid: number;
  name: string;
  type: "vm" | "ct";
  running: boolean;
  cpuPct: number | null;
  memPct: number | null;
}

export interface StorageUse {
  name: string;
  usedPct: number | null;
  freeGb: number | null;
}

export interface BackupInfo {
  /** Fine dell'ultimo backup terminato (ISO). */
  lastAt: string;
  ok: boolean;
  durationMin: number | null;
}

export interface ProxmoxSummary {
  node: { name: string; online: boolean; cpuPct: number | null; memPct: number | null; uptimeSeconds: number | null } | null;
  guests: Guest[];
  storage: StorageUse[];
  /** null se non ci sono backup o se la lettura dei task non è permessa. */
  backup: BackupInfo | null;
}

const GB = 1024 ** 3;
const pct = (part?: number, total?: number): number | null =>
  typeof part === "number" && typeof total === "number" && total > 0 ? Math.round((part / total) * 100) : null;

/**
 * Stato dell'host Proxmox, dei guest, dello spazio e dell'ultimo backup.
 * Si espone solo ciò che serve a una dashboard: niente indirizzi IP, utenti o token.
 * Serve un token API con ruolo di sola lettura (PVEAuditor).
 */
export async function fetchProxmox(ctx: Ctx): Promise<ProxmoxSummary> {
  const token = requireSecret(ctx.env.PROXMOX_API_TOKEN, "proxmox");
  const base = baseUrl(ctx.env, "proxmox");
  const headers = { Authorization: `PVEAPIToken=${token}` };

  const resources = (await getJson<{ data?: Resource[] }>(ctx, `${base}/api2/json/cluster/resources`, { headers })).data ?? [];

  const nodeRes = resources.find((r) => r.type === "node" && r.status === "online") ?? resources.find((r) => r.type === "node");
  const node = nodeRes
    ? {
        name: nodeRes.node ?? nodeRes.name ?? "",
        online: nodeRes.status === "online",
        cpuPct: typeof nodeRes.cpu === "number" ? Math.round(nodeRes.cpu * 100) : null,
        memPct: pct(nodeRes.mem, nodeRes.maxmem),
        uptimeSeconds: typeof nodeRes.uptime === "number" ? nodeRes.uptime : null,
      }
    : null;

  const guests: Guest[] = resources
    .filter((r) => (r.type === "qemu" || r.type === "lxc") && !r.template && typeof r.vmid === "number")
    .map((r) => ({
      vmid: r.vmid as number,
      name: r.name ?? `${r.type}-${r.vmid}`,
      type: r.type === "lxc" ? ("ct" as const) : ("vm" as const),
      running: r.status === "running",
      cpuPct: typeof r.cpu === "number" ? Math.round(r.cpu * 100) : null,
      memPct: pct(r.mem, r.maxmem),
    }))
    .sort((a, b) => a.vmid - b.vmid);

  // Lo storage condiviso compare una volta per nodo: si tiene una voce per nome.
  const seen = new Set<string>();
  const storage: StorageUse[] = [];
  for (const r of resources) {
    if (r.type !== "storage" || !r.storage || seen.has(r.storage)) continue;
    seen.add(r.storage);
    storage.push({
      name: r.storage,
      usedPct: pct(r.disk, r.maxdisk),
      freeGb: typeof r.maxdisk === "number" && typeof r.disk === "number" ? Math.round(((r.maxdisk - r.disk) / GB) * 10) / 10 : null,
    });
  }

  return { node, guests, storage, backup: node ? await fetchLastBackup(ctx, base, headers, node.name) : null };
}

interface Task {
  type?: string;
  status?: string;
  starttime?: number;
  endtime?: number;
}

/** Ultimo backup (task vzdump) terminato. Se la lettura fallisce il resto dello stato resta valido. */
async function fetchLastBackup(ctx: Ctx, base: string, headers: Record<string, string>, node: string): Promise<BackupInfo | null> {
  try {
    const tasks =
      (
        await getJson<{ data?: Task[] }>(
          ctx,
          `${base}/api2/json/nodes/${encodeURIComponent(node)}/tasks?typefilter=vzdump&limit=20`,
          { headers },
        )
      ).data ?? [];
    const last = tasks
      .filter((task) => typeof task.endtime === "number")
      .sort((a, b) => (b.endtime ?? 0) - (a.endtime ?? 0))[0];
    if (!last || typeof last.endtime !== "number") return null;
    return {
      lastAt: new Date(last.endtime * 1000).toISOString(),
      ok: last.status === "OK",
      durationMin: typeof last.starttime === "number" ? Math.round((last.endtime - last.starttime) / 60) : null,
    };
  } catch {
    return null;
  }
}
