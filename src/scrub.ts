/**
 * Rete di sicurezza per le sezioni di configurazione (permesso `config:read`).
 *
 * Gli adapter scelgono già solo i campi innocui (whitelist). Qui, in più, si toglie da QUALSIASI risposta
 * ogni chiave che somiglia a un segreto e si oscurano i valori che ne hanno l'aspetto, così un errore in un
 * adapter (o un campo nuovo in un servizio) non diventa una fuga di chiavi.
 */

export const REDACTED = "[redatto]";

const SECRET_KEY =
  /(api[-_ ]?key|apikey|pass(word|wd|phrase)?$|pass(word|wd|phrase)|secret|token|cookie|authorization|credential|username|e-?mail|salt|private[-_ ]?key|bearer|session|^sid$|^fields$|^auth$|proxy_(ip|username|password|port)|autorun|webhook)/i;

const LONG_HEX = /^[a-f0-9]{32,}$/i;
const LONG_B64 = /^[A-Za-z0-9+/_-]{40,}={0,2}$/;
const BEARER = /^(bearer|basic|pveapitoken)\s*[=\s]\S+/i;
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

function looksSecret(value: string): boolean {
  return LONG_HEX.test(value) || LONG_B64.test(value) || BEARER.test(value) || URL_WITH_CREDENTIALS.test(value);
}

export function scrubSecrets<T>(value: T, depth = 0): T {
  if (depth > 10) return REDACTED as unknown as T;
  if (typeof value === "string") return (looksSecret(value) ? REDACTED : value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      out[key] = scrubSecrets(item, depth + 1);
    }
    return out as T;
  }
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Chiavi che indicano indirizzi o reti: mai nelle risposte (le chiavi e le password le toglie anche scrubSecrets). */
const ADDRESS_KEY = /(url|uri|host|address|network|ip$|endpoint|domain)/i;
const URL_VALUE = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/;

/** Copia i dati togliendo indirizzi, reti e URL. Usato per le sezioni con campi noti solo in parte. */
export function stripAddresses(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") return URL_VALUE.test(value) || IPV4.test(value) ? "[omesso]" : value.slice(0, 200);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => stripAddresses(item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (ADDRESS_KEY.test(key)) continue;
      out[key] = stripAddresses(item, depth + 1);
    }
    return out;
  }
  return value;
}
