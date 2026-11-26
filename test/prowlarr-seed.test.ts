import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { clearJwksCache } from "../src/auth";
import { authedRequest, baseEnv, FakeNet, JWKS_URL, makeKey, NOW, validClaims, type TestKey } from "./helpers";

let key: TestKey;
beforeEach(async () => {
  clearJwksCache();
  key = await makeKey();
});

function net(indexers: unknown[]): FakeNet {
  const n = new FakeNet();
  n.json(JWKS_URL, { keys: [key.jwk] });
  n.json("https://prowlarr.test/api/v1/system/status", { version: "1.30.0" });
  n.json("https://prowlarr.test/api/v1/indexer", indexers);
  n.json("https://prowlarr.test/api/v1/applications", []);
  n.json("https://prowlarr.test/api/v1/appprofile", []);
  n.json("https://prowlarr.test/api/v1/downloadclient", []);
  n.json("https://prowlarr.test/api/v1/tag", []);
  return n;
}

async function indexers(list: unknown[]) {
  const response = await handle(await authedRequest(key, "/v1/config/prowlarr", validClaims({ common_name: "agent-id" })), baseEnv(), { fetch: net(list).fetch, now: NOW });
  return { text: JSON.stringify(await response.clone().json()), body: (await response.json()) as any };
}

describe("obiettivi di semina degli indexer (config_prowlarr)", () => {
  it("mostra rapporto e tempo di semina, e nient'altro dell'array fields", async () => {
    const { body, text } = await indexers([
      {
        id: 9, name: "Privato", implementation: "Cardigann", protocol: "torrent", privacy: "private", enable: true, priority: 25, appProfileId: 1,
        fields: [
          { name: "definitionFile", value: "privato-def" },
          { name: "apikey", value: "chiave-indexer-segretissima" },
          { name: "baseUrl", value: "http://192.168.0.9:9696/" },
          { name: "torrentBaseSettings.seedRatio", value: 1.5 },
          { name: "torrentBaseSettings.seedTime", value: 4320 },
          { name: "torrentBaseSettings.packSeedTime", value: 10080 },
          { name: "torrentBaseSettings.appMinimumSeeders", value: 2 },
          { name: "cookie", value: "sessione-segretissima" },
        ],
      },
    ]);
    expect(body.data.prowlarr.indexers[0]).toEqual({
      id: 9, name: "Privato", implementation: "Cardigann", protocol: "torrent", privacy: "private", enable: true, priority: 25, appProfileId: 1,
      seedGoals: { seedRatio: 1.5, seedTimeMinutes: 4320, packSeedTimeMinutes: 10080, minimumSeeders: 2 },
    });
    for (const leak of ["segretissima", "192.168", "privato-def", "baseUrl", "apikey", "cookie"]) expect(text).not.toContain(leak);
  });

  it("senza obiettivi non aggiunge nulla; valori non numerici, negativi o nomi simili sono ignorati", async () => {
    const { body } = await indexers([
      { id: 1, name: "A", fields: [{ name: "apikey", value: "x" }] },
      { id: 2, name: "B", fields: [] },
      { id: 3, name: "C" },
      {
        id: 4, name: "D",
        fields: [
          { name: "torrentBaseSettings.seedRatio", value: "alto" },
          { name: "torrentBaseSettings.seedTime", value: -5 },
          { name: "torrentBaseSettings.packSeedTime", value: null },
          { name: "torrentBaseSettings.seedRatioExtra", value: 3 },
          { name: "seedRatio", value: 3 },
          { name: "torrentBaseSettings.appMinimumSeeders", value: Number.POSITIVE_INFINITY },
          "testo", null, 5,
        ],
      },
    ]);
    for (const indexer of body.data.prowlarr.indexers) expect(indexer.seedGoals).toBeUndefined();
  });

  it("i valori 0 sono validi (nessun obiettivo richiesto)", async () => {
    const { body } = await indexers([{ id: 5, name: "E", fields: [{ name: "torrentBaseSettings.seedRatio", value: 0 }] }]);
    expect(body.data.prowlarr.indexers[0].seedGoals).toEqual({ seedRatio: 0 });
  });
});
