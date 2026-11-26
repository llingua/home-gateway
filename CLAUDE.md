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
| `src/auth.ts` | Verifica del JWT di Cloudflare Access (RS256, iss, aud, exp), elenco clienti (`CLIENTS`), permessi; secondo ingresso `ACCESS_AUD_OAUTH` per le persone che arrivano da `mcp.belinchebon.com` (serve l'email, ammesse solo quelle in `CLIENTS` o `APPROVERS`) |
| `src/scrub.ts` | Rete di sicurezza per le sezioni `config_*`: toglie chiavi dai nomi sospetti (`apiKey`, `password`, `fields`, `token`...) e oscura i valori che sembrano segreti |
| `src/services/arr-config.ts` | Impostazioni di Radarr/Sonarr per l'audit (whitelist di campi); Prowlarr e qBittorrent hanno la loro funzione `fetch*Config` nei rispettivi file; per gli indexer di Prowlarr si leggono solo 4 obiettivi di semina (`seedGoals`: rapporto, tempo, tempo pacchetti, seeder minimi) per nome esatto e solo se numerici, mai il resto di `fields` |
| `src/mcp.ts` | Interfaccia MCP (`POST /mcp`, JSON-RPC 2.0 senza sessioni): strumenti di lettura derivati dalle sezioni e, se `STATE` esiste, strumenti di scrittura con approvazione (`propose_*`, `apply_plan`, `get_plan`, `get_audit_log`), filtrati per permesso; rifiuta `Origin`, GET, richieste > 64 KB; registra solo cliente e strumento |
| `src/actions.ts` | Azioni di scrittura ammesse (`qbittorrent_preferences` con interi e booleani a limiti fissi, `prowlarr_indexer_enabled`, `prowlarr_indexer_seed_goals` per rapporto/tempi di semina di un indexer) e registro `ACTIONS`: parse con limiti, piano, controllo di deriva, applicazione con verifica. `services` esclude `proxmox` a livello di tipo |
| `src/arr-actions.ts` | Azioni su Radarr/Sonarr: `arr_delay_profile`, `arr_indexer_flags`, `arr_download_client_flags`, `arr_quality_profile` (soglie e punteggi dei formati). Whitelist di campi con limiti; l'oggetto completo (credenziali comprese) passa solo dal gateway al servizio, con rilettura e verifica |
| `src/writes.ts` | Ciclo propose / apply / undo / decide, controlli di permesso, stato e scadenze dei piani, registro |
| `src/store.ts` | Archivio KV dei piani (`plan:<id>`) e del registro (`audit:...`), limite di 10 piani in attesa |
| `src/cleanuparr-actions.ts` | Azioni su Cleanuparr: `cleanuparr_general` (retry, timeout, controlli, conservazione storico), `cleanuparr_arr_failed_import` (soglia per Radarr/Sonarr), `cleanuparr_seeding_rule_update` e `cleanuparr_seeding_rule_create` (regole di semina: rimozione = (rapporto E ore minime) OPPURE ore massime, il massimo vale da solo; massimo 0 = cancella subito, vietato; la nuova regola va in fondo alla priorità; niente cancellazioni). Le PUT di Cleanuparr sostituiscono l'intero oggetto: si rilegge e si rimanda tutto cambiando un solo campo; dry run, accesso, reti fidate e registri non si toccano |
| `src/plex-actions.ts` | `plex_preferences`: trascodifica, aggiornamento e manutenzione delle librerie, limiti di banda (`PUT /:/prefs`, bool come 1/0). Mai percorsi (cartella temporanea), account, reti, accesso remoto |
| `src/seerr-actions.ts` | `seerr_main_settings` (POST parziale: la risposta di Seerr contiene la chiave API e non si legge; mai accessi/permessi) e `seerr_server_settings` (la PUT sostituisce l'oggetto: si rimanda intero, chiave compresa, e si rifiuta se la chiave non è leggibile; il nome del profilo lo legge il gateway da Radarr/Sonarr; mai cartelle, indirizzi, chiavi) |
| `src/bazarr-actions.ts` | `bazarr_assign_profile` (assegna un profilo lingua a serie/film SENZA profilo, mai sovrascrive, max 100 per piano, applica esattamente l'elenco approvato: `apply` riceve le `changes` approvate) e `bazarr_general`: impostazioni di ricerca/aggiornamento sottotitoli e profilo lingua predefinito. Bazarr vuole un modulo `settings-general-<chiave>` con valori testuali; il suo gestore può toccare lingue e profili, quindi il gateway rimanda identiche le lingue attive (e rifiuta di scrivere se non le legge) e verifica che lingue e profili non cambino |
| `src/media.ts` | Ricerca film/serie e richiesta Overseerr (`search_media`, `request_media`): permesso `media:request`, conferma esplicita, tetto 10 al giorno, controllo "già richiesto", verifica e registro |
| `src/approval.ts` | Pagina `/approve/<id>` per l'approvazione umana (Access dedicato, CSRF, escape HTML) |
| `src/load.ts` | Caricamento di una sezione con cache, condiviso da REST e MCP |
| `src/sections.ts` | Le "capacità" esposte (gruppo `media`: streams, downloads, requests, recent, queue, upcoming, library, storage, health, indexers, subtitles, proxmox; gruppo `config`, permesso `config:read`: config_radarr, config_sonarr, config_prowlarr, config_qbittorrent, config_bazarr, config_overseerr, config_plex, config_proxmox, config_cleanuparr): ognuna con permesso, cache e funzione di caricamento |
| `src/services/*.ts` | Adapter: `arr.ts` (Radarr/Sonarr, API v3 condivisa), `plex.ts`, `qbittorrent.ts`, `overseerr.ts`, `prowlarr.ts`, `bazarr.ts`, `proxmox.ts`, `cleanuparr.ts` (solo lettura delle impostazioni con `X-Api-Key`; per arr e client di download solo nome/tipo/stato, mai indirizzi o chiavi) |
| `src/services/*-config.ts`, `config-common.ts` | Letture di configurazione di Bazarr, Overseerr, Plex, Proxmox (e Cleanuparr): whitelist per nome con `pickSimple` (solo valori semplici). Plex: solo preferenze elencate (trascodifica, manutenzione), mai account/token/reti; Proxmox: solo GET, mai IP/MAC/note/seriali, dischi dei guest ridotti a storage e dimensione; Bazarr/Overseerr: mai chiavi, utenti, indirizzi. Nessuna di queste sezioni ha azioni di scrittura (Proxmox è sola lettura per regola) |
| `src/upstream.ts` | Chiamate ai servizi: credenziali Access, timeout, niente redirect, errori con messaggi statici |
| `src/cache.ts` | Cache per sezione (solo risultati `ok`); `invalidateAllSections` svuota tutte le sezioni dopo OGNI applicazione (riuscita o fallita, nel `finally` di `applyPlan`), così una rilettura subito dopo una modifica mostra il valore nuovo. La Cache API è per sede Cloudflare: lo svuotamento vale per la sede che serve la richiesta, nelle altre la cache scade da sola (max 60 s) |
| `test/` | Vitest; finto "internet" (`FakeNet`) e JWT firmati con chiave di prova |
| `openapi.yaml` | Contratto dell'API: va tenuto allineato |
| `docs/PRIMO-DEPLOY.md` | Passi manuali di prima messa online |
| `docs/APPROVAZIONI.md` | Messa online del livello 3: KV, app Access `/approve`, variabili e segreti, permesso `config:write` |
| `docs/CLIENT-CLAUDE.md` | Come collegare Claude/agenti via MCP (token `client-agent`, comandi, limiti dei connettori OAuth) |

## Regole da non rompere

- **Sola lettura di default; scritture solo con approvazione umana (livello 3).** Le sezioni (`/v1/...`) restano in sola lettura. Le uniche scritture sono le *azioni* di `src/actions.ts`, con permesso separato `config:write` e questo ciclo: **proponi** (nessuna modifica, piano con valori prima/dopo) → **una persona approva** nel browser su `/approve/<id>` (app Access separata `ACCESS_AUD_APPROVAL`, email in `APPROVERS`; i service token non possono approvare; CSRF HMAC con `APPROVAL_SECRET`, controllo Origin, CSP) → **applica** (solo se approvato, non scaduto, stato invariato, una volta sola; poi rilettura e verifica) → registro in KV (`STATE`). Annullare = nuova proposta (`propose_undo`). Senza KV/variabili le scritture sono spente (fail closed). Aggiungere un'azione: whitelist di campi con limiti, `plan` che legge lo stato, `stillValid`, `apply` con verifica, test con segreti piantati e mutazioni. Mai azioni che eseguono comandi, scrivono percorsi o toccano credenziali. Gli strumenti MCP di sola lettura hanno `readOnlyHint: true`; `apply_plan` ha `destructiveHint`.
- **Proxmox non si modifica mai da qui.** Si cambia solo a mano. Tre barriere: il token Proxmox ha il ruolo `PVEAuditor` (sola lettura); `ActionDef.service` esclude `proxmox` dal tipo; `upstream.request` rifiuta ogni metodo diverso da GET/HEAD verso l'indirizzo di Proxmox. Test in `test/media.test.ts`. Non rimuovere nessuna delle tre.
- **Richiesta di film/serie (`request_media`).** Unica scrittura che NON passa da `/approve`: aggiunge una richiesta Overseerr, annullabile da Overseerr. Per questo ha limiti propri: permesso `media:request` (solo `app-claude` e chi lo riceve in `CLIENTS`), `confirmedByUser: true` solo dopo il sì della persona in chat, massimo 10 al giorno (conta anche il tentativo fallito), rifiuto di ciò che è già richiesto/disponibile, verifica dopo la scrittura, voce nel registro. Non estenderla a cancellazioni o modifiche: quelle passano da propose/approve.
- **Privacy.** Mai nelle risposte: utenti, email, IP, chiavi, token. I percorsi delle cartelle dei media compaiono solo nelle sezioni `config_*` (permesso `config:read`) e in `storage`. Gli adapter restituiscono solo ciò che serve a una dashboard. C'è un test che lo verifica (`non mostra mai utenti, indirizzi, chiavi o token`): estenderlo quando si aggiungono dati.
- **Fail closed.** Senza `ACCESS_TEAM_DOMAIN` e `ACCESS_AUD` il Worker risponde 500 e non interroga nessun servizio.
- **Errori statici.** I messaggi di errore verso i clienti non contengono indirizzi né dettagli dei servizi.
- **Niente redirect.** Le chiamate ai servizi usano `redirect: "manual"`: un 3xx significa che Access ha chiesto il login.
- **Segreti.** Solo come secret del Worker. Mai nel codice, nei test, nei log, nel README.
- **Un servizio senza segreti non è un errore:** la sezione risulta `unconfigured`.

- **Sezioni di configurazione (`config_*`).** Permesso `config:read` a parte, che la homepage e Home Assistant non hanno. Doppia difesa contro la fuga di segreti: (1) ogni adapter sceglie solo campi noti e innocui (whitelist; gli oggetti `indexer`/`downloadclient`/`applications` hanno un array `fields` con chiavi e password che non deve mai entrare); (2) `scrubSecrets` pulisce comunque ogni risposta `config_*`. Aggiungendo una sezione di configurazione: whitelist nell'adapter, fixture di test **con segreti piantati** nei punti dove il servizio vero li mette e test di non-fuga. Le panoramiche `media` non includono mai le sezioni `config_*`.

## Comandi

```bash
npm install
npm run check    # tsc --noEmit + vitest
npm run dev      # wrangler dev, serve .dev.vars (vedi .dev.vars.example)
npm run deploy
```

Dopo ogni modifica alla sicurezza (`auth.ts`, controllo permessi, `upstream.ts`, `mcp.ts`, `scrub.ts`, `writes.ts`, `approval.ts`, `actions.ts`, whitelist degli adapter di configurazione) rompi apposta la regola e verifica che i test falliscano: è così che si è controllato che i test siano utili.

## Stato

In produzione su `gateway.belinchebon.com` (Cloudflare Workers Builds: ogni merge su `main` rilascia da solo con `npx wrangler deploy`). Dietro l'app Access `home-gateway`; clienti: `client-homepage` (homepage), `client-home-assistant` (Home Assistant, sola lettura, collegato ma ancora senza sensori attivi: vedi `docs/CLIENT-HOME-ASSISTANT.md`) e `client-agent` (agente come Claude: `media:read` + `config:read` + `config:write`, quest'ultimo solo per proporre: ogni modifica richiede l'approvazione di `APPROVERS` su `/approve`; vedi `docs/CLIENT-CLAUDE.md`). Dall'app Claude (telefono/web) si entra da `mcp.belinchebon.com` con OAuth gestito da Access (app `home-gateway mcp (OAuth)`, solo la tua email, DCR limitata ai callback di claude.ai): vedi `docs/CLIENT-CLAUDE.md`. Il gateway entra nei servizi con il token `gateway-upstream` (policy "Gateway upstream" sulle loro app Access).

- **Build di anteprima disattivate** (`previews_enabled: false` nelle impostazioni Workers Builds): su un Worker nuovo Cloudflare userebbe `wrangler preview`, che richiede un blocco `previews` e crea URL pubblici. Se si riattivano, aggiungere `"previews": {}` a `wrangler.jsonc` e proteggere gli URL con Access.
- I segreti dei servizi li imposta l'utente dalla dashboard (Settings → Variables and Secrets). `OVERSEER_API_KEY` (una R) è accettato come alias di `OVERSEERR_API_KEY`.
- Nuovo cliente = un service token in Access, una riga in `CLIENTS` (`wrangler.jsonc`) e il token nella policy "Gateway clients" dell'app `home-gateway`. Guida per Home Assistant: `docs/CLIENT-HOME-ASSISTANT.md`.
- Servizi collegati: Plex, Radarr, Sonarr, qBittorrent, Overseerr, Prowlarr, Bazarr, Proxmox (token API di sola lettura, utente dedicato con ruolo PVEAuditor: `docs/PROXMOX-TOKEN.md`; l'app Access di Proxmox ha la policy "Gateway upstream"). Prima di aggiungerne altri si decide con l'utente quali dati servono davvero (candidati: Home Assistant, Synology, Jarvis).
- **Cleanuparr** (`config_cleanuparr`, sola lettura): serve il segreto `CLEANUPARR_API_KEY` (UI di Cleanuparr → Account → chiave API) e la policy "Gateway upstream" sulla sua app Access (già aggiunta). Le risposte di Cleanuparr contengono indirizzi, chiavi e password di arr e client di download: l'adapter le scarta con whitelist e `stripAddresses`. Percorsi non verificati sul programma vero finché la chiave non è impostata (campi di regole stallo/lentezza non documentati).
- CI: `npm ci` richiede `@types/node` esplicito nelle dipendenze (altrimenti il lockfile risulta incoerente su GitHub).
