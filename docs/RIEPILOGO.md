# Riepilogo: il gateway di casa Belinchebon e le modifiche fatte

Documento scritto il 27/11/2026. Racconta cosa è stato costruito, cosa si può fare dall'app Claude, quali modifiche sono state applicate ai servizi (con i valori di prima e di dopo) e cosa resta da guardare.

## 1. Cosa c'è ora

Un unico punto di accesso (il **gateway**, un Cloudflare Worker) che parla con Plex, Radarr, Sonarr, qBittorrent, Overseerr/Seerr, Prowlarr, Bazarr, Cleanuparr e Proxmox. La homepage, Home Assistant e Claude lo usano al posto di chiamare i servizi uno per uno.

| Indirizzo | A cosa serve | Chi entra |
|---|---|---|
| `gateway.belinchebon.com` | API e strumenti per la homepage, Home Assistant e per Claude da sessioni di codice | Token di servizio Cloudflare Access, uno per cliente |
| `gateway.belinchebon.com/approve/…` | Pagina dove **tu** approvi le modifiche | Solo il tuo accesso personale (email e codice) |
| `mcp.belinchebon.com/mcp` | Il connettore per l'app Claude (telefono, web, desktop) | Login con OAuth di Cloudflare Access, solo la tua email |

Risorse create su Cloudflare: un archivio KV per piani e registro (`home-gateway-state`), due app Access (`home-gateway approvazioni` e `home-gateway mcp (OAuth)`), i segreti `APPROVAL_SECRET`, `APPROVERS` e `CLEANUPARR_API_KEY`, e il permesso `config:write` per l'agente. Il codice è nel repository `llingua/home-gateway`; ogni merge su `main` si pubblica da solo.

## 2. Cosa puoi fare dalla chat di Claude

**Leggere** (sempre, senza approvazione): stato di tutti i servizi (download, code, richieste, sottotitoli mancanti, salute, spazio, Proxmox) e le **configurazioni** di Radarr, Sonarr, Prowlarr, qBittorrent, Bazarr, Overseerr, Plex, Proxmox e Cleanuparr, già ripulite da chiavi, password e indirizzi.

**Cercare e aggiungere film e serie:** *"cerca Dune e dimmi se ce l'ho già"*, poi *"aggiungilo"*. Claude ti mostra titolo e anno, aspetta il tuo sì in chat e crea la richiesta in Overseerr. Massimo 10 al giorno, rifiuta ciò che è già richiesto o disponibile. È l'unica azione che non passa dalla pagina di approvazione.

**Modificare le impostazioni, sempre con approvazione:**

| Servizio | Cosa si può cambiare |
|---|---|
| qBittorrent | coda, connessioni, banda, torrent lenti |
| Radarr e Sonarr | profili di ritardo; ricerca e priorità di indexer e client di download; profili di qualità e punteggi dei formati |
| Prowlarr | attivare un indexer; rapporto e tempi di semina |
| Cleanuparr | opzioni generali, soglia delle importazioni fallite, regole di semina (modifica e creazione) |
| Bazarr | profilo lingua predefinito, punteggi, frequenze; assegnare un profilo a serie e film senza |
| Plex | trascodifica, aggiornamento e manutenzione delle librerie, banda |
| Seerr | opzioni generali; server Radarr/Sonarr collegati |
| **Proxmox** | **niente: si modifica solo a mano** |

**Come funziona una modifica:** Claude *propone* (con valore di prima e di dopo, senza cambiare nulla) → tu apri il link e premi **Approva** → Claude *applica*, rilegge e verifica. Il link vale 15 minuti, l'approvazione 10. Ogni modifica si annulla con una nuova proposta (tranne le creazioni di regole e le assegnazioni di profili, da togliere dall'interfaccia del servizio). Ogni passo finisce in un registro che Claude può leggere.

## 3. Sicurezza, in breve
- Claude non può approvare da solo: serve il tuo login personale; i token di servizio non possono approvare.
- Cambiano solo campi scelti, con limiti precisi. Mai percorsi, comandi, credenziali, reti o accessi.
- Chiavi e password passano solo dal gateway al servizio e non compaiono in chat, nei piani o nel registro.
- Proxmox ha tre barriere: token di sola lettura, nessuna azione possibile sul suo indirizzo, nessun tipo di scrittura verso di lui.
- Se un servizio rifiuta o cambia più del previsto, il piano risulta fallito e nulla resta a metà senza che tu lo sappia.
- Il Seerr vero è più severo di una simulazione: la prima prova è stata rifiutata (campo `id` di sola lettura) e il controllo ha fermato tutto senza cambiare niente.

## 4. Modifiche applicate ai tuoi servizi

Tutte approvate da te e verificate. Le righe in **grassetto** sono prove: puoi annullarle (la maggior parte non ha effetto pratico).

**qBittorrent**
- Torrent attivi 3 → 5, poi 5 → 20; upload attivi 2 → 15; upload per slot 4 → 15 (per torrent 2 → 4); connessioni 80 → 300 (per torrent 20 → 50); i torrent lenti non occupano più un posto (`dont_count_slow_torrents`). *Motivo: 256 torrent in semina, solo 2 attivi alla volta.*

**Cleanuparr**
- Tentativi di rete 0 → 2.
- Regole di semina separate per pubblici e privati: "Tutte le categorie" e "Unlinked Cleanup" ora valgono solo per i pubblici; nuove regole **Privati** (tv, anime, movies) e **Unlinked Privati**: rapporto 2, minimo 168 ore (7 giorni), massimo 336 ore. *Motivo: non cancellare troppo presto i torrent di FutureTorrent.*

**Bazarr**
- Profilo lingua predefinito "Italiano" attivo per serie e film nuovi; assegnato a 5 serie e 105 film che non avevano profilo. Lingue attive (it, en) e profili intatti.

**Plex**
- **Trascodifiche contemporanee: nessun limite → 3.** (Protegge la memoria dell'host.)

**Seerr**
- **Nascondere i contenuti già disponibili nelle pagine "Scopri": no → sì.**
- Server Radarr collegato: scansione disattivata e riattivata per prova (tornato com'era).

**Radarr e Sonarr**
- **Attesa Usenet nei profili di ritardo: Radarr 360 → 0, Sonarr 600 → 0 minuti** (usi solo torrent, nessun effetto).
- **Priorità di The Pirate Bay in Radarr: 25 → 26.**
- **Priorità del client qBittorrent in Radarr: 1 → 2** (ha un solo client, nessun effetto).
- **Profilo "Any" di Radarr: soglia di aggiornamento 1 → 2 e punteggio del formato "3D" 0 → −10** (profilo non usato dalle richieste di Seerr).

**Prowlarr**
- **The Pirate Bay: rapporto di semina richiesto "non impostato" → 0** (nessun effetto).

## 5. Da guardare (non li tocca il gateway)

In ordine di importanza:
1. **Proxmox, disco di sistema quasi pieno:** 84 GB usati su 94 (la cartella di trascodifica di Plex è lì).
2. **Proxmox, memoria:** 26,8 su 30,3 GB usati, swap 11,8 su 23,2 GB; la VM Home Assistant è al 95%.
3. **Backup di Proxmox:** il lavoro pianificato salva solo il guest 103 (jarvis), sullo stesso disco di sistema. Windows 11, Plex e Home Assistant non hanno backup a livello di Proxmox.
4. **Aggiornamenti disponibili:** Radarr (v7.0.3), Prowlarr (v3.1.0), Seerr.
5. **The Pirate Bay** non risponde da ore (Prowlarr l'ha messo in pausa). Se resta così, sostituirlo.
6. **Radarr** segnala il film "Hotel Transylvania 2" rimosso da TMDb: va tolto dalla libreria.
7. **Arretrati:** circa 1.550 episodi e 23 film cercati e non trovati; sottotitoli mancanti 33 film e 2.453 episodi (la ricerca di Bazarr ora parte da sola ogni 6 ore: ricontrollare tra qualche giorno).
8. **Cleanuparr:** controllo di connettività ancora spento.
9. **Tracker privati:** i 7 giorni di semina sono una scelta prudente; se FutureTorrent chiede meno, si può abbassare.

## 6. Limiti da conoscere
- Le letture restano in cache fino a 60 secondi, ma dopo ogni modifica applicata la cache si svuota. La cache è per sede Cloudflare: da un'altra sede il vecchio valore può restare al massimo 60 secondi.
- Le letture di configurazione mostrano solo i campi scelti: se un servizio aggiunge un'impostazione nuova, non la vede finché non la si aggiunge.
- Non sono state provate dal vivo (solo nei test): modificare un server **Sonarr** collegato in Seerr e attivare/disattivare un indexer in Prowlarr.
- L'accesso dall'app Claude dura 24 ore, poi si rifà il login.
