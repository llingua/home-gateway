# Primo deploy

Stato al 26/11/2026: i passi 1-3 sono **fatti** (via connettore Cloudflare). Restano il collegamento del repository e i segreti.

## 1. Service token — fatto

In Zero Trust → Access → Service Auth:

| Token | Uso |
|---|---|
| `gateway-upstream` | Il gateway, per entrare in Radarr, Sonarr, Overseerr, Plex, qBittorrent. Collegato con la policy "Gateway upstream" alle loro app Access. |
| `client-homepage` | La homepage, per chiamare il gateway. Le sue credenziali sono nei segreti Pages `GATEWAY_CLIENT_ID` / `GATEWAY_CLIENT_SECRET`. |

Altri clienti (Home Assistant, agente AI): un token ciascuno, da creare quando servono, e una riga in `CLIENTS`.

## 2. App Access `home-gateway` — fatto

App self-hosted per `gateway.belinchebon.com` con la sola policy "Gateway clients" (Service Auth: `client-homepage`). L'AUD è in `wrangler.jsonc` (`ACCESS_AUD`).

## 3. Variabili — fatto

`ACCESS_AUD` e `CLIENTS` sono in `wrangler.jsonc`.

## 4. Collegare il repository (dashboard Cloudflare)

Workers & Pages → Create → **Import a repository** → GitHub → `llingua/home-gateway`. Il nome del progetto deve essere `home-gateway` (come in `wrangler.jsonc`). Comando di deploy predefinito: `npx wrangler deploy`. Il dominio `gateway.belinchebon.com` viene collegato dal deploy.

## 5. Segreti del Worker (dashboard)

Workers & Pages → `home-gateway` → Settings → Variables and Secrets → Add → tipo **Secret**:

`RADARR_API_KEY`, `SONARR_API_KEY`, `OVERSEERR_API_KEY`, `PLEX_TOKEN`, `QBT_USERNAME`, `QBT_PASSWORD`

Più `CF_ACCESS_CLIENT_ID` e `CF_ACCESS_CLIENT_SECRET` (le credenziali di `gateway-upstream`): le imposta Claude dal connettore Cloudflare, senza passare dalla chat.

## 6. Verifica

- Senza credenziali, `https://gateway.belinchebon.com/v1/capabilities` → 403 (Access).
- Con le intestazioni `CF-Access-Client-Id` e `CF-Access-Client-Secret` di un cliente → elenco delle sezioni.
- `/v1/media/overview`: le sezioni con segreti mancanti risultano `unconfigured`, non in errore.
