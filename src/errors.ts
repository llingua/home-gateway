/** Errore da restituire al cliente con un codice HTTP preciso. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Il servizio a monte ha risposto male o non ha risposto. Il messaggio è sempre statico: niente URL né chiavi. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** Mancano i segreti per parlare con il servizio: non è un errore, è "non ancora configurato". */
export class NotConfigured extends Error {
  constructor(service: string) {
    super(`${service} non configurato`);
  }
}

/** Errore di una scrittura (proposta, approvazione, applicazione): il messaggio è per l'agente e per la persona che approva. */
export class WriteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
