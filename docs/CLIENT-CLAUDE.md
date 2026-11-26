# Collegare Claude (o un altro agente) al gateway

Il gateway espone i suoi dati anche come **server MCP** (Model Context Protocol) su `POST https://gateway.belinchebon.com/mcp`. Un agente scopre da solo gli strumenti disponibili (`get_overview`, `get_streams`, `get_queue`, `get_proxmox`...) e li usa per rispondere a domande come "cosa sta scaricando il server?" o "perché Radarr non trova niente?".

**Oggi tutti gli strumenti sono di sola lettura.** Il gateway non modifica nulla: le azioni di scrittura, quando ci saranno, avranno un permesso separato.

## 1. Token dedicato (lo crei tu: il segreto si vede una volta sola)

Zero Trust → Access → Service Auth → **Create Service Token** → nome `client-agent`. Copia **Client ID** e **Client Secret** (il secret non va né in chat né nel repository).

Poi serve autorizzarlo (può farlo Claude se gli dai solo il Client ID):
1. Access → Applications → `home-gateway` → policy "Gateway clients" → aggiungi il token.
2. `wrangler.jsonc` → `vars.CLIENTS` → una riga con i permessi dell'agente, per esempio:
   `"<client-id>": { "name": "agente", "scopes": ["media:read"] }`

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

**Connettori di claude.ai e sessioni cloud di Claude Code:** usano OAuth e non permettono intestazioni fisse, quindi con questa autenticazione **non si collegano ancora**. Opzioni, da decidere quando servono:
- accettare il token di servizio in un'unica intestazione (impostazione dell'app Access) e salvarlo come credenziale della sessione, così l'agente chiama il gateway senza vedere il segreto;
- aggiungere OAuth al gateway (Cloudflare Access come provider): più lavoro.

## 3. Cosa fa e cosa non fa

- Ogni cliente vede solo gli strumenti per cui ha il permesso (`tools/list` li filtra) e non può chiamare gli altri.
- Il gateway registra nei log **chi** ha chiamato **quale strumento**, mai i dati restituiti.
- Non esistono sessioni né flussi SSE: ogni richiesta è un POST con risposta JSON.
- Le richieste con intestazione `Origin` (browser) sono rifiutate: protegge dal "DNS rebinding".
- Dimensione massima della richiesta: 64 KB.
