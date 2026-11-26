import type { ActionDef, PlanDraft } from "./actions";
import { WriteError } from "./errors";
import type { PlanChange } from "./store";
import { baseUrl, getJson, request, requireSecret } from "./upstream";
import type { Ctx } from "./types";

/**
 * Modifiche alle impostazioni generali di Bazarr (ricerca e aggiornamento dei sottotitoli, punteggi, profilo lingua predefinito).
 *
 * Bazarr accetta la scrittura solo come modulo (`application/x-www-form-urlencoded`) con chiavi `settings-general-<nome>` e valori testuali
 * ("true"/"false", numeri come testo); le chiavi non inviate non si toccano. Il suo gestore tocca anche le lingue attive e i profili quando
 * quelle chiavi sono presenti: per non rischiare di cambiarle per errore, il gateway rimanda IDENTICHE le lingue attive (lette prima) e NON invia
 * i profili; se le lingue attive non si leggono, non scrive. Dopo la scrittura rilegge e verifica anche che lingue e profili siano rimasti uguali.
 * Non si toccano provider, credenziali, collegamenti a Sonarr/Radarr, percorsi né comandi.
 */

type Field = { type: "bool" } | { type: "int"; min: number; max: number } | { type: "enum"; values: readonly (string | number)[] } | { type: "profile" };

const FREQUENCIES = [6, 12, 24, 168] as const; // ore (876000 = mai: non ammesso)
const FIELDS: Record<string, Field> = {
  serie_default_enabled: { type: "bool" },
  serie_default_profile: { type: "profile" },
  movie_default_enabled: { type: "bool" },
  movie_default_profile: { type: "profile" },
  minimum_score: { type: "int", min: 0, max: 100 },
  minimum_score_movie: { type: "int", min: 0, max: 100 },
  upgrade_subs: { type: "bool" },
  upgrade_manual: { type: "bool" },
  days_to_upgrade_subs: { type: "int", min: 0, max: 30 },
  upgrade_frequency: { type: "enum", values: FREQUENCIES },
  wanted_search_frequency: { type: "enum", values: FREQUENCIES },
  wanted_search_frequency_movie: { type: "enum", values: FREQUENCIES },
  adaptive_searching: { type: "bool" },
  adaptive_searching_delay: { type: "enum", values: ["1w", "2w", "3w", "4w"] },
  adaptive_searching_delta: { type: "enum", values: ["3d", "1w", "2w", "3w", "4w"] },
  use_scenename: { type: "bool" },
  single_language: { type: "bool" },
  utf8_encode: { type: "bool" },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const describe = () =>
  Object.entries(FIELDS)
    .map(([key, f]) => (f.type === "int" ? `${key} (${f.min}-${f.max})` : f.type === "enum" ? `${key} (${f.values.join("|")})` : f.type === "profile" ? `${key} (id di un profilo lingua esistente)` : `${key} (vero/falso)`))
    .join(", ");

function access(ctx: Ctx) {
  return { base: baseUrl(ctx.env, "bazarr"), headers: { "X-API-KEY": requireSecret(ctx.env.BAZARR_API_KEY, "bazarr") } };
}

async function readGeneral(ctx: Ctx): Promise<Record<string, unknown>> {
  const { base, headers } = access(ctx);
  const settings = await getJson<unknown>(ctx, `${base}/api/system/settings`, { headers });
  const general = isRecord(settings) ? settings.general : undefined;
  const out: Record<string, unknown> = {};
  if (isRecord(general)) for (const key of Object.keys(FIELDS)) if (key in general) out[key] = general[key];
  return out;
}

async function readProfiles(ctx: Ctx): Promise<unknown[]> {
  const { base, headers } = access(ctx);
  const data = await getJson<unknown>(ctx, `${base}/api/system/languages/profiles`, { headers });
  if (!Array.isArray(data)) throw new WriteError("unexpected_response", "Bazarr ha risposto in un formato inatteso");
  return data;
}

/** Codici delle lingue attive, nell'ordine in cui Bazarr le elenca. Se non si leggono, non si scrive. */
async function readEnabledLanguages(ctx: Ctx): Promise<string[]> {
  const { base, headers } = access(ctx);
  const data = await getJson<unknown>(ctx, `${base}/api/system/languages`, { headers });
  if (!Array.isArray(data)) throw new WriteError("languages_unavailable", "Non riesco a leggere le lingue attive di Bazarr: non scrivo per non cambiarle per errore");
  const codes = data.filter(isRecord).filter((l) => l.enabled === true || l.enabled === 1).map((l) => l.code2);
  if (!codes.every((c): c is string => typeof c === "string" && /^[a-z]{2,3}(-[A-Za-z]+)?$/.test(c))) throw new WriteError("languages_unavailable", "Le lingue attive di Bazarr hanno un formato inatteso: non scrivo");
  return codes as string[];
}

const encode = (value: string | number | boolean) => (typeof value === "boolean" ? (value ? "true" : "false") : String(value));

export const bazarrGeneral: ActionDef = {
  name: "bazarr_general",
  services: ["bazarr"],
  description:
    `Bazarr: cambia le impostazioni generali di ricerca e aggiornamento dei sottotitoli. Chiavi ammesse: ${describe()}. ` +
    "I profili lingua si leggono da get_config_bazarr (languageProfiles). Non tocca provider, credenziali, collegamenti a Sonarr/Radarr né comandi.",
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      changes: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(FIELDS).map(([key, f]) => [
            key,
            f.type === "bool" ? { type: "boolean" } : f.type === "int" || f.type === "profile" ? { type: "integer", minimum: f.type === "int" ? f.min : 1, maximum: f.type === "int" ? f.max : 100_000 } : { enum: [...f.values] },
          ]),
        ),
        additionalProperties: false,
      },
    },
    required: ["changes"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || !isRecord(input.changes) || Object.keys(input).some((key) => key !== "changes")) throw new WriteError("invalid_input", "Serve un oggetto `changes` con le impostazioni da cambiare");
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(input.changes)) {
      const field = Object.prototype.hasOwnProperty.call(FIELDS, key) ? FIELDS[key] : undefined;
      if (!field) throw new WriteError("invalid_input", `Impostazione non modificabile: ${key}`);
      if (field.type === "bool") {
        if (typeof value !== "boolean") throw new WriteError("invalid_input", `${key} deve essere true o false`);
      } else if (field.type === "int") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) throw new WriteError("invalid_input", `${key} deve essere un intero tra ${field.min} e ${field.max}`);
      } else if (field.type === "profile") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100_000) throw new WriteError("invalid_input", `${key} deve essere l'id (intero positivo) di un profilo lingua`);
      } else if (!field.values.includes(value as string | number)) {
        throw new WriteError("invalid_input", `${key} deve essere uno tra: ${field.values.join(", ")}`);
      }
      out[key] = value as string | number | boolean;
    }
    if (Object.keys(out).length === 0) throw new WriteError("invalid_input", "Nessuna impostazione indicata");
    return { changes: out };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const wanted = input.changes as Record<string, string | number | boolean>;
    const general = await readGeneral(ctx);
    if (Object.keys(wanted).some((key) => FIELDS[key]?.type === "profile")) {
      const ids = (await readProfiles(ctx)).filter(isRecord).map((profile) => profile.profileId);
      for (const [key, value] of Object.entries(wanted)) {
        if (FIELDS[key]?.type === "profile" && !ids.includes(value)) throw new WriteError("invalid_input", `Il profilo lingua ${String(value)} non esiste in Bazarr`);
      }
    }
    const changes: PlanChange[] = [];
    const before: Record<string, string | number | boolean> = {};
    for (const [key, to] of Object.entries(wanted)) {
      if (!(key in general)) throw new WriteError("not_supported", `Questa versione di Bazarr non ha l'impostazione ${key}`);
      const from = general[key];
      if (from === to) continue;
      changes.push({ target: "Bazarr: impostazioni generali", field: key, from, to });
      // Un profilo predefinito vuoto ("") non si può ripristinare da qui: in quel caso l'annullo non è automatico.
      if (typeof from === "boolean" || typeof from === "number" || (typeof from === "string" && FIELDS[key]?.type !== "profile" && from !== "")) before[key] = from;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    return {
      summary: `Bazarr: cambia ${changes.map((change) => change.field).join(", ")}`,
      changes,
      undo: Object.keys(before).length === changes.length ? { action: "bazarr_general", input: { changes: before } } : null,
    };
  },
  async stillValid(ctx, _input, changes) {
    const general = await readGeneral(ctx);
    return changes.every((change) => general[change.field] === change.from);
  },
  async apply(ctx, input) {
    const wanted = input.changes as Record<string, string | number | boolean>;
    const { base, headers } = access(ctx);
    const languagesBefore = await readEnabledLanguages(ctx);
    const profilesBefore = JSON.stringify(await readProfiles(ctx));

    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(wanted)) form.append(`settings-general-${key}`, encode(value));
    for (const code of languagesBefore) form.append("languages-enabled", code); // identiche: così non cambiano
    await request(ctx, `${base}/api/system/settings`, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: form });

    const after = await readGeneral(ctx);
    if (Object.entries(wanted).some(([key, value]) => after[key] !== value)) throw new Error("Verifica fallita: Bazarr non riporta i nuovi valori");
    if (JSON.stringify(await readEnabledLanguages(ctx)) !== JSON.stringify(languagesBefore)) throw new Error("Verifica fallita: le lingue attive di Bazarr sono cambiate");
    if (JSON.stringify(await readProfiles(ctx)) !== profilesBefore) throw new Error("Verifica fallita: i profili lingua di Bazarr sono cambiati");
    return `Applicato e verificato: ${Object.entries(wanted).map(([key, value]) => `${key}=${value}`).join(", ")}`;
  },
};

// --- Assegnare un profilo lingua a serie e film che non ne hanno ---------------------------------------------------------

/**
 * Assegna un profilo lingua alle serie o ai film SENZA profilo. Non sovrascrive mai un profilo già assegnato, non avvia ricerche di
 * sottotitoli (Bazarr ricalcola solo l'elenco dei mancanti) e agisce su un numero limitato di elementi per volta: il piano contiene
 * l'elenco esatto di quelli che verranno toccati, e l'applicazione tocca ESATTAMENTE quelli approvati.
 */
const BATCH = 100;
type Kind = "series" | "movies";
const KINDS: Record<Kind, { idKey: string; label: string; queryIds: string; formIds: string }> = {
  series: { idKey: "sonarrSeriesId", label: "serie", queryIds: "seriesid[]", formIds: "seriesid" },
  movies: { idKey: "radarrId", label: "film", queryIds: "radarrid[]", formIds: "radarrid" },
};

interface Item {
  id: number;
  title: string;
  profileId: number | null;
}

function parseItems(data: unknown, kind: Kind): { items: Item[]; total: number } {
  if (!isRecord(data) || !Array.isArray(data.data)) throw new WriteError("unexpected_response", "Bazarr ha risposto in un formato inatteso");
  const items: Item[] = [];
  for (const raw of data.data) {
    if (!isRecord(raw)) continue;
    const id = raw[KINDS[kind].idKey];
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    const profile = raw.profileId;
    items.push({ id, title: typeof raw.title === "string" ? raw.title.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 100) : `#${id}`, profileId: typeof profile === "number" ? profile : null });
  }
  return { items, total: typeof data.total === "number" ? data.total : items.length };
}

async function listWithoutProfile(ctx: Ctx, kind: Kind): Promise<{ items: Item[]; total: number }> {
  const { base, headers } = access(ctx);
  return parseItems(await getJson<unknown>(ctx, `${base}/api/${kind}?profileid=none&start=0&length=${BATCH}&sort_by=title&sort_order=asc`, { headers }), kind);
}

async function readItems(ctx: Ctx, kind: Kind, ids: number[]): Promise<Item[]> {
  const { base, headers } = access(ctx);
  const query = ids.map((id) => `${KINDS[kind].queryIds}=${id}`).join("&");
  return parseItems(await getJson<unknown>(ctx, `${base}/api/${kind}?${query}&start=0&length=${ids.length}`, { headers }), kind).items;
}

const ITEM_FIELD = /^profileId\[(\d{1,9})\]$/;
const idsOf = (changes: PlanChange[]) => changes.map((change) => ITEM_FIELD.exec(change.field)?.[1]).filter((id): id is string => !!id).map(Number);

export const bazarrAssignProfile: ActionDef = {
  name: "bazarr_assign_profile",
  services: ["bazarr"],
  description:
    "Bazarr: assegna un profilo lingua alle serie (target series) o ai film (target movies) che NON hanno ancora un profilo. Non sovrascrive mai un profilo già assegnato e non avvia ricerche. " +
    `Agisce su al massimo ${BATCH} elementi per volta (in ordine di titolo): il piano elenca esattamente quali; per gli altri si ripropone. Il profilo si indica con il suo id (get_config_bazarr, languageProfiles).`,
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: { target: { type: "string", enum: ["series", "movies"] }, profileId: { type: "integer", minimum: 1 } },
    required: ["target", "profileId"],
    additionalProperties: false,
  },
  parse(input) {
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "target" && key !== "profileId")) throw new WriteError("invalid_input", "Input non valido");
    if (input.target !== "series" && input.target !== "movies") throw new WriteError("invalid_input", "target deve essere series o movies");
    if (typeof input.profileId !== "number" || !Number.isInteger(input.profileId) || input.profileId < 1 || input.profileId > 100_000) throw new WriteError("invalid_input", "profileId deve essere l'id (intero positivo) di un profilo lingua");
    return { target: input.target, profileId: input.profileId };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const kind = input.target as Kind;
    const profileId = input.profileId as number;
    const profile = (await readProfiles(ctx)).filter(isRecord).find((p) => p.profileId === profileId);
    if (!profile) throw new WriteError("invalid_input", `Il profilo lingua ${profileId} non esiste in Bazarr`);
    const { items, total } = await listWithoutProfile(ctx, kind);
    // Anche se Bazarr ignorasse il filtro o il limite, il gateway tocca solo elementi SENZA profilo e al massimo BATCH.
    const missing = items.filter((item) => item.profileId === null).slice(0, BATCH);
    if (missing.length === 0) throw new WriteError("no_change", `Nessun${kind === "series" ? "a serie" : " film"} senza profilo: non c'è niente da assegnare`);
    const name = typeof profile.name === "string" ? profile.name : String(profileId);
    const rest = Math.max(0, total - missing.length);
    return {
      summary: `Bazarr: assegna il profilo "${name}" a ${missing.length} ${KINDS[kind].label} senza profilo${rest ? ` (ne restano altri ${rest}: si ripropone)` : ""}`,
      changes: missing.map((item) => ({ target: `Bazarr: ${KINDS[kind].label} "${item.title}"`, field: `profileId[${item.id}]`, from: null, to: profileId })),
      undo: null,
    };
  },
  async stillValid(ctx, input, changes) {
    const ids = idsOf(changes);
    if (ids.length === 0 || ids.length > BATCH) return false;
    const current = await readItems(ctx, input.target as Kind, ids);
    // Tutti gli elementi approvati esistono ancora e sono ancora senza profilo.
    return ids.every((id) => current.find((item) => item.id === id)?.profileId === null);
  },
  async apply(ctx, input, changes) {
    const kind = input.target as Kind;
    const profileId = input.profileId as number;
    const ids = idsOf(changes); // ESATTAMENTE quelli approvati
    if (ids.length === 0 || ids.length > BATCH) throw new WriteError("invalid_input", "Elenco da assegnare non valido");
    const { base, headers } = access(ctx);
    const languagesBefore = JSON.stringify(await readProfiles(ctx));

    const form = new URLSearchParams();
    for (const id of ids) {
      form.append(KINDS[kind].formIds, String(id));
      form.append("profileid", String(profileId)); // in coppia, nella stessa posizione
    }
    await request(ctx, `${base}/api/${kind}`, { method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" }, body: form });

    const after = await readItems(ctx, kind, ids);
    const wrong = ids.filter((id) => after.find((item) => item.id === id)?.profileId !== profileId);
    if (wrong.length) throw new Error(`Verifica fallita: ${wrong.length} ${KINDS[kind].label} non risultano con il nuovo profilo`);
    if (JSON.stringify(await readProfiles(ctx)) !== languagesBefore) throw new Error("Verifica fallita: i profili lingua di Bazarr sono cambiati");
    return `Applicato e verificato: profilo ${profileId} assegnato a ${ids.length} ${KINDS[kind].label}`;
  },
};

export const BAZARR_ACTIONS: ActionDef[] = [bazarrGeneral, bazarrAssignProfile];
