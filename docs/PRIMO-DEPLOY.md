# Primo deploy

Il codice è pronto; per metterlo online servono questi passi, in quest'ordine. I punti 1-3 si possono fare dalla dashboard Cloudflare oppure farli fare a Claude con il connettore Cloudflare.

## 1. Service token

In Zero Trust → Access → Service Auth crea (o riusa) i token e annota i **Client ID**:

| Token | Chi lo usa |
|---|---|
| `gateway-upstream` | Il gateway, per entrare in Radarr, Sonarr, Overseerr, Plex, qBittorrent. Va aggiunto alla policy "Service Auth" di quelle app. |
| `client-homepage` | La homepage, per chiamare il gateway |
| `client-home-assistant` | Home Assistant (quando serve) |
| `client-agent` | L'agente AI (quando serve) |

## 2. App Access del gateway

1. Zero Trust → Access → Applications → aggiungi un'app self-hosted per `gateway.belinchebon.com`.
2. Policy "Service Auth" con i token `client-*`. Nessuna policy "Allow" per email, a meno che tu non voglia aprirla anche a te nel browser.
3. Annota l'**AUD tag** dell'app.

## 3. Configurazione del Worker

1. In `wrangler.jsonc` → `vars` aggiungi `ACCESS_AUD` (l'AUD tag) e `CLIENTS` (vedi README).
2. Imposta i segreti (README → "Segreti").

## 4. Deploy e dominio

1. `npm run deploy`. Il dominio `gateway.belinchebon.com` viene creato come dominio personalizzato (la zona `belinchebon.com` deve essere nello stesso account).
2. Verifica:
   - `GET https://gateway.belinchebon.com/healthz` → 200 senza credenziali.
   - `GET https://gateway.belinchebon.com/v1/capabilities` senza credenziali → 403/302 (Access).
   - Con le intestazioni `CF-Access-Client-Id` / `CF-Access-Client-Secret` di un cliente → elenco delle sezioni.

## 5. Collegare i clienti

- **Homepage**: la Pages Function chiama il gateway con il token `client-homepage` (segreti Pages `GATEWAY_CLIENT_ID` e `GATEWAY_CLIENT_SECRET`).
- **Home Assistant**: un `rest` sensor o `rest_command` con le due intestazioni.
- **Agente AI**: stesse intestazioni, `GET /v1/capabilities` per scoprire cosa può fare.
