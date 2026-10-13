import { createHmac, randomUUID } from 'node:crypto';

export function sign(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

// Envia eventos assinados com HMAC e tenta de novo com backoff.
// MVP: retentativas em memória (se o processo cair, perde). Em produção,
// use uma fila (SQS/RabbitMQ/BullMQ) e uma tabela de tentativas.
export class WebhookDispatcher {
  constructor({ url, secret, retryDelaysMs = [], fetchFn = globalThis.fetch, logger = console }) {
    this.url = url;
    this.secret = secret;
    this.retryDelaysMs = retryDelaysMs;
    this.fetchFn = fetchFn;
    this.logger = logger;
    this.timers = new Set();
  }

  emit(tipo, data) {
    if (!this.url) return null;
    const evento = {
      event_id: `evt_${randomUUID()}`,
      tipo,
      criado_em: new Date().toISOString(),
      data,
    };
    this.#attempt(evento, 0);
    return evento;
  }

  async #attempt(evento, n) {
    const body = JSON.stringify(evento);
    try {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-event-id': evento.event_id,
          'x-signature': `sha256=${sign(this.secret, body)}`,
        },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const delay = this.retryDelaysMs[n];
      if (delay === undefined) {
        this.logger.error(`[webhook] desistiu de ${evento.event_id}: ${err.message}`);
        return;
      }
      this.logger.warn(`[webhook] falha (${err.message}); nova tentativa em ${delay}ms`);
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.#attempt(evento, n + 1);
      }, delay);
      t.unref?.();
      this.timers.add(t);
    }
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
