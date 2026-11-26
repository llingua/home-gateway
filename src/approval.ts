import { verifyAccessJwt } from "./auth";
import { decide } from "./writes";
import { Store, type StoredPlan } from "./store";
import type { Env, Fetcher } from "./types";

/**
 * Pagina di approvazione: `GET/POST /approve/<id>`.
 *
 * Solo una PERSONA può approvare: serve un accesso Cloudflare Access personale (con email) su un'app Access
 * dedicata a questo percorso, e l'email deve essere nell'elenco `APPROVERS`. I token di servizio (quelli degli agenti)
 * non hanno un'email e non passano. Il token anti-CSRF lega ogni decisione a quel piano e a quella persona.
 */

export interface ApprovalDeps {
  fetch: Fetcher;
  /** Secondi Unix. */
  now?: number;
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;line-height:1.5;color:#111}
h1{font-size:20px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:14px;overflow-wrap:anywhere}
th{background:#f3f3f3}.box{border:1px solid #ccc;border-radius:8px;padding:12px 16px;margin:12px 0}.meta{color:#555;font-size:13px}
button{font-size:16px;padding:10px 18px;border-radius:8px;border:1px solid #888;cursor:pointer;margin-right:8px}
.ok{background:#0a7d32;color:#fff;border-color:#0a7d32}.no{background:#fff}.warn{color:#8a4b00}`;

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`,
    { status, headers: PAGE_HEADERS },
  );
}

const show = (value: unknown) => escapeHtml(typeof value === "string" ? value : JSON.stringify(value));

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function planPage(plan: StoredPlan, csrf: string | null, note?: string): Response {
  const rows = plan.changes
    .map((change) => `<tr><td>${escapeHtml(change.target)}</td><td>${escapeHtml(change.field)}</td><td>${show(change.from)}</td><td><strong>${show(change.to)}</strong></td></tr>`)
    .join("");
  const buttons =
    plan.status === "pending" && csrf
      ? `<form method="post" action="/approve/${escapeHtml(plan.id)}">
           <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
           <button class="ok" name="decision" value="approve" type="submit">Approva</button>
           <button class="no" name="decision" value="reject" type="submit">Rifiuta</button>
         </form>`
      : `<p class="meta">Stato: <strong>${escapeHtml(plan.status)}</strong></p>`;
  return page(
    "Approva modifica",
    `<h1>Approvare questa modifica?</h1>
     ${note ? `<p class="warn">${escapeHtml(note)}</p>` : ""}
     <div class="box"><strong>${escapeHtml(plan.summary)}</strong>
       <p class="meta">Proposta da: ${escapeHtml(plan.proposedBy)} · scade: ${escapeHtml(new Date(plan.expiresAt * 1000).toLocaleString("it-IT", { timeZone: "Europe/Rome" }))}</p></div>
     <table><thead><tr><th>Dove</th><th>Impostazione</th><th>Prima</th><th>Dopo</th></tr></thead><tbody>${rows}</tbody></table>
     ${buttons}
     <p class="meta">Approvando non cambia ancora nulla: la modifica viene eseguita solo quando l'agente la applica, entro 10 minuti, e solo se lo stato non è cambiato nel frattempo. Dopo si può annullare con un'altra proposta.</p>`,
  );
}

export async function handleApproval(request: Request, env: Env, deps: ApprovalDeps): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/approve\/([a-f0-9]{32})\/?$/.exec(url.pathname);
  if (!match) return page("Non trovato", "<h1>Non trovato</h1>", 404);
  const planId = match[1]!;

  // Senza questi valori le scritture sono spente: nessuna pagina, nessuna approvazione.
  if (!env.STATE || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD_APPROVAL || !env.APPROVERS || !env.APPROVAL_SECRET) {
    return page("Non disponibile", "<h1>Scritture non configurate</h1>", 503);
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return page("Accesso richiesto", "<h1>Accesso richiesto</h1>", 401);

  let email: string | undefined;
  try {
    const claims = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD_APPROVAL, fetch: deps.fetch, now: deps.now });
    email = claims.email?.toLowerCase();
  } catch {
    return page("Accesso non valido", "<h1>Accesso non valido</h1>", 401);
  }
  const approvers = env.APPROVERS.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  // Un token di servizio non ha un'email: non può mai approvare.
  if (!email || !approvers.includes(email)) return page("Non autorizzato", "<h1>Non sei autorizzato ad approvare</h1>", 403);

  const now = () => deps.now ?? Math.floor(Date.now() / 1000);
  const store = new Store(env.STATE, now);
  const csrf = await hmacHex(env.APPROVAL_SECRET, `${planId}|${email}`);

  if (request.method === "GET") {
    const plan = await store.getPlan(planId);
    if (!plan) return page("Non trovato", "<h1>Piano non trovato o scaduto</h1>", 404);
    return planPage(plan, csrf, now() > plan.expiresAt && plan.status === "pending" ? "Questo piano è scaduto: va riproposto." : undefined);
  }

  if (request.method !== "POST") return page("Metodo non ammesso", "<h1>Metodo non ammesso</h1>", 405);

  // Difesa dalle richieste contraffatte: la decisione deve partire da questa stessa pagina.
  if (request.headers.get("Origin") !== url.origin) return page("Richiesta rifiutata", "<h1>Richiesta rifiutata</h1>", 403);
  const form = await request.formData().catch(() => null);
  const sentCsrf = typeof form?.get("csrf") === "string" ? (form!.get("csrf") as string) : "";
  const decision = form?.get("decision");
  if (!sameString(sentCsrf, csrf) || (decision !== "approve" && decision !== "reject")) {
    return page("Richiesta rifiutata", "<h1>Richiesta rifiutata</h1>", 403);
  }

  const result = await decide({ store, now }, planId, email, decision === "approve");
  if (!result.plan) return page("Non trovato", `<h1>${escapeHtml(result.message)}</h1>`, 404);
  return planPage(result.plan, null, result.message);
}
