# Token API di Proxmox (sola lettura)

Il gateway legge Proxmox con un token API **di sola lettura**, legato a un utente dedicato. Così, se il token venisse mai esposto, non permette di accendere, spegnere o modificare nulla.

## 1. Utente dedicato

Proxmox → Datacenter → Permissions → Users → **Add**:
- User name: `gateway`
- Realm: `Proxmox VE authentication server` (`pve`)
- Password: una qualsiasi lunga e casuale (non verrà usata: serve solo il token)

## 2. Permesso di sola lettura

Datacenter → Permissions → **Add → User Permission**:
- Path: `/`
- User: `gateway@pve`
- Role: **PVEAuditor**
- Propagate: attivo

## 3. Token

Datacenter → Permissions → API Tokens → **Add**:
- User: `gateway@pve`
- Token ID: `home`
- **Privilege Separation: disattivato** (così eredita i permessi dell'utente; con la separazione attiva servirebbe un permesso anche sul token)

Alla creazione Proxmox mostra il **Secret una sola volta**: copialo subito.

## 4. Segreto nel Worker

Cloudflare → Workers & Pages → `home-gateway` → Settings → Variables and Secrets → Add → tipo **Secret**:

- Nome: `PROXMOX_API_TOKEN`
- Valore: `gateway@pve!home=<il-secret>` (utente, `!`, ID del token, `=`, secret: tutto su una riga, senza spazi)

Non incollarlo in chat né nel repository.

## 5. Verifica

`GET /v1/media/proxmox` dal gateway (con le credenziali di un cliente) deve restituire `status: "ok"` con `node`, `guests`, `storage` e `backup`. Un `error` con "Accesso rifiutato dal servizio" significa token o permessi sbagliati. La sezione `unconfigured` significa che il segreto non c'è ancora.

## Cosa legge il gateway

Solo `GET /api2/json/cluster/resources` e `GET /api2/json/nodes/<nodo>/tasks?typefilter=vzdump`. Nessuna azione di scrittura.
