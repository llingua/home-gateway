import { HttpError } from "./errors";
import type { Client, Env, Fetcher } from "./types";

/**
 * Autenticazione dei clienti.
 *
 * Il gateway sta dietro Cloudflare Access, che per ogni richiesta valida (service token o utente)
 * aggiunge l'intestazione `Cf-Access-Jwt-Assertion`. Qui NON ci si fida dell'intestazione:
 * si verifica la firma, l'emittente, il destinatario (AUD) e la scadenza, così il Worker
 * resta sicuro anche se per errore venisse esposto fuori da Access.
 * Se manca la configurazione, il Worker rifiuta tutto (fail closed).
 */

export interface AccessClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
  /** Nei token di servizio è il Client ID. */
  common_name?: string;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

interface Jwks {
  keys: Jwk[];
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, { at: number; jwks: Jwks }>();

/** Solo per i test. */
export function clearJwksCache(): void {
  jwksCache.clear();
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as T;
}

async function loadJwks(fetcher: Fetcher, teamDomain: string, force: boolean, now: number): Promise<Jwks> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const cached = jwksCache.get(url);
  if (!force && cached && now - cached.at < JWKS_TTL_MS) return cached.jwks;

  const response = await fetcher(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error("jwks_unavailable");
  const jwks = (await response.json()) as Jwks;
  jwksCache.set(url, { at: now, jwks });
  return jwks;
}

export interface VerifyOptions {
  teamDomain: string;
  aud: string;
  fetch: Fetcher;
  /** Secondi Unix; sostituibile nei test. */
  now?: number;
}

export async function verifyAccessJwt(token: string, options: VerifyOptions): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJson<{ alg?: string; kid?: string }>(headerPart);
  if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported_alg");

  const nowSeconds = options.now ?? Math.floor(Date.now() / 1000);
  const nowMs = nowSeconds * 1000;

  let jwks = await loadJwks(options.fetch, options.teamDomain, false, nowMs);
  let jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    // Le chiavi ruotano: un solo nuovo tentativo prima di rifiutare.
    jwks = await loadJwks(options.fetch, options.teamDomain, true, nowMs);
    jwk = jwks.keys.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw new Error("unknown_key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("bad_signature");

  const claims = decodeJson<AccessClaims>(payloadPart);
  if (claims.iss !== `https://${options.teamDomain}`) throw new Error("bad_issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(options.aud)) throw new Error("bad_audience");
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) throw new Error("expired");
  if (typeof claims.nbf === "number" && claims.nbf > nowSeconds) throw new Error("not_yet_valid");
  return claims;
}

export function parseClients(raw: string | Record<string, Client> | undefined): Record<string, Client> {
  if (!raw) return {};
  try {
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, Client>;
    const clients: Record<string, Client> = {};
    for (const [id, client] of Object.entries(parsed)) {
      if (client && typeof client.name === "string" && Array.isArray(client.scopes)) {
        clients[id.toLowerCase()] = { name: client.name, scopes: client.scopes.filter((s) => typeof s === "string") };
      }
    }
    return clients;
  } catch {
    return {};
  }
}

export function hasScope(client: Client, scope: string): boolean {
  return client.scopes.includes("*") || client.scopes.includes(scope);
}

export interface AuthDeps {
  fetch: Fetcher;
  now?: number;
}

/** Identifica il cliente o solleva HttpError (401 token assente o non valido, 403 cliente sconosciuto). */
export async function authenticate(request: Request, env: Env, deps: AuthDeps): Promise<Client> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(500, "auth_not_configured", "Autenticazione non configurata");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new HttpError(401, "missing_token", "Autenticazione richiesta");

  const verify = (aud: string) => verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN!, aud, fetch: deps.fetch, now: deps.now });

  let claims: AccessClaims;
  let viaOAuth = false;
  try {
    claims = await verify(env.ACCESS_AUD);
  } catch {
    // Secondo ingresso: l'app Access con Managed OAuth (una persona che entra da un'app come Claude).
    if (!env.ACCESS_AUD_OAUTH) throw new HttpError(401, "invalid_token", "Token non valido");
    try {
      claims = await verify(env.ACCESS_AUD_OAUTH);
      viaOAuth = true;
    } catch {
      throw new HttpError(401, "invalid_token", "Token non valido");
    }
  }

  if (viaOAuth) {
    // Solo persone (serve l'email; un token di servizio non entra da qui) e solo chi è già nell'elenco
    // degli approvatori o tra i clienti con quell'email. Le scritture restano comunque da approvare in /approve.
    const email = claims.email?.toLowerCase();
    if (!email) throw new HttpError(403, "unknown_client", "Cliente non autorizzato");
    const listed = parseClients(env.CLIENTS)[email];
    if (listed) return listed;
    const approvers = (env.APPROVERS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    if (approvers.includes(email)) return { name: "app-claude", scopes: ["media:read", "config:read", "config:write"] };
    throw new HttpError(403, "unknown_client", "Cliente non autorizzato");
  }

  const identity = (claims.common_name ?? claims.email)?.toLowerCase();
  const client = identity ? parseClients(env.CLIENTS)[identity] : undefined;
  if (!client) throw new HttpError(403, "unknown_client", "Cliente non autorizzato");
  return client;
}
