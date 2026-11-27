import { qbittorrentPreferences } from "./actions";
import { invalidateAllSections } from "./cache";
import { WriteError } from "./errors";
import type { Store } from "./store";
import type { CacheLike, Client, Ctx } from "./types";

/**
 * Modifiche "rapide" confermate in chat, senza la pagina /approve.
 * Solo i limiti di qBittorrent (stesse chiavi e stessi limiti fissi della proposta con approvazione): rischio basso,
 * effetto immediato e reversibile. Permesso separato `config:quick`, dato solo alla persona che entra dall'app (OAuth),
 * mai a un token di servizio. Tetto giornaliero, verifica dopo la scrittura, registro.
 */
export const QUICK_SCOPE = "config:quick";
export const MAX_QUICK_CHANGES_PER_DAY = 10;

const dayKey = (nowSeconds: number) => `limit:quick-qbt:${new Date(nowSeconds * 1000).toISOString().slice(0, 10)}`;

export interface QuickDeps {
  ctx: Ctx;
  store: Store;
  kv: { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> };
  now: () => number;
  cache?: CacheLike;
}

export async function quickQbittorrent(deps: QuickDeps, client: Client, input: { changes: unknown; confirmedByUser: unknown }) {
  const { ctx, store, kv, now } = deps;
  if (!(client.scopes.includes("*") || client.scopes.includes(QUICK_SCOPE))) throw new WriteError("forbidden", `Permesso mancante: ${QUICK_SCOPE}`);
  if (input.confirmedByUser !== true) {
    throw new WriteError("not_confirmed", "Mostra alla persona i valori attuali e quelli nuovi e passa confirmedByUser: true solo dopo il suo sì esplicito in chat");
  }
  const parsed = qbittorrentPreferences.parse({ changes: input.changes });

  const key = dayKey(now());
  const used = Number((await kv.get(key)) ?? "0") || 0;
  if (used >= MAX_QUICK_CHANGES_PER_DAY) {
    throw new WriteError("daily_limit", `Limite giornaliero raggiunto (${MAX_QUICK_CHANGES_PER_DAY} modifiche rapide): usa una proposta con approvazione (propose_qbittorrent_preferences)`);
  }

  const draft = await qbittorrentPreferences.plan(ctx, parsed); // legge i valori attuali; "no_change" se sono già questi
  // Si conta il tentativo PRIMA di scrivere: un errore a metà non permette di aggirare il tetto.
  await kv.put(key, String(used + 1), { expirationTtl: 2 * 24 * 3600 });

  const detail = draft.changes.map((change) => `${change.field}: ${String(change.from)} → ${String(change.to)}`).join(", ");
  try {
    await qbittorrentPreferences.apply(ctx, parsed, draft.changes);
  } catch {
    await store.audit({ event: "modifica_rapida_fallita", actor: client.name, action: "qbittorrent_preferences", detail });
    throw new WriteError("apply_failed", "qBittorrent non ha confermato i nuovi valori: controlla le impostazioni o riprova con una proposta");
  } finally {
    await invalidateAllSections(deps.cache);
  }
  await store.audit({ event: "modifica_rapida", actor: client.name, action: "qbittorrent_preferences", detail });

  const undo = (draft.undo?.input as { changes?: Record<string, unknown> } | undefined)?.changes;
  return {
    applied: true,
    verified: true,
    changes: draft.changes.map((change) => ({ field: change.field, from: change.from, to: change.to })),
    ...(undo ? { toUndo: { tool: "set_qbittorrent_preferences", changes: undo, note: "Per tornare indietro: stessi passi, con questi valori e un nuovo sì della persona" } } : {}),
    quickChangesToday: used + 1,
    dailyLimit: MAX_QUICK_CHANGES_PER_DAY,
  };
}
