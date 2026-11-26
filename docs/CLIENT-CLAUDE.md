# Collegare Claude (o un altro agente) al gateway

Il gateway espone i suoi dati anche come **server MCP** (Model Context Protocol) su `POST https://gateway.belinchebon.com/mcp`. Un agente scopre da solo gli strumenti disponibili (`get_overview`, `get_streams`, `get_queue`, `get_proxmox`...) e li usa per rispondere a domande come "cosa sta scaricando il server?" o "perché Radarr non trova niente?".

**Oggi tutti gli strumenti sono di sola lettura.** Il gateway non modifica nulla: le azioni di scrittura, quando ci saranno, avranno un permesso separato.

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

Con `config:read` l'agente può analizzare le configurazioni e proporre correzioni, per esempio:
- "Controlla i profili di qualità di Radarr e Sonarr e dimmi cosa non va."
- "Gli indexer di Prowlarr sono sincronizzati con Radarr e Sonarr? Ci sono problemi?"
- "I limiti e le code di qBittorrent sono ragionevoli per la mia banda?"

L'agente **legge e propone**: non applica nulla. Le modifiche, quando ci saranno, avranno un permesso separato e la tua conferma.

## 4. Cosa fa e cosa non fa

- Ogni cliente vede solo gli strumenti per cui ha il permesso (`tools/list` li filtra) e non può chiamare gli altri.
- Il gateway registra nei log **chi** ha chiamato **quale strumento**, mai i dati restituiti.
- Non esistono sessioni né flussi SSE: ogni richiesta è un POST con risposta JSON.
- Le richieste con intestazione `Origin` (browser) sono rifiutate: protegge dal "DNS rebinding".
- Dimensione massima della richiesta: 64 KB.
