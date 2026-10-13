import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore } from './memory.js';

export class FileStore extends MemoryStore {
  #filePath;
  #transactionDepth = 0;

  constructor({ filePath }) {
    super();
    this.#filePath = filePath;
    try {
      const saved = JSON.parse(readFileSync(filePath, 'utf8'));
      this.cotacoes = new Map(saved.cotacoes || []);
      this.entregas = new Map(saved.entregas || []);
      this.entregadores = new Map(saved.entregadores || []);
      this.eventos = saved.eventos || [];
      this.idempotencia = new Map(saved.idempotencia || []);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async transaction(work) {
    this.#transactionDepth += 1;
    try {
      const result = await work();
      if (this.#transactionDepth === 1) this.#persist();
      return result;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  saveQuote(quote) { return this.#save(() => super.saveQuote(quote)); }
  saveDelivery(delivery) { return this.#save(() => super.saveDelivery(delivery)); }
  saveCourier(courier) { return this.#save(() => super.saveCourier(courier)); }
  addEvent(event) { return this.#save(() => super.addEvent(event)); }
  saveIdem(key, value) { return this.#save(() => super.saveIdem(key, value)); }

  #save(write) {
    const result = write();
    if (this.#transactionDepth === 0) this.#persist();
    return result;
  }

  #persist() {
    mkdirSync(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({
      cotacoes: [...this.cotacoes],
      entregas: [...this.entregas],
      entregadores: [...this.entregadores],
      eventos: this.eventos,
      idempotencia: [...this.idempotencia],
    }), 'utf8');
    renameSync(temporaryPath, this.#filePath);
  }
}