import { findAction } from "./actions";
import { hasScope } from "./auth";
import { WriteError } from "./errors";
import { APPROVAL_TTL_SECONDS, MAX_PENDING_PLANS, newPlanId, PROPOSAL_TTL_SECONDS, type StoredPlan, type Store } from "./store";
import type { Client, Env, Fetcher } from "./types";

/**
 * Scritture con approvazione umana.
 *  1. L'agente PROPONE: il gateway calcola cosa cambierebbe e lo salva. Non cambia nulla.
 *  2. Una PERSONA approva dal browser (accesso personale, pagina `/approve/<id>`). Il token dell'agente non può.
 *  3. L'agente chiede di APPLICARE: il gateway esegue solo se il piano è approvato, non scaduto e lo stato non è cambiato.
 * Non esiste nessun altro modo di modificare qualcosa.
 */

export interface WriteCtx {
  env: Env;
  fetch: Fetcher;
  store: Store;
  /** Secondi Unix. */
  now: () => number;
  /** Origine pubblica del gateway, per il link di approvazione. */
  origin: string;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

function publicView(plan: StoredPlan, origin: string) {
  return {
    planId: plan.id,
    action: plan.action,
    status: plan.status,
    summary: plan.summary,
    changes: plan.changes,
    proposedBy: plan.proposedBy,
    expiresAt: iso(plan.expiresAt),
    ...(plan.decidedBy ? { decidedAt: plan.decidedAt ? iso(plan.decidedAt) : undefined } : {}),
    ...(plan.result ? { result: plan.result } : {}),
    ...(plan.status === "pending" ? { approvalUrl: `${origin}/approve/${plan.id}` } : {}),
    canUndo: plan.status === "applied" && plan.undo !== null,
  };
}

export async function propose(w: WriteCtx, client: Client, actionName: string, rawInput: unknown) {
  const action = findAction(actionName);
  if (!action) throw new WriteError("unknown_action", `Azione sconosciuta: ${actionName}`);
  if (!hasScope(client, action.scope)) throw new WriteError("forbidden", `Permesso mancante: ${action.scope}`);

  const input = action.parse(rawInput);
  if ((await w.store.countPending()) >= MAX_PENDING_PLANS) {
    throw new WriteError("too_many_pending", `Ci sono già ${MAX_PENDING_PLANS} proposte in attesa di approvazione: vanno approvate, rifiutate o devono scadere`);
  }

  const draft = await action.plan({ env: w.env, fetch: w.fetch }, input);
  const now = w.now();
  const plan: StoredPlan = {
    id: newPlanId(),
    action: action.name,
    input,
    summary: draft.summary,
    changes: draft.changes,
    undo: draft.undo,
    status: "pending",
    proposedBy: client.name,
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_SECONDS,
  };
  await w.store.savePlan(plan);
  await w.store.audit({ event: "proposta", actor: client.name, planId: plan.id, action: plan.action, detail: plan.summary });
  return {
    ...publicView(plan, w.origin),
    nextStep: "Nulla è stato modificato. Chiedi alla persona di aprire approvalUrl nel browser e approvare; poi chiama apply_plan con planId.",
  };
}

export async function getPlanView(w: WriteCtx, planId: string) {
  const plan = await w.store.getPlan(planId);
  if (!plan) throw new WriteError("not_found", "Piano non trovato (o scaduto da più di 7 giorni)");
  return publicView(effectiveStatus(plan, w.now()), w.origin);
}

/** Un piano aperto oltre la scadenza risulta "scaduto" anche se nessuno ha ancora aggiornato il suo stato. */
function effectiveStatus(plan: StoredPlan, now: number): StoredPlan {
  const open = plan.status === "pending" || plan.status === "approved";
  return open && now > plan.expiresAt ? { ...plan, status: "failed", result: "Scaduto: va riproposto" } : plan;
}

export async function applyPlan(w: WriteCtx, client: Client, planId: string) {
  const stored = await w.store.getPlan(planId);
  if (!stored) throw new WriteError("not_found", "Piano non trovato");
  const action = findAction(stored.action);
  if (!action) throw new WriteError("unknown_action", "Azione non più disponibile");
  if (!hasScope(client, action.scope)) throw new WriteError("forbidden", `Permesso mancante: ${action.scope}`);

  if (w.now() > stored.expiresAt && (stored.status === "pending" || stored.status === "approved")) {
    throw new WriteError("expired", "Il piano è scaduto: va riproposto e approvato di nuovo");
  }
  if (stored.status === "pending") throw new WriteError("not_approved", "Il piano non è ancora stato approvato da una persona");
  if (stored.status === "rejected") throw new WriteError("rejected", "Il piano è stato rifiutato");
  if (stored.status !== "approved") throw new WriteError("already_used", `Il piano non è applicabile (stato: ${stored.status}): ogni piano si applica una volta sola`);

  // Si segna subito come "in applicazione": un secondo apply non può rieseguirlo.
  const plan: StoredPlan = { ...stored, status: "applying" };
  await w.store.savePlan(plan);
  const ctx = { env: w.env, fetch: w.fetch };

  try {
    if (!(await action.stillValid(ctx, plan.input, plan.changes))) {
      throw new WriteError("state_changed", "Lo stato è cambiato dopo la proposta: nulla è stato modificato, rifai la proposta");
    }
    const message = await action.apply(ctx, plan.input);
    const done: StoredPlan = { ...plan, status: "applied", appliedAt: w.now(), result: message };
    await w.store.savePlan(done);
    await w.store.audit({ event: "applicata", actor: client.name, planId: plan.id, action: plan.action, detail: message });
    return { ...publicView(done, w.origin), nextStep: done.undo ? "Per tornare indietro: propose_undo con questo planId (richiede una nuova approvazione)." : undefined };
  } catch (error) {
    const message = error instanceof WriteError ? error.message : error instanceof Error ? error.message : "Errore sconosciuto";
    await w.store.savePlan({ ...plan, status: "failed", result: message });
    await w.store.audit({ event: "fallita", actor: client.name, planId: plan.id, action: plan.action, detail: message });
    if (error instanceof WriteError) throw error;
    throw new WriteError("apply_failed", `Applicazione fallita: ${message}`);
  }
}

export async function proposeUndo(w: WriteCtx, client: Client, planId: string) {
  const plan = await w.store.getPlan(planId);
  if (!plan) throw new WriteError("not_found", "Piano non trovato");
  if (plan.status !== "applied") throw new WriteError("not_applicable", "Si può annullare solo un piano già applicato");
  if (!plan.undo) throw new WriteError("not_reversible", "Questo piano non ha un annullamento automatico");
  return propose(w, client, plan.undo.action, plan.undo.input);
}

export async function auditLog(w: WriteCtx, limit: number) {
  return { entries: await w.store.recentAudit(limit) };
}

/** Usata dalla pagina di approvazione: segna la decisione di una persona. */
export async function decide(w: Pick<WriteCtx, "store" | "now">, planId: string, approver: string, approve: boolean): Promise<{ ok: boolean; message: string; plan: StoredPlan | null }> {
  const plan = await w.store.getPlan(planId);
  if (!plan) return { ok: false, message: "Piano non trovato o scaduto", plan: null };
  const now = w.now();
  if (plan.status !== "pending") return { ok: false, message: `Il piano non è più in attesa (stato: ${plan.status})`, plan };
  if (now > plan.expiresAt) return { ok: false, message: "Il piano è scaduto: va riproposto", plan };

  const next: StoredPlan = approve
    ? { ...plan, status: "approved", decidedBy: approver, decidedAt: now, expiresAt: now + APPROVAL_TTL_SECONDS }
    : { ...plan, status: "rejected", decidedBy: approver, decidedAt: now };
  await w.store.savePlan(next);
  await w.store.audit({ event: approve ? "approvata" : "rifiutata", actor: approver, planId: plan.id, action: plan.action, detail: plan.summary });
  return { ok: true, message: approve ? "Approvato. L'agente può ora applicare la modifica (entro 10 minuti)." : "Rifiutato. Non verrà modificato nulla.", plan: next };
}
