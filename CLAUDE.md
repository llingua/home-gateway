# CLAUDE.md

Guida per Claude Code in questo repository. Tienila aggiornata: ogni modifica a sezioni, adapter, permessi o configurazione va riportata qui nello stesso commit.

## Cos'è

`home-gateway` è il livello di integrazione di casa Belinchebon: un Cloudflare Worker (TypeScript, senza framework) che espone un'unica API in sola lettura per Plex, Radarr, Sonarr, qBittorrent, Overseerr, Prowlarr, Bazarr, Proxmox. I clienti previsti: la homepage (`llingua/HomepageBelinchebon`), Home Assistant (`llingua/homeassistant-config`), agenti AI.

Divisione dei compiti: **Home Assistant** fa i controlli di disponibilità dalla rete locale (online/offline) e **non** dipende da questo gateway per le cose critiche; il gateway fornisce i **dettagli** (stream, code, richieste...) interrogando le API dei servizi.

## Mappa del codice

| Percorso | Contenuto |
|---|---|
| `src/index.ts` | Punto d'ingresso del Worker (collega `fetch` e Cache API a `handle`) |
| `src/app.ts` | Router, autenticazione, controllo permessi, risposte JSON |
| `src/auth.ts` | Verifica del JWT di Cloudflare Access (RS256, iss, aud, exp), elenco clienti (`CLIENTS`), permessi |
| `src/mcp.ts` | Interfaccia MCP (`POST /mcp`, JSON-RPC 2.0 senza sessioni): strumenti di sola lettura derivati dalle sezioni, filtrati per permesso; rifiuta `Origin`, GET, richieste > 64 KB; registra solo cliente e strumento |
| `src/load.ts` | Caricamento di una sezione con cache, condiviso da REST e MCP |
| `src/sections.ts` | Le "capacità" esposte (streams, downloads, requests, recent, queue, upcoming, library, storage, health, indexers, subtitles, proxmox): ognuna con permesso, cache e funzione di caricamento |
| `src/services/*.ts` | Adapter: `arr.ts` (Radarr/Sonarr, API v3 condivisa), `plex.ts`, `qbittorrent.ts`, `overseerr.ts`, `prowlarr.ts`, `bazarr.ts`, `proxmox.ts` |
| `src/upstream.ts` | Chiamate ai servizi: credenziali Access, timeout, niente redirect, errori con messaggi statici |
| `src/cache.ts` | Cache per sezione (solo risultati `ok`) |
| `test/` | Vitest; finto "internet" (`FakeNet`) e JWT firmati con chiave di prova |
| `openapi.yaml` | Contratto dell'API: va tenuto allineato |
| `docs/PRIMO-DEPLOY.md` | Passi manuali di prima messa online |
| `docs/CLIENT-CLAUDE.md` | Come collegare Claude/agenti via MCP (token `client-agent`, comandi, limiti dei connettori OAuth) |

## Regole da non rompere

- **Sola lettura.** Una futura azione di scrittura richiede un permesso separato (`media:write`), conferma e registro: non aggiungerla di nascosto. Gli strumenti MCP hanno `readOnlyHint: true`: un tool di scrittura andrebbe dichiarato diversamente e avere un permesso suo.
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

In produzione su `gateway.belinchebon.com` (Cloudflare Workers Builds: ogni merge su `main` rilascia da solo con `npx wrangler deploy`). Dietro l'app Access `home-gateway`; clienti: `client-homepage` (homepage) e `client-home-assistant` (Home Assistant, sola lettura, collegato ma ancora senza sensori attivi: vedi `docs/CLIENT-HOME-ASSISTANT.md`). Il gateway entra nei servizi con il token `gateway-upstream` (policy "Gateway upstream" sulle loro app Access).

- **Build di anteprima disattivate** (`previews_enabled: false` nelle impostazioni Workers Builds): su un Worker nuovo Cloudflare userebbe `wrangler preview`, che richiede un blocco `previews` e crea URL pubblici. Se si riattivano, aggiungere `"previews": {}` a `wrangler.jsonc` e proteggere gli URL con Access.
- I segreti dei servizi li imposta l'utente dalla dashboard (Settings → Variables and Secrets). `OVERSEER_API_KEY` (una R) è accettato come alias di `OVERSEERR_API_KEY`.
- Nuovo cliente = un service token in Access, una riga in `CLIENTS` (`wrangler.jsonc`) e il token nella policy "Gateway clients" dell'app `home-gateway`. Guida per Home Assistant: `docs/CLIENT-HOME-ASSISTANT.md`.
- Servizi collegati: Plex, Radarr, Sonarr, qBittorrent, Overseerr, Prowlarr, Bazarr, Proxmox (token API di sola lettura, utente dedicato con ruolo PVEAuditor: `docs/PROXMOX-TOKEN.md`; l'app Access di Proxmox ha la policy "Gateway upstream"). Prima di aggiungerne altri si decide con l'utente quali dati servono davvero (candidati: Home Assistant, Synology, Jarvis).
- CI: `npm ci` richiede `@types/node` esplicito nelle dipendenze (altrimenti il lockfile risulta incoerente su GitHub).
