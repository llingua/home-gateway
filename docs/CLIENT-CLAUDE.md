# Collegare Claude (o un altro agente) al gateway

Il gateway espone i suoi dati anche come **server MCP** (Model Context Protocol) su `POST https://gateway.belinchebon.com/mcp`. Un agente scopre da solo gli strumenti disponibili (`get_overview`, `get_streams`, `get_queue`, `get_proxmox`...) e li usa per rispondere a domande come "cosa sta scaricando il server?" o "perché Radarr non trova niente?".

Gli strumenti di lettura non modificano nulla. Le modifiche passano sempre dall'approvazione nel browser (vedi sotto); l'unica eccezione è la richiesta di un film o di una serie a Overseerr, che chiede la tua conferma in chat.

## 1. Token dedicato (lo crei tu: il segreto si vede una volta sola)

Zero Trust → Access → Service Auth → **Create Service Token** → nome `client-agent`. Copia **Client ID** e **Client Secret** (il secret non va né in chat né nel repository).

Poi serve autorizzarlo (può farlo Claude se gli dai solo il Client ID):
1. Access → Applications → `home-gateway` → policy "Gateway clients" → aggiungi il token.
2. `wrangler.jsonc` → `vars.CLIENTS` → una riga con i permessi dell'agente, per esempio:
   `"<client-id>": { "name": "agente", "scopes": ["media:read", "config:read"] }`

   `media:read` dà i dati di stato; `config:read` dà in più le **impostazioni dei servizi** per l'audit (senza chiavi né password). La homepage e Home Assistant non hanno `config:read`.

## 2. Collegamento

L'MCP usa l'autenticazione di Cloudflare Access con le due intestazioni `CF-Access-Client-Id` e `CF-Access-Client-Secret`.

**Claude Code (riga di comando):**

```bash
claude mcp add --transport http home-gateway https://gateway.belinchebon.com/mcp \
  --header "CF-Access-Client-Id: <client id>" \
  --header "CF-Access-Client-Secret: <client secret>"
```

Il segreto resta nella configurazione locale del tuo computer: non committarla.

**Agent SDK e altri client MCP "streamable HTTP" con intestazioni personalizzate:** stesso indirizzo e stesse due intestazioni.

**Sessioni cloud di Claude Code (non la chat: per quella vedi sotto): funziona, provato dal vivo.**
Le sessioni cloud non permettono intestazioni fisse nella configurazione, ma possono salvare **un segreto come credenziale dell'ambiente**: la sessione lo aggiunge da sola alle richieste verso un indirizzo, e l'agente non lo vede mai. Access vuole due intestazioni, quindi si divide così:
- il **Client Secret** di `client-agent` si salva come credenziale dell'ambiente, per l'indirizzo `gateway.belinchebon.com`, con intestazione `CF-Access-Client-Secret`. Lo inserisce l'utente nel modulo che l'agente apre (strumento `request_credential`): l'agente non lo riceve;
- il **Client ID** non è segreto: lo manda l'agente (`CF-Access-Client-Id: <client id>`).

Poi l'agente chiama il gateway come un normale client MCP, per esempio con `curl`:

```bash
curl -sS -X POST https://gateway.belinchebon.com/mcp \
  -H "Content-Type: application/json" \
  -H "CF-Access-Client-Id: <client id>" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_overview","arguments":{}}}'
```

Note pratiche:
- La credenziale vale per **tutte le sessioni** di quell'ambiente (di solito il "Default" personale). Se si sbaglia il valore, basta salvarlo di nuovo con lo stesso nome: sostituisce quello vecchio.
- Dopo il salvataggio può servire fino a un minuto prima che le richieste passino.
- Se il Client Secret si perde, si rigenera in Zero Trust → Access → Service Auth → `client-agent`, e si salva di nuovo.

**App Claude (web, telefono, desktop) – connettore con OAuth:** indirizzo `https://mcp.belinchebon.com/mcp`.
1. Impostazioni → Connettori → Aggiungi connettore personalizzato, URL `https://mcp.belinchebon.com/mcp`, senza altri campi.
2. Si apre il login di Cloudflare Access: inserisci la tua email e il codice ricevuto. Solo le email dell'app Access `home-gateway mcp (OAuth)` entrano.
3. Il connettore ha gli stessi strumenti dell'agente (lettura, proposte, `apply_plan`). Le modifiche richiedono comunque l'approvazione su `/approve` di `gateway.belinchebon.com`.

Come funziona: `mcp.belinchebon.com` è un'app Access con *Managed OAuth* (Access fa da server OAuth, con registrazione automatica del client, consentita solo per i callback di claude.ai). Il Worker accetta il JWT di quell'app (`ACCESS_AUD_OAUTH`), pretende l'**email** e la cerca tra i clienti (`CLIENTS`) o tra gli `APPROVERS`; questi ultimi ottengono `media:read`, `config:read` e `config:write`. I token di servizio non entrano da qui. L'accesso dura 24 ore, poi si rifà il login.

## 3. Cosa chiedere

**Cercare e aggiungere ai download** (dall'app Claude):
- "Cerca *Dune* e dimmi se ce l'ho già." → `search_media`: titolo, anno, trama breve e stato (non richiesto, in attesa, in download, disponibile).
- "Aggiungilo." → Claude ti ripete titolo e anno e chiede conferma; solo dopo il tuo sì crea la richiesta Overseerr. Per le serie puoi scegliere le stagioni. Massimo 10 richieste al giorno; se cambi idea, annulli la richiesta da Overseerr.

**Capire perché qualcosa non si scarica** (sola lettura):
- "Quali film mancano su Radarr e perché non si scaricano?" → `list_missing`, poi `diagnose_movie` sui singoli film.
- "Perché *The Big Bang Theory* non si scarica? Quante stagioni ho complete?" → `diagnose_series`: stagioni complete e mancanti (contando solo gli episodi già usciti), stagioni non monitorate, storia dei download falliti, coda.
- "Cerca adesso le uscite disponibili" → con `searchReleases` Sonarr/Radarr interrogano gli indexer (può richiedere fino a un minuto) e Claude vede quante uscite ci sono e perché vengono scartate (qualità non nel profilo, punteggio dei formati troppo basso, lingua...).
- Sottotitoli: per ogni film o serie dice il profilo lingua di Bazarr e quanti sottotitoli mancano.

**Limiti di qBittorrent dall'app, con un sì in chat:** "aumenta i download attivi a 8" → Claude ti mostra i valori attuali e quelli nuovi, tu rispondi sì, e la modifica parte subito (`set_qbittorrent_preferences`), verificata. Solo per code, connessioni, banda e torrent lenti; massimo 10 al giorno; per tornare indietro chiedi di rimettere i valori di prima. Funziona solo dall'app (accesso con la tua email), non dal token delle sessioni di codice.

**Configurare gli strumenti** (con approvazione nel browser):
- qBittorrent: limiti di coda, connessioni e banda; come si contano i torrent lenti.
- Radarr e Sonarr, blocklist: vedere cosa è bloccato ("cosa c'è in blocklist per *Eddie the Eagle*?"), togliere voci perché tornino scaricabili, mettere in blocklist un download in coda che non va bene (lo toglie dalla coda e cerca un'alternativa).
- Radarr e Sonarr: profili di ritardo, attivazione e priorità di indexer e client di download, soglie dei profili di qualità e punteggi dei formati personalizzati.
- Prowlarr: attivare o disattivare un indexer; rapporto e tempi di semina richiesti da un tracker.
- Plex: trascodifica (limite di sessioni, buffer, accelerazione hardware), aggiornamento e manutenzione notturna delle librerie, limiti di banda.
- Seerr: opzioni generali (richieste parziali, nascondere i disponibili...) e server Radarr/Sonarr collegati (profilo, disponibilità minima, sincronizzazione).
- Bazarr: assegnare un profilo lingua alle serie e ai film che non ne hanno (100 per volta, mai sovrascrive), profilo lingua predefinito, punteggi minimi, frequenze di ricerca e di aggiornamento dei sottotitoli.
- Cleanuparr: tentativi e timeout delle chiamate, controlli di stato e connettività, conservazione dello storico, soglia delle importazioni fallite per Radarr e Sonarr, regole di semina (modifica e creazione, per esempio una regola separata per i tracker privati).
Claude propone con i valori prima e dopo, tu approvi su `/approve`, Claude applica e verifica; ogni modifica si annulla con una nuova proposta.

Proxmox non si modifica da qui: né Claude né il gateway possono farlo.

Con `config:read` l'agente può analizzare le configurazioni e proporre correzioni, per esempio:
- "Controlla i profili di qualità di Radarr e Sonarr e dimmi cosa non va."
- "Gli indexer di Prowlarr sono sincronizzati con Radarr e Sonarr? Ci sono problemi?"
- "I limiti e le code di qBittorrent sono ragionevoli per la mia banda?"

L'agente legge e propone; applica solo i piani che hai approvato.

## 4. Cosa fa e cosa non fa

- Ogni cliente vede solo gli strumenti per cui ha il permesso (`tools/list` li filtra) e non può chiamare gli altri.
- Il gateway registra nei log **chi** ha chiamato **quale strumento**, mai i dati restituiti.
- Non esistono sessioni né flussi SSE: ogni richiesta è un POST con risposta JSON.
- Le richieste con intestazione `Origin` (browser) sono rifiutate: protegge dal "DNS rebinding".
- Dimensione massima della richiesta: 64 KB.
