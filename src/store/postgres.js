import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';

export class PostgresStore {
  #pool;
  #transactions = new AsyncLocalStorage();

  constructor({ connectionString, pool } = {}) {
    this.#pool = pool ?? new Pool({ connectionString });
  }

  async transaction(work) {
    if (this.#transactions.getStore()) return work();

    const client = await this.#pool.connect();
    const transaction = { client, afterCommit: [] };
    let started = false;
    try {
      await client.query('BEGIN');
      started = true;
      const result = await this.#transactions.run(transaction, work);
      await client.query('COMMIT');
      for (const callback of transaction.afterCommit) {
        try { callback(); } catch (error) { console.error('[after-commit]', error); }
      }
      return result;
    } catch (error) {
      if (started) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  afterCommit(callback) {
    const transaction = this.#transactions.getStore();
    if (transaction) transaction.afterCommit.push(callback);
    else callback();
  }

  async saveQuote(quote) {
    await this.#query(
      `INSERT INTO quotes (id, payload) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      [quote.id, JSON.stringify(quote)],
    );
    return quote;
  }

  async getQuote(id) {
    const lock = this.#transactions.getStore() ? ' FOR UPDATE' : '';
    const { rows } = await this.#query(`SELECT payload FROM quotes WHERE id = $1${lock}`, [id]);
    return rows[0]?.payload;
  }

  async saveDelivery(delivery) {
    await this.#query(
      `INSERT INTO deliveries
         (id, client_name, external_order_id, quote_id, status, courier_id, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         client_name = EXCLUDED.client_name,
         external_order_id = EXCLUDED.external_order_id,
         quote_id = EXCLUDED.quote_id,
         status = EXCLUDED.status,
         courier_id = EXCLUDED.courier_id,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [
        delivery.id,
        delivery.cliente,
        delivery.pedido_externo_id,
        delivery.cotacao_id,
        delivery.status,
        delivery.entregador_id,
        JSON.stringify(delivery),
        delivery.criada_em,
        delivery.atualizada_em,
      ],
    );
    return delivery;
  }

  async getDelivery(id) {
    const lock = this.#transactions.getStore() ? ' FOR UPDATE' : '';
    const { rows } = await this.#query(`SELECT payload FROM deliveries WHERE id = $1${lock}`, [id]);
    return rows[0]?.payload;
  }

  async listDeliveries({ status, cliente } = {}) {
    const { rows } = await this.#query(
      `SELECT payload FROM deliveries
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR client_name = $2)
       ORDER BY created_at DESC`,
      [status || null, cliente || null],
    );
    return rows.map((row) => row.payload);
  }

  async saveCourier(courier) {
    await this.#query(
      `INSERT INTO couriers (id, status, vehicle, position, payload)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         vehicle = EXCLUDED.vehicle,
         position = EXCLUDED.position,
         payload = EXCLUDED.payload`,
      [courier.id, courier.status, courier.veiculo, JSON.stringify(courier.posicao), JSON.stringify(courier)],
    );
    return courier;
  }

  async getCourier(id) {
    const lock = this.#transactions.getStore() ? ' FOR UPDATE' : '';
    const { rows } = await this.#query(`SELECT payload FROM couriers WHERE id = $1${lock}`, [id]);
    return rows[0]?.payload;
  }

  async listCouriers() {
    const { rows } = await this.#query('SELECT payload FROM couriers ORDER BY id');
    return rows.map((row) => row.payload);
  }

  async addEvent(event) {
    await this.#query(
      `INSERT INTO delivery_events (id, delivery_id, from_status, to_status, occurred_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [event.id, event.entrega_id, event.de, event.para, event.em, JSON.stringify(event.meta)],
    );
    return event;
  }

  async listEvents(deliveryId) {
    const { rows } = await this.#query(
      `SELECT from_status, to_status, occurred_at, metadata
        FROM delivery_events WHERE delivery_id = $1 ORDER BY sequence`,
      [deliveryId],
    );
    return rows.map((row) => ({
      de: row.from_status,
      para: row.to_status,
      em: row.occurred_at.toISOString(),
      meta: row.metadata,
    }));
  }

  async getIdem(id) {
    const { rows } = await this.#query(
      'SELECT body_hash, response_status, response_body FROM idempotency_records WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row && { hash: row.body_hash, status: row.response_status, body: row.response_body };
  }

  async saveIdem(id, value) {
    await this.#query(
      `INSERT INTO idempotency_records (id, body_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         response_status = EXCLUDED.response_status,
         response_body = EXCLUDED.response_body
       WHERE idempotency_records.body_hash = EXCLUDED.body_hash`,
      [id, value.hash, value.status, JSON.stringify(value.body)],
    );
  }

  async close() {
    await this.#pool.end();
  }

  async ping() {
    await this.#query('SELECT 1');
  }

  #query(sql, values) {
    const transaction = this.#transactions.getStore();
    return (transaction?.client ?? this.#pool).query(sql, values);
  }
}