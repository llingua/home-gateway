import type { ActionDef, PlanDraft } from "./actions";
import { WriteError } from "./errors";
import type { PlanChange } from "./store";
import { baseUrl, getJson, request, requireSecret } from "./upstream";
import type { Ctx } from "./types";

/**
 * Modifiche alle preferenze di Plex. Un elenco chiuso di impostazioni di funzionamento (trascodifica, aggiornamento delle librerie,
 * manutenzione notturna, limiti di banda): nessun percorso, nessun account, nessuna rete, nessun accesso remoto.
 * Si legge il valore attuale, si scrive con `PUT /:/prefs?<nome>=<valore>` e si rilegge per verificare.
 */

type Field = { type: "bool" } | { type: "int"; min: number; max: number } | { type: "enum"; values: readonly string[] };

const BUTLER_TASKS = [
  "BackupDatabase", "OptimizeDatabase", "CleanOldBundles", "CleanOldCacheFiles", "RefreshLocalMedia", "RefreshLibraries",
  "UpgradeMediaAnalysis", "RefreshPeriodicMetadata", "DeepMediaAnalysis", "GenerateAutoTags", "GenerateMediaIndexFiles",
] as const;

const FIELDS: Record<string, Field> = {
  TranscodeCountLimit: { type: "int", min: 0, max: 50 }, // 0 = nessun limite
  TranscoderThrottleBuffer: { type: "int", min: 10, max: 600 },
  TranscoderH264BackgroundPreset: { type: "enum", values: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow"] },
  HardwareAcceleratedCodecs: { type: "bool" },
  HardwareAcceleratedEncoders: { type: "bool" },
  ScheduledLibraryUpdatesEnabled: { type: "bool" },
  ScheduledLibraryUpdateInterval: { type: "int", min: 900, max: 604_800 }, // secondi
  FSEventLibraryUpdatesEnabled: { type: "bool" },
  FSEventLibraryPartialScanEnabled: { type: "bool" },
  autoEmptyTrash: { type: "bool" },
  OnDeckWindow: { type: "int", min: 1, max: 52 }, // settimane
  ButlerStartHour: { type: "int", min: 0, max: 23 },
  ButlerEndHour: { type: "int", min: 0, max: 23 },
  ...Object.fromEntries(BUTLER_TASKS.map((task) => [`ButlerTask${task}`, { type: "bool" } as Field])),
  WanTotalMaxUploadRate: { type: "int", min: 0, max: 1_000_000 }, // kbps, 0 = illimitato
  WanPerStreamMaxUploadRate: { type: "int", min: 0, max: 1_000_000 },
  RelayEnabled: { type: "bool" },
  DlnaEnabled: { type: "bool" },
  GdmEnabled: { type: "bool" },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const describe = () =>
  Object.entries(FIELDS).map(([key, f]) => (f.type === "int" ? `${key} (${f.min}-${f.max})` : f.type === "enum" ? `${key} (${f.values.join("|")})` : `${key} (vero/falso)`)).join(", ");

function access(ctx: Ctx) {
  return { base: baseUrl(ctx.env, "plex"), headers: { "X-Plex-Token": requireSecret(ctx.env.PLEX_TOKEN, "plex"), Accept: "application/json" } };
}

async function readPrefs(ctx: Ctx): Promise<Record<string, unknown>> {
  const { base, headers } = access(ctx);
  const data = await getJson<{ MediaContainer?: { Setting?: unknown[] } }>(ctx, `${base}/:/prefs`, { headers });
  const out: Record<string, unknown> = {};
  for (const setting of data.MediaContainer?.Setting ?? []) {
    if (isRecord(setting) && typeof setting.id === "string" && setting.id in FIELDS) out[setting.id] = setting.value;
  }
  return out;
}

export const plexPreferences: ActionDef = {
  name: "plex_preferences",
  services: ["plex"],
  description: `Plex: cambia impostazioni di trascodifica, aggiornamento delle librerie, manutenzione notturna e limiti di banda. Chiavi ammesse: ${describe()}. Non tocca percorsi (come la cartella temporanea di trascodifica), account, reti né accesso remoto.`,
  scope: "config:write",
  inputSchema: {
    type: "object",
    properties: {
      changes: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(FIELDS).map(([key, f]) => [key, f.type === "bool" ? { type: "boolean" } : f.type === "int" ? { type: "integer", minimum: f.min, maximum: f.max } : { type: "string", enum: [...f.values] }]),
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
      } else if (typeof value !== "string" || !field.values.includes(value)) {
        throw new WriteError("invalid_input", `${key} deve essere uno tra: ${field.values.join(", ")}`);
      }
      out[key] = value;
    }
    if (Object.keys(out).length === 0) throw new WriteError("invalid_input", "Nessuna impostazione indicata");
    return { changes: out };
  },
  async plan(ctx, input): Promise<PlanDraft> {
    const wanted = input.changes as Record<string, string | number | boolean>;
    const prefs = await readPrefs(ctx);
    const changes: PlanChange[] = [];
    const before: Record<string, string | number | boolean> = {};
    for (const [key, to] of Object.entries(wanted)) {
      if (!(key in prefs)) throw new WriteError("not_supported", `Questo server Plex non ha l'impostazione ${key}`);
      const from = prefs[key];
      if (from === to) continue;
      changes.push({ target: "Plex: preferenze del server", field: key, from, to });
      if (typeof from === "string" || typeof from === "number" || typeof from === "boolean") before[key] = from;
    }
    if (changes.length === 0) throw new WriteError("no_change", "Nessuna modifica: i valori sono già questi");
    return {
      summary: `Plex: cambia ${changes.map((change) => change.field).join(", ")}`,
      changes,
      undo: Object.keys(before).length === changes.length ? { action: "plex_preferences", input: { changes: before } } : null,
    };
  },
  async stillValid(ctx, _input, changes) {
    const prefs = await readPrefs(ctx);
    return changes.every((change) => prefs[change.field] === change.from);
  },
  async apply(ctx, input) {
    const wanted = input.changes as Record<string, string | number | boolean>;
    const { base, headers } = access(ctx);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(wanted)) query.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    await request(ctx, `${base}/:/prefs?${query.toString()}`, { method: "PUT", headers });
    const after = await readPrefs(ctx);
    if (Object.entries(wanted).some(([key, value]) => after[key] !== value)) throw new Error("Verifica fallita: Plex non riporta i nuovi valori");
    return `Applicato e verificato: ${Object.entries(wanted).map(([key, value]) => `${key}=${value}`).join(", ")}`;
  },
};

export const PLEX_ACTIONS: ActionDef[] = [plexPreferences];
