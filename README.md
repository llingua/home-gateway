# home-gateway

Livello di integrazione di casa Belinchebon: **un'unica API** per interrogare Plex, Radarr, Sonarr, qBittorrent, Overseerr, Prowlarr, Bazarr, Proxmox (e, in futuro, altri servizi). Chi ha bisogno di un dato — la homepage, Home Assistant, un agente AI — chiama il gateway e non sa nulla dei servizi che ci sono dietro.

È un Cloudflare Worker che gira sull'infrastruttura Cloudflare: nessun server da gestire.

```
 Homepage ───────┐
 Home Assistant ─┼─►  home-gateway (Worker)  ──►  Plex · Radarr · Sonarr · qBittorrent · Overseerr
 Agente AI ──────┘     auth · permessi · cache      (via tunnel Cloudflare, dietro Access)
```

## Principi

- **Per capacità, non per servizio.** `GET /v1/media/queue`, non `/radarr/...`. Se cambia un servizio cambia solo l'adapter in `src/services/`.
- **Sola lettura, con eccezione controllata.** Le sezioni non modificano nulla. Le poche azioni di scrittura (livello 3) richiedono il permesso `config:write` e l'**approvazione di una persona** in browser prima di essere applicate; ogni passo finisce nel registro. Vedi `docs/APPROVAZIONI.md`.
- **Un'identità per cliente.** Ogni cliente ha il suo service token Cloudflare Access e i suoi permessi: si può revocare uno senza toccare gli altri.
- **Fail closed.** Se la configurazione di autenticazione manca, il Worker rifiuta tutto.
- **Risposte parziali.** Un servizio giù non blocca gli altri: ogni sezione ha il suo `status` (`ok`, `error`, `unconfigured`).
- **Privacy.** Nessun nome utente, email, indirizzo IP, chiave o token esce dal gateway: solo titoli e numeri.

## API

Tutte le richieste sono `GET` e richiedono autenticazione (tranne `/healthz`, che però sta comunque dietro Access). Le risposte non vanno in cache lato cliente (`Cache-Control: no-store`): il gateway ha la sua cache per sezione.

| Percorso | Cosa restituisce | Cache |
|---|---|---|
| `/healthz` | `{ ok: true }`. Il Worker non chiede autenticazione, ma l'app Access davanti sì | – |
| `/v1/capabilities` | Sezioni disponibili e quali sono permesse al cliente | – |
| `/v1/media/overview` | Tutte le sezioni (o `?sections=streams,queue`) | per sezione |
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
| `/v1/config/radarr`, `/v1/config/sonarr` | Profili di qualità, formati personalizzati, cartelle, client di download, indexer, naming, ritardi, tag | 1 min |
| `/v1/config/prowlarr` | Indexer, applicazioni collegate, profili, client di download | 1 min |
| `/v1/config/cleanuparr` | Regole di pulizia coda (stallo, lentezza, importazioni fallite), blocco malware, pulizia dei download, opzioni generali (senza indirizzi né chiavi) | 1 min |
| `/v1/config/bazarr`, `/v1/config/overseerr`, `/v1/config/plex` | Opzioni di funzionamento, profili, server collegati, librerie, trascodifica (senza chiavi, utenti né indirizzi) | 1 min |
| `/v1/config/proxmox` | Nodo, guest (risorse, avvio, dischi), backup pianificati, storage, salute dei dischi: **sola lettura**, Proxmox non si modifica dal gateway | 1 min |
| `/v1/config/qbittorrent` | Percorsi, code, limiti, rapporto di condivisione, categorie | 1 min |

### Permessi e audit delle configurazioni

I dati di stato (`/v1/media/...`) richiedono il permesso `media:read`. Le **impostazioni dei servizi** (`/v1/config/...`) richiedono un permesso a parte, `config:read`, che la homepage e Home Assistant **non** hanno: servono a un agente (come Claude) per analizzare le configurazioni e proporre correzioni.

- La panoramica `/v1/media/overview` non include mai le sezioni di configurazione e non dà 403 a chi non le può vedere.
- Chiedere una sezione di configurazione senza permesso è un 403, anche passando da `?sections=` o da MCP.
- **Nessun segreto esce**: gli adapter scelgono solo campi noti e innocui (whitelist) e, sopra, una pulizia finale (`src/scrub.ts`) toglie qualunque chiave che somigli a un segreto (`apiKey`, `password`, `fields`, `token`...) e oscura i valori che ne hanno l'aspetto. Indirizzi IP, credenziali di client di download e di indexer, proxy e programmi da eseguire non compaiono mai.

Forma di una sezione:

```json
{ "status": "ok", "data": { }, "warnings": ["episodes: Errore del servizio (HTTP 500)"], "cached": true }
```

### MCP (per Claude e altri agenti)

`POST /mcp` (JSON-RPC 2.0, trasporto "streamable HTTP" senza sessioni): `initialize`, `ping`, `tools/list`, `tools/call`. Gli strumenti corrispondono alle sezioni (`get_streams`, `get_queue`, `get_config_radarr`...) più `get_overview` (stato) e `get_config_overview` (configurazioni); ogni cliente vede solo quelli permessi. `search_media` cerca un film o una serie per titolo (Overseerr); `request_media` (permesso `media:request`, stato `STATE`) crea una richiesta Overseerr dopo la conferma della persona in chat, con tetto di 10 al giorno e registro. Le letture sono sempre disponibili; gli strumenti di scrittura (`propose_*` (qBittorrent, Prowlarr, Cleanuparr, Plex, Seerr, Bazarr, profili di ritardo, flag di indexer e client di download, profili di qualità e punteggi dei formati di Radarr/Sonarr), `apply_plan`, `propose_undo`, `get_plan`, `get_audit_log`) compaiono solo se il gateway ha l'archivio `STATE` e il cliente ha `config:write`: proporre non cambia nulla, applicare richiede l'approvazione umana su `/approve/<id>`. Come collegarlo: `docs/CLIENT-CLAUDE.md`.

Descrizione completa in [`openapi.yaml`](openapi.yaml). Gli errori hanno la forma `{ "error": { "code": "...", "message": "..." } }`.

## Sicurezza

1. Il Worker risponde **solo** sul dominio personalizzato (`workers_dev` e le anteprime sono disattivati in `wrangler.jsonc`), protetto da un'app **Cloudflare Access** che accetta solo service token.
2. Il Worker **non si fida** dell'intestazione di Access: verifica la firma RS256 del JWT, l'emittente, l'AUD e la scadenza (`src/auth.ts`).
3. Il cliente viene riconosciuto dal Client ID del token (o dall'email, per gli utenti) e cercato in `CLIENTS`. Cliente sconosciuto → 403. Permesso mancante → 403.
4. I segreti (chiavi API, token) stanno solo come secret del Worker, mai nel codice né nel repository.
5. Il gateway entra nei servizi con un suo service token Access e senza seguire i redirect: se Access chiede un login, la sezione risulta in errore con un messaggio chiaro.

## Configurazione

### Variabili (non segrete, in `wrangler.jsonc`)

| Nome | Significato |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Dominio del team Access (es. `llhome.cloudflareaccess.com`) |
| `ACCESS_AUD` | AUD tag dell'app Access `home-gateway` (non segreto) |
| `ACCESS_AUD_OAUTH` | AUD dell'app Access con Managed OAuth su `mcp.belinchebon.com` (persone da app Claude; non segreto) |
| `CLIENTS` | Clienti ammessi, come oggetto JSON (vedi sotto) |
| `RADARR_URL`, `SONARR_URL`, `OVERSEERR_URL`, `PLEX_URL`, `PROWLARR_URL`, `BAZARR_URL`, `PROXMOX_URL`, `QBITTORRENT_URL` | Indirizzi dei servizi (hanno un valore predefinito) |

`CLIENTS` associa il **Client ID** del service token (o l'email) a un nome e ai permessi:

```json
{
  "<client-id-del-token-homepage>": { "name": "homepage", "scopes": ["media:read"] },
  "<client-id-del-token-ha>":       { "name": "home-assistant", "scopes": ["media:read"] }
}
```

I Client ID non sono segreti.

### Segreti (`wrangler secret put <NOME>` o dashboard → Settings → Variables and Secrets)

| Nome | Da dove |
|---|---|
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Service token con cui il gateway entra nei servizi (policy "Service Auth" sulle app Access) |
| `RADARR_API_KEY`, `SONARR_API_KEY` | Settings → General → Security → API Key |
| `OVERSEERR_API_KEY` | Settings → General → API Key (accettato anche come `OVERSEER_API_KEY`) |
| `PROWLARR_API_KEY` | Settings → General → API Key |
| `BAZARR_API_KEY` | Settings → General → Security → API key |
| `PROXMOX_API_TOKEN` | Token API di sola lettura, formato `utente@realm!nome=segreto`: vedi `docs/PROXMOX-TOKEN.md` |
| `PLEX_TOKEN` | `X-Plex-Token` (Plex Web → ⋯ → Get Info → View XML) |
| `QBT_USERNAME`, `QBT_PASSWORD` | Credenziali della Web UI di qBittorrent |
| `CLEANUPARR_API_KEY` | Chiave API di Cleanuparr (Account → API key), per leggerne le impostazioni |
| `APPROVAL_SECRET`, `APPROVERS` | Livello 3: chiave per i token CSRF e email (separate da virgola) di chi può approvare: vedi `docs/APPROVAZIONI.md` |

Un servizio senza i suoi segreti non è un errore: la sezione risulta `unconfigured`.

## Sviluppo

```bash
npm install
npm run check     # controllo dei tipi + test
npm run dev       # wrangler dev (serve un file .dev.vars, vedi .dev.vars.example)
```

I test (`test/`) usano un finto "internet" e token Access firmati con una chiave di prova: non servono rete né credenziali.

### Aggiungere un servizio

1. Un adapter in `src/services/<servizio>.ts` che restituisce dati già ripuliti (solo ciò che serve, niente dati personali).
2. Una sezione in `src/sections.ts` (nome, descrizione, permesso, durata della cache).
3. Gli eventuali segreti in `Env` (`src/types.ts`) e nella tabella sopra.
4. Test dell'adapter e della sezione, e aggiornamento di `openapi.yaml`.

## Distribuzione

```bash
npm run deploy
```

Il deploy di produzione parte da solo a ogni merge su `main` (Workers Builds). Le build di anteprima dei branch sono **disattivate**: creerebbero indirizzi pubblici. Passi della prima messa online: `docs/PRIMO-DEPLOY.md`. Come collegare Home Assistant: `docs/CLIENT-HOME-ASSISTANT.md`.
