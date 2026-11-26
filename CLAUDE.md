# CLAUDE.md

Guida per Claude Code in questo repository. Tienila aggiornata: ogni modifica a sezioni, adapter, permessi o configurazione va riportata qui nello stesso commit.

## Cos'è

`home-gateway` è il livello di integrazione di casa Belinchebon: un Cloudflare Worker (TypeScript, senza framework) che espone un'unica API in sola lettura per Plex, Radarr, Sonarr, qBittorrent, Overseerr. I clienti previsti: la homepage (`llingua/HomepageBelinchebon`), Home Assistant (`llingua/homeassistant-config`), agenti AI.

Divisione dei compiti: **Home Assistant** fa i controlli di disponibilità dalla rete locale (online/offline) e **non** dipende da questo gateway per le cose critiche; il gateway fornisce i **dettagli** (stream, code, richieste...) interrogando le API dei servizi.

## Mappa del codice

| Percorso | Contenuto |
|---|---|
| `src/index.ts` | Punto d'ingresso del Worker (collega `fetch` e Cache API a `handle`) |
| `src/app.ts` | Router, autenticazione, controllo permessi, risposte JSON |
| `src/auth.ts` | Verifica del JWT di Cloudflare Access (RS256, iss, aud, exp), elenco clienti (`CLIENTS`), permessi |
| `src/sections.ts` | Le "capacità" esposte (streams, downloads, requests, queue, upcoming, library, storage, health): ognuna con permesso, cache e funzione di caricamento |
| `src/services/*.ts` | Adapter: `arr.ts` (Radarr/Sonarr, API v3 condivisa), `plex.ts`, `qbittorrent.ts`, `overseerr.ts` |
| `src/upstream.ts` | Chiamate ai servizi: credenziali Access, timeout, niente redirect, errori con messaggi statici |
| `src/cache.ts` | Cache per sezione (solo risultati `ok`) |
| `test/` | Vitest; finto "internet" (`FakeNet`) e JWT firmati con chiave di prova |
| `openapi.yaml` | Contratto dell'API: va tenuto allineato |
| `docs/PRIMO-DEPLOY.md` | Passi manuali di prima messa online |

## Regole da non rompere

- **Sola lettura.** Una futura azione di scrittura richiede un permesso separato (`media:write`), conferma e registro: non aggiungerla di nascosto.
- **Privacy.** Mai nelle risposte: utenti, email, IP, chiavi, token, percorsi di configurazione. Gli adapter restituiscono solo ciò che serve a una dashboard. C'è un test che lo verifica (`non mostra mai utenti, indirizzi, chiavi o token`): estenderlo quando si aggiungono dati.
- **Fail closed.** Senza `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` il Worker risponde 500 e non interroga nessun servizio.
- **Errori statici.** I messaggi di errore verso i clienti non contengono indirizzi né dettagli dei servizi.
- **Niente redirect.** Le chiamate ai servizi usano `redirect: "manual"`: un 3xx significa che Access ha chiesto il login.
- **Segreti.** Solo come secret del Worker. Mai nel codice, nei test, nei log, nel README.
- **Un servizio senza segreti non è un errore:** la sezione risulta `unconfigured`.

## Comandi

```bash
npm install
npm run check    # tsc --noEmit + vitest
npm run dev      # wrangler dev, serve .dev.vars (vedi .dev.vars.example)
npm run deploy
```

Dopo ogni modifica alla sicurezza (`auth.ts`, controllo permessi, `upstream.ts`) rompi apposta la regola e verifica che i test falliscano: è così che si è controllato che i test siano utili.

## Stato

v0.1.0: codice, test e documentazione pronti; **non ancora distribuito**. Mancano: service token, app Access per `gateway.belinchebon.com`, `ACCESS_AUD`, `CLIENTS`, segreti dei servizi, deploy (vedi `docs/PRIMO-DEPLOY.md`). Adapter ancora da fare: Prowlarr, Bazarr.
