# Livello 3: modifiche con approvazione umana

Un agente (come Claude) può **proporre** una modifica; non la applica finché **una persona** non l'ha approvata in browser.

## Il ciclo

1. **Proposta** — strumento MCP `propose_qbittorrent_preferences` o `propose_prowlarr_indexer_enabled`. Il gateway legge lo stato attuale, valida i valori e salva un *piano* (prima → dopo, e come annullare). **Non cambia nulla.** Risposta: un link `/approve/<id>`. Il piano scade dopo 15 minuti; al massimo 10 piani in attesa.
2. **Approvazione** — la persona apre il link (login Access con la sua email, che deve essere in `APPROVERS`), legge il piano e preme Approva o Rifiuta. I service token non hanno email e non possono approvare.
3. **Applicazione** — `apply_plan`. Funziona solo se il piano è approvato, non scaduto (10 minuti dopo l'approvazione), e lo stato del servizio non è cambiato nel frattempo; una volta sola. Dopo la scrittura il gateway rilegge e verifica.
4. **Registro** — ogni passo (proposta, decisione, applicazione, errore) finisce in KV per 90 giorni; `get_audit_log` lo legge.
5. **Annullare** — `propose_undo`: crea un nuovo piano che ripristina i valori precedenti, da approvare come gli altri.

## Cosa si può modificare (e nient'altro)

| Azione | Campi |
|---|---|
| `qbittorrent_preferences` | `max_active_downloads` 1–100, `max_active_uploads` 1–100, `max_active_torrents` 1–200, `dl_limit`/`up_limit` 0–2.000.000.000 |
| `prowlarr_indexer_enabled` | `indexerId`, `enable` (le credenziali dell'indexer non escono mai dal gateway) |

## Messa online (passi manuali)

1. **KV**: creare un namespace e collegarlo come `STATE` in `wrangler.jsonc` (`kv_namespaces`).
2. **Access**: nuova app self-hosted su `gateway.belinchebon.com/approve` con una policy *Allow* per le email degli approvatori (solo persone, niente Service Auth). Copiare l'AUD in `ACCESS_AUD_APPROVAL` (variabile non segreta). Il percorso `/approve` deve restare escluso dall'app generale, o coperto da una policy che includa le persone. La pagina esiste solo su questo indirizzo: la variabile `APPROVAL_ORIGIN` (`https://gateway.belinchebon.com`) fa puntare lì i link di approvazione anche quando l'agente entra da `mcp.belinchebon.com`.
3. **Segreti del Worker**: `APPROVAL_SECRET` (stringa casuale lunga) e `APPROVERS` (email separate da virgola).
4. **Permesso**: aggiungere `config:write` al cliente `agente` in `CLIENTS`.

Senza questi passi le scritture restano spente (il Worker risponde 503 sulla pagina di approvazione e non mostra gli strumenti di scrittura).

## Garanzie verificate dai test

Nessuna modifica in fase di proposta; permesso `config:write` richiesto sia a proporre sia ad applicare; service token e email non autorizzate non approvano; CSRF e Origin controllati; HTML della pagina con escape; piano usabile una sola volta, scade, rifiutato non si applica; deriva dello stato blocca l'applicazione; credenziali Prowlarr preservate; fallimento di verifica segnato `failed`.
Non ancora provato contro qBittorrent e Prowlarr reali: il primo uso va fatto con una modifica innocua.
