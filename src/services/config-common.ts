/** Utilità per le letture di configurazione (solo campi noti, per nome, e solo valori semplici). */

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isPrimitive = (value: unknown): value is string | number | boolean | null => value === null || ["string", "number", "boolean"].includes(typeof value);

/** Valore innocuo: primitivo, oppure elenco di primitivi (stringhe accorciate). */
function simple(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 200);
  if (isPrimitive(value)) return value;
  if (Array.isArray(value) && value.length <= 100 && value.every(isPrimitive)) return value.map((item) => (typeof item === "string" ? item.slice(0, 200) : item));
  return undefined;
}

/** Prende SOLO le chiavi elencate (nome esatto) e solo se il valore è semplice. */
export function pickSimple(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(source)) return out;
  for (const key of keys) {
    if (!(key in source)) continue;
    const value = simple(source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export const list = (value: unknown, max = 100): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
