# home-gateway

Livello di integrazione di casa Belinchebon: **un unico punto di accesso** a Plex, Radarr, Sonarr, qBittorrent, Overseerr/Seerr, Prowlarr, Bazarr, Cleanuparr e Proxmox. Chi ha bisogno di un dato o di una modifica — la homepage, Home Assistant, Claude dall'app o da una sessione di codice — parla con il gateway e non deve sapere niente dei servizi che ci sono dietro.

È un Cloudflare Worker (TypeScript, senza framework): nessun server da gestire.

```
 Homepage ───────────────┐   token di servizio
 Home Assistant ─────────┤   (gateway.belinchebon.com)
 Claude, sessioni codice ┘                              ┌─► Plex · Radarr · Sonarr · qBittorrent
                                home-gateway (Worker) ──┼─► Overseerr · Prowlarr · Bazarr
 App Claude (telefono, web)  ─ OAuth ─► mcp.belinchebon.com    │    Cleanuparr · Proxmox (sola lettura)
                                auth · permessi · cache  └─► (via tunnel Cloudflare, dietro Access)
 Tu, nel browser  ─ login personale ─►  /approve/<id>   (approvi le modifiche)
```

## Cosa fa

| Capacità | In breve |
|---|---|
| **Stato** | Riproduzioni Plex, download, code, richieste, sottotitoli mancanti, salute, spazio, Proxmox: un dato per capacità, non per servizio. |
| **Audit delle configurazioni** | Legge le impostazioni di tutti i servizi (profili di qualità, indexer, regole di Cleanuparr, trascodifica di Plex, backup di Proxmox…) già ripulite da chiavi, password e indirizzi, così un agente può analizzarle e proporre correzioni. |
| **Cercare e aggiungere film e serie** | `search_media` cerca per titolo; `request_media` crea una richiesta Overseerr dopo il sì della persona in chat. |
| **Capire perché non si scarica** | `list_missing`, `diagnose_movie`, `diagnose_series`: mancanti, stagioni complete, storia dei fallimenti, coda, sottotitoli e, a richiesta, ricerca delle uscite con i motivi di scarto. Sola lettura. |
| **Modifiche con approvazione** | Un agente *propone*, **una persona approva** nel browser, l'agente *applica* e il gateway verifica. Per qBittorrent, Radarr, Sonarr, Prowlarr, Cleanuparr, Bazarr, Plex e Seerr. |
| **Proxmox** | Solo lettura. Si modifica a mano: il gateway non può scrivergli. |

La homepage, Home Assistant e gli agenti hanno permessi diversi (vedi più sotto): ognuno vede e può fare solo ciò che gli serve.

## Principi

- **Per capacità, non per servizio.** `GET /v1/media/queue`, non `/radarr/...`. Se cambia un servizio cambia solo l'adapter in `src/services/`.
- **Sola lettura di default; scritture solo con approvazione umana.** Le sezioni (`/v1/...`) non modificano nulla. Le uniche scritture sono le *azioni* elencate sotto, con permesso `config:write`, e passano da proposta → approvazione di una persona → applicazione verificata → registro. L'unica eccezione è `request_media`, con limiti propri.
- **Un'identità per cliente.** Ogni cliente ha il suo service token Cloudflare Access e i suoi permessi: si revoca uno senza toccare gli altri. Le persone entrano con il loro login.
- **Fail closed.** Se manca la configurazione di autenticazione o l'archivio dei piani, il Worker rifiuta tutto o spegne le scritture.
- **Risposte parziali.** Un servizio giù non blocca gli altri: ogni sezione ha il suo `status` (`ok`, `error`, `unconfigured`).
- **Privacy.** Nessun nome utente, email, indirizzo IP, chiave, token o credenziale esce dal gateway: solo titoli, numeri e impostazioni di funzionamento.
- **Proxmox non si modifica da qui**, per tre barriere indipendenti: token di sola lettura (`PVEAuditor`), nessuna azione di scrittura con quel bersaglio (controllo di tipo), rifiuto di ogni richiesta non di lettura verso il suo indirizzo.

## Indirizzi e chi entra

| Indirizzo | Per | Come si entra |
|---|---|---|
| `gateway.belinchebon.com` (API REST e `/mcp`) | homepage, Home Assistant, agenti, sessioni di codice | service token Cloudflare Access (uno per cliente) |
| `gateway.belinchebon.com/approve/<id>` | tu, per approvare una modifica | app Access separata, solo le email in `APPROVERS` (i token di servizio non possono approvare) |
| `mcp.belinchebon.com/mcp` | l'app Claude (connettore personalizzato) | OAuth gestito da Access (*Managed OAuth*), solo persone con email autorizzata |

## API REST (sola lettura)

Le richieste REST sono `GET` e richiedono autenticazione (tranne `/healthz`, che sta comunque dietro Access). Le risposte non vanno in cache lato cliente (`Cache-Control: no-store`): il gateway ha la sua cache per sezione.

| Percorso | Cosa restituisce | Cache |
|---|---|---|
| `/healthz` | `{ ok: true }` | – |
| `/v1/capabilities` | Sezioni disponibili e quali sono permesse al cliente | – |
| `/v1/media/overview` | Tutte le sezioni di stato (o `?sections=streams,queue`) | per sezione |
| `/v1/media/streams` | Riproduzioni Plex in corso | 15 s |
| `/v1/media/downloads` | Velocità e stato dei torrent | 15 s |
| `/v1/media/requests` | Richieste e problemi Overseerr (contatori) | 60 s |
| `/v1/media/recent` | Ultimo film o serie reso disponibile (solo titolo) | 5 min |
| `/v1/media/queue` | Code Radarr/Sonarr | 30 s |
| `/v1/media/upcoming` | Prossime uscite (30 giorni) | 10 min |
| `/v1/media/library` | Elementi nelle librerie Plex, contenuti ricercati | 10 min |
| `/v1/media/storage` | Spazio libero sui volumi | 5 min |
| `/v1/media/health` | Avvisi di salute Radarr/Sonarr | 2 min |
| `/v1/media/indexers` | Indexer Prowlarr: totali, non attivi, avvisi | 2 min |
| `/v1/media/subtitles` | Sottotitoli mancanti e problemi dei provider (Bazarr) | 5 min |
| `/v1/media/proxmox` | Host Proxmox (CPU, RAM, uptime), guest, storage, ultimo backup | 30 s |
| `/v1/config/overview` | **Audit**: impostazioni di tutti i servizi (permesso `config:read`) | 1 min |
| `/v1/config/radarr`, `/v1/config/sonarr` | Profili di qualità e punteggi dei formati, cartelle, client di download, indexer, naming, ritardi, tag | 1 min |
| `/v1/config/prowlarr` | Indexer (con privacy e obiettivi di semina), applicazioni collegate, profili, client | 1 min |
| `/v1/config/qbittorrent` | Percorsi, code, limiti, rapporto di condivisione, categorie | 1 min |
| `/v1/config/cleanuparr` | Regole di pulizia della coda (stallo, lentezza, importazioni fallite), blocco malware, pulizia dei download e regole di semina, opzioni generali | 1 min |
| `/v1/config/bazarr` | Opzioni di ricerca e aggiornamento dei sottotitoli, provider attivi (solo i nomi), profili lingua, lingue attive | 1 min |
| `/v1/config/overseerr` | Opzioni generali, server Radarr/Sonarr collegati, controllo di connessione, librerie Plex, lavori | 1 min |
| `/v1/config/plex` | Trascodifica, aggiornamento e manutenzione delle librerie, librerie e cartelle | 1 min |
| `/v1/config/proxmox` | Nodo, guest (risorse, avvio, dischi), backup pianificati, storage, salute dei dischi | 1 min |

Forma di una sezione:

```json
{ "status": "ok", "data": { }, "warnings": ["episodes: Errore del servizio (HTTP 500)"], "cached": true }
```

Descrizione completa in [`openapi.yaml`](openapi.yaml). Gli errori hanno la forma `{ "error": { "code": "...", "message": "..." } }`.

### Permessi

| Permesso | Consente |
|---|---|
| `media:read` | stato (`/v1/media/...`) e ricerca di film e serie |
| `config:read` | audit delle configurazioni (`/v1/config/...`) e lettura di piani e registro |
| `config:write` | proporre e applicare modifiche (serve comunque l'approvazione di una persona) |
| `media:request` | `request_media` (aggiungere un film o una serie ai download) |

La panoramica `/v1/media/overview` non include mai le sezioni di configurazione e non dà 403 a chi non le può vedere; chiederne una senza permesso è un 403, anche passando da `?sections=` o da MCP.

## MCP (per Claude e altri agenti)

`POST /mcp` (JSON-RPC 2.0, trasporto "streamable HTTP" senza sessioni): `initialize`, `ping`, `tools/list`, `tools/call`. Ogni cliente vede solo gli strumenti per cui ha il permesso.

- **Letture:** una per sezione (`get_streams`, `get_queue`, `get_config_radarr`…), più `get_overview` e `get_config_overview`.
- **Cercare e aggiungere:** `search_media` (`media:read`) e `request_media` (`media:request`).
- **Diagnosi:** `list_missing`, `diagnose_movie`, `diagnose_series` (`config:read`, sola lettura; con `searchReleases: true` Radarr/Sonarr interrogano gli indexer, fino a 60 s).
- **Modifiche:** `propose_<azione>`, `propose_undo`, `apply_plan`, `get_plan`, `get_audit_log` (compaiono solo se esiste l'archivio `STATE` e il cliente ha i permessi).

Come collegarlo: `docs/CLIENT-CLAUDE.md`.

## Modifiche con approvazione

```
agente: propose_*  →  piano con valori di prima e di dopo (nessuna modifica)
persona: /approve/<id>  →  Approva o Rifiuta (login personale)
agente: apply_plan  →  il gateway controlla, scrive, rilegge e verifica  →  registro
```

- **Il piano non cambia dopo la proposta.** Dura 15 minuti; dopo l'approvazione si applica entro 10 minuti, una volta sola.
- **Si applica solo se** è approvato, non scaduto e lo stato del servizio non è cambiato dopo la proposta (altrimenti `state_changed` e non si scrive nulla).
- **Dopo la scrittura** il gateway rilegge e verifica; se il servizio non riporta i valori nuovi (o ha cambiato altro) il piano risulta *fallito*.
- **Ogni passo finisce nel registro** (`get_audit_log`, 90 giorni). Dopo ogni applicazione la cache delle letture si svuota.
- **Annullare** = nuova proposta (`propose_undo`), da approvare. Le creazioni di regole e le assegnazioni di profili si tolgono dal servizio.
- **Approvazione sicura:** pagina con accesso personale separato, token anti-CSRF legato a piano e persona, controllo dell'origine, intestazioni di sicurezza, testo sempre con escape.

### Azioni disponibili

| Azione | Cosa cambia | Cosa non tocca mai |
|---|---|---|
| `qbittorrent_preferences` | coda, connessioni, banda, torrent lenti | percorsi, credenziali, rete, azioni al raggiungimento del rapporto |
| `prowlarr_indexer_enabled`, `prowlarr_indexer_seed_goals` | attivare un indexer; rapporto e tempi di semina | credenziali dell'indexer |
| `arr_delay_profile` | protocollo preferito, attese, bypass | etichette, ordine |
| `arr_indexer_flags`, `arr_download_client_flags` | ricerca, priorità, attivazione, rimozione di completati/falliti | credenziali, indirizzi |
| `arr_quality_profile` | soglie dei punteggi e punteggi dei formati personalizzati | qualità ammesse, cutoff, nome |
| `cleanuparr_general`, `cleanuparr_arr_failed_import` | tentativi, timeout, controlli, storico, soglia delle importazioni fallite | dry run, accesso, reti fidate, registri |
| `cleanuparr_seeding_rule_update`, `cleanuparr_seeding_rule_create` | regole di semina (tipo di tracker, rapporto, ore minime e massime) | cancellazione di regole; un massimo di 0 (cancella subito) è vietato |
| `bazarr_general`, `bazarr_assign_profile` | profilo lingua predefinito, punteggi, frequenze; assegna un profilo a serie/film **senza** profilo (100 per piano) | provider, credenziali, collegamenti, lingue e profili |
| `plex_preferences` | trascodifica, aggiornamento e manutenzione delle librerie, banda | cartella temporanea, account, reti, accesso remoto |
| `seerr_main_settings`, `seerr_server_settings` | opzioni generali; server Radarr/Sonarr collegati (profilo, disponibilità minima, sincronizzazione) | accessi, permessi, cartelle, indirizzi, chiavi |

Quando un servizio sostituisce l'intero oggetto a ogni scrittura (Seerr, Cleanuparr, indexer e client di Radarr/Sonarr/Prowlarr), il gateway rilegge l'oggetto completo, cambia solo i campi indicati e lo rimanda: credenziali e campi non toccati passano da gateway a servizio e non escono mai.

### Aggiungere e cercare un film o una serie

`request_media` è l'unica scrittura che non passa da `/approve`: aggiunge una richiesta Overseerr, annullabile da Overseerr. Per questo ha limiti propri: permesso `media:request`, conferma esplicita della persona in chat (`confirmedByUser: true`), **massimo 10 al giorno**, rifiuto di ciò che è già richiesto o disponibile, verifica dopo la scrittura e voce nel registro.

## Sicurezza

1. I Worker rispondono **solo** sui domini personalizzati (`workers_dev` e le anteprime sono disattivati in `wrangler.jsonc`), dietro app **Cloudflare Access**.
2. Il Worker **non si fida** dell'intestazione di Access: verifica firma RS256, emittente, AUD e scadenza del JWT (`src/auth.ts`). Ingressi distinti hanno AUD distinti.
3. Il cliente viene riconosciuto dal Client ID del token o, per le persone, dall'email (in `CLIENTS` o `APPROVERS`; serve l'email, un token di servizio non entra dall'ingresso OAuth). Sconosciuto o senza permesso → 403.
4. I segreti stanno solo come secret del Worker, mai nel codice né nel repository.
5. Verso i servizi il gateway entra con un suo service token Access e **senza seguire i redirect**: un 3xx significa che Access ha chiesto il login.
6. **Doppia difesa contro la fuga di segreti**: ogni adapter sceglie campi noti per nome (whitelist), e `src/scrub.ts` toglie comunque qualunque chiave che somigli a un segreto e oscura i valori che ne hanno l'aspetto.
7. I messaggi di errore verso i clienti sono statici: niente indirizzi né dettagli dei servizi.

## Configurazione

### Variabili (non segrete, in `wrangler.jsonc`)

| Nome | Significato |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Dominio del team Access (es. `llhome.cloudflareaccess.com`) |
| `ACCESS_AUD` | AUD dell'app Access `home-gateway` |
| `ACCESS_AUD_OAUTH` | AUD dell'app Access con Managed OAuth su `mcp.belinchebon.com` (persone da app Claude) |
| `ACCESS_AUD_APPROVAL` | AUD dell'app Access della pagina `/approve` (solo persone) |
| `CLIENTS` | Clienti ammessi, oggetto JSON (vedi sotto) |
| `RADARR_URL`, `SONARR_URL`, `OVERSEERR_URL`, `PLEX_URL`, `PROWLARR_URL`, `BAZARR_URL`, `PROXMOX_URL`, `QBITTORRENT_URL`, `CLEANUPARR_URL` | Indirizzi dei servizi (hanno un valore predefinito) |

Il binding KV `STATE` (piani, registro, contatore giornaliero delle richieste) è in `wrangler.jsonc`. Senza di esso le scritture sono spente.

`CLIENTS` associa il **Client ID** del service token (o l'email) a un nome e ai permessi. I Client ID non sono segreti:

```json
{
  "<client-id-homepage>": { "name": "homepage", "scopes": ["media:read"] },
  "<client-id-ha>":       { "name": "home-assistant", "scopes": ["media:read"] },
  "<client-id-agente>":   { "name": "agente", "scopes": ["media:read", "config:read", "config:write"] }
}
```

Chi entra dall'ingresso OAuth con un'email in `APPROVERS` riceve `media:read`, `media:request`, `config:read` e `config:write`.

### Segreti (`wrangler secret put <NOME>` o dashboard → Settings → Variables and Secrets)

| Nome | Da dove |
|---|---|
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Service token con cui il gateway entra nei servizi (policy "Service Auth" sulle app Access) |
| `RADARR_API_KEY`, `SONARR_API_KEY` | Settings → General → Security → API Key |
| `OVERSEERR_API_KEY` | Settings → General → API Key (accettato anche come `OVERSEER_API_KEY`) |
| `PROWLARR_API_KEY` | Settings → General → API Key |
| `BAZARR_API_KEY` | Settings → General → Security → API key |
| `CLEANUPARR_API_KEY` | Account → API key |
| `PROXMOX_API_TOKEN` | Token API di sola lettura, formato `utente@realm!nome=segreto`: vedi `docs/PROXMOX-TOKEN.md` |
| `PLEX_TOKEN` | `X-Plex-Token` |
| `QBT_USERNAME`, `QBT_PASSWORD` | Credenziali della Web UI di qBittorrent |
| `APPROVAL_SECRET`, `APPROVERS` | Chiave per i token anti-CSRF; email (separate da virgola) di chi può approvare |

Un servizio senza i suoi segreti non è un errore: la sezione risulta `unconfigured`. Messa online delle approvazioni: `docs/APPROVAZIONI.md`.

## Sviluppo

```bash
npm install
npm run check     # controllo dei tipi + test
npm run dev       # wrangler dev (serve un file .dev.vars, vedi .dev.vars.example)
```

I test (`test/`) usano un finto "internet" con stato che cambia davvero e token Access firmati con una chiave di prova: non servono rete né credenziali.

### Aggiungere un servizio in lettura

1. Un adapter in `src/services/<servizio>.ts` che restituisce solo campi scelti per nome (`pickSimple` aiuta), senza dati personali.
2. Una sezione in `src/sections.ts` (nome, descrizione, permesso, cache).
3. Gli eventuali segreti in `Env` (`src/types.ts`) e nella tabella sopra.
4. Test con **segreti piantati** nei punti dove il servizio vero li mette e test di non-fuga; aggiornare `openapi.yaml`.

### Aggiungere un'azione di scrittura

Whitelist di campi con limiti, `plan` (legge e calcola, non scrive), `stillValid` (controllo di deriva), `apply` (scrive, rilegge e verifica) e, se possibile, annullo. Mai azioni che eseguono comandi, scrivono percorsi, toccano credenziali o hanno Proxmox come bersaglio. Dopo ogni modifica alla sicurezza, **rompi apposta la regola** e controlla che almeno un test fallisca: così si è verificato che i test servano davvero.

## Distribuzione

```bash
npm run deploy
```

Il deploy di produzione parte da solo a ogni merge su `main` (Workers Builds). Le build di anteprima dei branch sono **disattivate**: creerebbero indirizzi pubblici. Passi della prima messa online: `docs/PRIMO-DEPLOY.md`. Come collegare Home Assistant: `docs/CLIENT-HOME-ASSISTANT.md`. Riepilogo del lavoro fatto e delle modifiche applicate: `docs/RIEPILOGO.md`.
