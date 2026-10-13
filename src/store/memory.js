// Armazenamento em memória para o MVP. Para produção, troque por PostgreSQL
// mantendo estes mesmos métodos (é a "interface" que os serviços usam).
export class MemoryStore {
  constructor() {
    this.cotacoes = new Map();
    this.entregas = new Map();
    this.entregadores = new Map();
    this.eventos = []; // { id, entrega_id, tipo, de, para, em, meta }
    this.idempotencia = new Map(); // `${cliente}:${chave}` -> { hash, resposta }
  }

  transaction(work) { return work(); }
  afterCommit(callback) { callback(); }

  // Cotações
  saveQuote(q) { this.cotacoes.set(q.id, q); return q; }
  getQuote(id) { return this.cotacoes.get(id); }

  // Entregas
  saveDelivery(d) { this.entregas.set(d.id, d); return d; }
  getDelivery(id) { return this.entregas.get(id); }
  listDeliveries({ status, cliente } = {}) {
    return [...this.entregas.values()]
      .filter((d) => (!status || d.status === status) && (!cliente || d.cliente === cliente))
      .sort((a, b) => b.criada_em.localeCompare(a.criada_em));
  }

  // Entregadores
  saveCourier(c) { this.entregadores.set(c.id, c); return c; }
  getCourier(id) { return this.entregadores.get(id); }
  listCouriers() { return [...this.entregadores.values()]; }

  // Eventos
  addEvent(e) { this.eventos.push(e); return e; }
  listEvents(entregaId) { return this.eventos.filter((e) => e.entrega_id === entregaId); }

  // Idempotência
  getIdem(k) { return this.idempotencia.get(k); }
  saveIdem(k, v) { this.idempotencia.set(k, v); }
}
