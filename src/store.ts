import type { KvLike } from "./types";

/**
 * Piani di modifica (da approvare) e registro delle operazioni, su un KV.
 * Un piano non si modifica dopo la proposta: cambia solo il suo stato.
 */

export type PlanStatus = "pending" | "approved" | "rejected" | "applying" | "applied" | "failed";

export interface PlanChange {
  target: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface StoredPlan {
  id: string;
  action: string;
  input: Record<string, unknown>;
  summary: string;
  changes: PlanChange[];
  /** Come tornare indietro: una nuova azione, da proporre e approvare di nuovo. */
  undo: { action: string; input: Record<string, unknown> } | null;
  status: PlanStatus;
  proposedBy: string;
  createdAt: number;
  /** Scadenza (secondi Unix): dopo, il piano non si può più approvare né applicare. */
  expiresAt: number;
  decidedBy?: string;
  decidedAt?: number;
  appliedAt?: number;
  result?: string;
}

export interface AuditEntry {
  at: string;
  event: string;
  actor: string;
  planId?: string;
  action?: string;
  detail?: string;
}

export const PROPOSAL_TTL_SECONDS = 15 * 60;
export const APPROVAL_TTL_SECONDS = 10 * 60;
const DONE_TTL_SECONDS = 7 * 24 * 3600;
const AUDIT_TTL_SECONDS = 90 * 24 * 3600;
export const MAX_PENDING_PLANS = 10;

const PLAN_ID = /^[a-f0-9]{32}$/;

export function newPlanId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Store {
  constructor(
    private readonly kv: KvLike,
    private readonly now: () => number,
  ) {}

  async savePlan(plan: StoredPlan): Promise<void> {
    const open = plan.status === "pending" || plan.status === "approved" || plan.status === "applying";
    const remaining = plan.expiresAt - this.now();
    // KV vuole almeno 60 secondi di vita: un piano appena scaduto resta leggibile per poco e viene rifiutato per scadenza.
    const ttl = open ? Math.max(60, remaining) : DONE_TTL_SECONDS;
    await this.kv.put(`plan:${plan.id}`, JSON.stringify(plan), { expirationTtl: ttl, metadata: { status: plan.status } });
  }

  async getPlan(id: string): Promise<StoredPlan | null> {
    if (!PLAN_ID.test(id)) return null;
    const raw = await this.kv.get(`plan:${id}`);
    return raw ? (JSON.parse(raw) as StoredPlan) : null;
  }

  async countPending(): Promise<number> {
    const { keys } = await this.kv.list({ prefix: "plan:", limit: 200 });
    return keys.filter((key) => (key.metadata as { status?: string } | undefined)?.status === "pending").length;
  }

  async audit(entry: Omit<AuditEntry, "at">): Promise<void> {
    const at = new Date(this.now() * 1000).toISOString();
    const rand = crypto.getRandomValues(new Uint8Array(4));
    const suffix = Array.from(rand, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await this.kv.put(`audit:${at}:${suffix}`, JSON.stringify({ at, ...entry }), { expirationTtl: AUDIT_TTL_SECONDS });
  }

  async recentAudit(limit = 20): Promise<AuditEntry[]> {
    const { keys } = await this.kv.list({ prefix: "audit:", limit: 1000 });
    const names = keys.map((key) => key.name).sort().slice(-Math.min(Math.max(limit, 1), 100)).reverse();
    const entries = await Promise.all(names.map((name) => this.kv.get(name)));
    return entries.filter((raw): raw is string => raw !== null).map((raw) => JSON.parse(raw) as AuditEntry);
  }
}
