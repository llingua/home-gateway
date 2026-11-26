# Home Assistant come cliente del gateway

Home Assistant continua a fare i controlli di disponibilità dalla rete locale e **non deve dipendere dal gateway per le cose critiche**: se manca Internet o Cloudflare, il gateway non risponde. Usalo solo per dati "di contorno" (stream, code, richieste).

## 1. Crea un token dedicato (lo fai tu: il segreto si vede una volta sola)

Zero Trust → Access → Service Auth → **Create Service Token** → nome `client-home-assistant`. Copia **Client ID** e **Client Secret**.

Non incollare il Client Secret in chat né nel repository.

## 2. Autorizza il token (può farlo Claude se gli dai solo il Client ID)

1. Access → Applications → `home-gateway` → policy "Gateway clients" → aggiungi il token `client-home-assistant`.
2. In `wrangler.jsonc` → `vars.CLIENTS` aggiungi:

```jsonc
"<client-id-di-home-assistant>": { "name": "home-assistant", "scopes": ["media:read"] }
```

Poi merge su `main`: Workers Builds rilascia da solo. Senza questa riga il token supera Access ma il gateway risponde 403 `unknown_client`.

## 3. Metti le credenziali nei segreti di Home Assistant

Nel `secrets.yaml` **sull'host** di Home Assistant:

```yaml
gateway_client_id: "<client id>"
gateway_client_secret: "<client secret>"
```

Prima verifica che `secrets.yaml` **non sia versionato** nel repository `homeassistant-config`: se lo è, i valori finirebbero su GitHub.

## 4. Esempio di sensori (NON attivo: copialo in un package solo se ti serve)

Una sola chiamata ogni 2 minuti, con cache lato gateway:

```yaml
rest:
  - resource: https://gateway.belinchebon.com/v1/media/overview?sections=streams,requests,downloads
    scan_interval: 120
    timeout: 10
    headers:
      CF-Access-Client-Id: !secret gateway_client_id
      CF-Access-Client-Secret: !secret gateway_client_secret
    sensor:
      - name: "Gateway Plex stream"
        unique_id: gateway_plex_streams
        value_template: >-
          {{ value_json.sections.streams.data.count
             if value_json.sections.streams.status == 'ok' else none }}
      - name: "Gateway richieste in attesa"
        unique_id: gateway_requests_pending
        value_template: >-
          {{ value_json.sections.requests.data.pending
             if value_json.sections.requests.status == 'ok' else none }}
      - name: "Gateway download MB/s"
        unique_id: gateway_download_mbs
        unit_of_measurement: "MB/s"
        value_template: >-
          {{ value_json.sections.downloads.data.downloadMBs
             if value_json.sections.downloads.status == 'ok' else none }}
```

Le sezioni non configurate o in errore restituiscono `none`: il sensore diventa "sconosciuto", non rompe nulla.

## 5. Verifica

`GET https://gateway.belinchebon.com/v1/capabilities` con le due intestazioni deve rispondere con `"client": "home-assistant"`. Un 403 senza corpo viene da Access (token non nella policy); un 403 con `unknown_client` viene dal gateway (manca la riga in `CLIENTS`).
