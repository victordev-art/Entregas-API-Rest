import { randomInt, randomUUID } from 'node:crypto';
import { calcQuote, pickVehicle } from './quote.js';
import { AppError } from '../errors.js';
import { STATUS, WEBHOOK_EVENT, assertTransition, FINAL_STATUSES } from './stateMachine.js';
import { notFound, conflict, unprocessable } from '../errors.js';

export class DeliveryService {
  constructor({ store, config, webhooks, geography }) {
    this.store = store;
    this.config = config;
    this.webhooks = webhooks;
    this.geography = geography;
  }

  #transaction(work) {
    return this.store.transaction ? this.store.transaction(work) : work();
  }

  // ---------- Cotação ----------
  createQuote(input) {
    return this.#transaction(async () => {
      const [origem, destino] = await Promise.all([
        this.geography.resolveLocation(input.origem),
        this.geography.resolveLocation(input.destino),
      ]);
      const vehicle = pickVehicle(input.itens);
      const route = await this.geography.route(origem, destino, vehicle);
      if (route.source !== 'rota_viaria') {
        throw new AppError(503, 'rota_indisponivel', 'Não foi possível calcular uma rota pelas ruas agora; tente novamente');
      }
      const q = calcQuote({ ...input, origem, destino, routeMetrics: route }, this.config);
      await this.store.saveQuote(q);
      return publicQuote(q);
    });
  }

  // ---------- Entregas ----------
  createDelivery({ cliente, input }) {
    return this.#transaction(async () => {
      const q = await this.store.getQuote(input.cotacao_id);
      if (!q) throw notFound('Cotação');
      if (q.usada) throw conflict('cotacao_usada', 'Esta cotação já foi usada');
      if (new Date(q.expira_em) < new Date()) {
        throw unprocessable('cotacao_expirada', 'Cotação expirada; gere uma nova');
      }
      if (input.entregador_id && q.forma_entrega === 'terceiro_express') {
        throw conflict('modalidade_terceirizada', 'A entrega expressa é atribuída ao parceiro terceirizado');
      }
      if (input.entregador_id) {
        const courier = await this.store.getCourier(input.entregador_id);
        if (!courier) throw notFound('Entregador');
        if (courier.status !== 'disponivel') throw conflict('entregador_indisponivel', 'Entregador não está disponível');
        if (!courierFitsVehicle(courier.veiculo, q.veiculo)) {
          throw unprocessable('veiculo_incompativel', `Esta entrega exige ${q.veiculo}; entregador está de ${courier.veiculo}`);
        }
      }

    const agora = new Date().toISOString();
    const entrega = {
      id: `ent_${randomUUID().slice(0, 8)}`,
      cliente,
      pedido_externo_id: input.pedido_externo_id,
      vendedor_nome: input.vendedor_nome || null,
      cotacao_id: q.id,
      status: STATUS.CRIADA,
      veiculo: q.veiculo,
      modalidade: q.modalidade,
      forma_entrega: q.forma_entrega,
      valor_centavos: q.valor_centavos,
      cobranca_externa: q.cobranca_externa,
      moeda: q.moeda,
      prazo_minutos: q.prazo_minutos,
      previsao_entrega_em: new Date(Date.parse(agora) + q.prazo_minutos * 60_000).toISOString(),
      distancia_km: q.distancia_km,
      tempo_viagem_minutos: q.tempo_viagem_minutos,
      fonte_estimativa: q.fonte_estimativa,
      coleta: { ...input.coleta, ...q.origem },
      entrega: { ...input.entrega, ...q.destino },
      itens: q.itens,
      codigo_confirmacao: String(randomInt(0, 10000)).padStart(4, '0'),
      entregador_id: null,
      prova: null,
      motivo_falha: null,
      terceiro: null,
      criada_em: agora,
      atualizada_em: agora,
    };
      q.usada = true;
      await this.store.saveQuote(q);
      await this.store.saveDelivery(entrega);
      await this.#record(entrega, null, STATUS.CRIADA);
      // Já entra na fila de despacho
      await this.transition(entrega.id, STATUS.PROCURANDO);
      if (input.entregador_id) await this.assign(entrega.id, input.entregador_id);
      else await this.#dispatch(entrega);
      return this.get(entrega.id, cliente);
    });
  }

  async get(id, cliente) {
    const d = await this.#find(id, cliente);
    const out = publicDelivery(d);
    out.eventos = (await this.store.listEvents(id)).map(({ para, em, meta }) => ({ status: para, em, ...meta }));
    if (d.entregador_id) {
      const c = await this.store.getCourier(d.entregador_id);
      out.entregador = c && { id: c.id, nome: c.nome, telefone: c.telefone, veiculo: c.veiculo, posicao: c.posicao };
    } else if (d.terceiro) {
      out.entregador = { ...d.terceiro, tipo: 'terceiro' };
    }
    return out;
  }

  async list({ cliente, status }) {
    return (await this.store.listDeliveries({ cliente, status })).map(publicDelivery);
  }

  async planRoutes({ cliente } = {}) {
    const activeStatuses = new Set([
      STATUS.PROCURANDO, STATUS.ATRIBUIDA, STATUS.COLETADA,
      STATUS.EM_ROTA, STATUS.FALHOU, STATUS.DEVOLVENDO,
    ]);
    const deliveries = await this.store.listDeliveries({ cliente });
    const couriers = await this.store.listCouriers();
    const courierById = new Map(couriers.map((courier) => [courier.id, courier]));
    const active = deliveries.filter((delivery) =>
      activeStatuses.has(delivery.status)
      && Number.isFinite(delivery.coleta?.lat)
      && Number.isFinite(delivery.coleta?.lng)
      && Number.isFinite(delivery.entrega?.lat)
      && Number.isFinite(delivery.entrega?.lng),
    );

    const routes = await Promise.all(active.map(async (delivery) => {
      const courier = delivery.entregador_id ? courierById.get(delivery.entregador_id) : null;
      const gpsPosition = freshGpsPosition(courier?.posicao, this.config);
      const returning = delivery.status === STATUS.DEVOLVENDO;
      const courierIsApproaching = delivery.status === STATUS.ATRIBUIDA && gpsPosition;
      const courierIsMoving = [STATUS.COLETADA, STATUS.EM_ROTA, STATUS.DEVOLVENDO].includes(delivery.status) && gpsPosition;
      let route;
      if (courierIsApproaching) {
        const [pickupRoute, deliveryRoute] = await Promise.all([
          this.geography.route(gpsPosition, delivery.coleta, delivery.veiculo, { includeGeometry: true }),
          this.geography.route(delivery.coleta, delivery.entrega, delivery.veiculo, { includeGeometry: true }),
        ]);
        const hasBothRoadGeometries = pickupRoute.source === 'rota_viaria'
          && deliveryRoute.source === 'rota_viaria'
          && Array.isArray(pickupRoute.geometry)
          && pickupRoute.geometry.length > 1
          && Array.isArray(deliveryRoute.geometry)
          && deliveryRoute.geometry.length > 1;
        if (hasBothRoadGeometries) {
          route = {
            source: 'rota_viaria',
            distanceKm: pickupRoute.distanceKm + deliveryRoute.distanceKm,
            durationMinutes: pickupRoute.durationMinutes + deliveryRoute.durationMinutes,
            geometry: [...pickupRoute.geometry, ...deliveryRoute.geometry.slice(1)],
          };
        } else {
          route = { source: 'rota_indisponivel' };
        }
      } else {
        const start = returning
          ? (courierIsMoving ? gpsPosition : delivery.entrega)
          : (courierIsMoving ? gpsPosition : delivery.coleta);
        const end = returning ? delivery.coleta : delivery.entrega;
        route = await this.geography.route(start, end, delivery.veiculo, { includeGeometry: true });
      }
      const hasRoadGeometry = Array.isArray(route.geometry) && route.geometry.length > 1;
      return {
        id: delivery.id,
        pedido_externo_id: delivery.pedido_externo_id,
        vendedor_nome: delivery.vendedor_nome,
        status: delivery.status,
        forma_entrega: delivery.forma_entrega,
        distancia_km: hasRoadGeometry ? route.distanceKm : delivery.distancia_km,
        tempo_restante_minutos: hasRoadGeometry ? Math.ceil(route.durationMinutes) : null,
        previsao_entrega_em: delivery.previsao_entrega_em,
        coleta: delivery.coleta,
        entrega: delivery.entrega,
        motoboy: courier && {
          id: courier.id,
          nome: courier.nome,
          status: courier.status,
          posicao: courier.posicao,
        },
        geometry: hasRoadGeometry ? route.geometry : null,
        fonte_estimativa: hasRoadGeometry ? route.source : 'rota_indisponivel',
      };
    }));

    return {
      data: routes,
      motoboys: couriers.map(({ id, nome, status, posicao }) => ({ id, nome, status, posicao })),
    };
  }

  cancel(id, cliente, motivo) {
    return this.#transaction(async () => {
      const d = await this.#find(id, cliente);
      const pos = d.status;
      await this.transition(id, STATUS.CANCELADA, { motivo });
      // Após a coleta já não dá para cancelar: a state machine bloqueia (409).
      if (d.entregador_id) await this.#freeCourier(d.entregador_id);
      return { id, status: STATUS.CANCELADA, status_anterior: pos };
    });
  }

  // ---------- Operação (painel interno / app do entregador) ----------
  assign(id, entregadorId) {
    return this.#transaction(async () => {
      const d = await this.#find(id);
      if (d.forma_entrega === 'terceiro_express') {
        throw conflict('modalidade_terceirizada', 'Esta entrega deve ser atribuída a um terceiro');
      }
      const c = await this.store.getCourier(entregadorId);
      if (!c) throw notFound('Entregador');
      if (c.status !== 'disponivel') throw conflict('entregador_indisponivel', 'Entregador não está disponível');
      if (!courierFitsVehicle(c.veiculo, d.veiculo)) {
        throw unprocessable('veiculo_incompativel', `Esta entrega exige ${d.veiculo}; entregador está de ${c.veiculo}`);
      }
      const assigned = await this.transition(id, STATUS.ATRIBUIDA, { entregador_id: c.id });
      assigned.entregador_id = c.id;
      c.status = 'em_entrega';
      await this.store.saveDelivery(assigned);
      await this.store.saveCourier(c);
      return this.get(id);
    });
  }

  assignExternal(id, { nome, telefone, custo_centavos }) {
    return this.#transaction(async () => {
      const d = await this.#find(id);
      if (d.forma_entrega !== 'terceiro_express') {
        throw conflict('modalidade_propria', 'Esta entrega usa a frota própria');
      }
      const terceiro = { nome, telefone, custo_centavos: custo_centavos ?? null, contratado_em: new Date().toISOString() };
      const assigned = await this.transition(id, STATUS.ATRIBUIDA, { tipo: 'terceiro', nome, telefone, custo_centavos: custo_centavos ?? null });
      assigned.terceiro = terceiro;
      await this.store.saveDelivery(assigned);
      return this.get(id);
    });
  }

  // Entregador recusa/desiste antes de coletar -> volta para a fila
  release(id) {
    return this.#transaction(async () => {
      const d = await this.#find(id);
      const courierId = d.entregador_id;
      const released = await this.transition(id, STATUS.PROCURANDO, { motivo: 'entregador_desistiu' });
      released.entregador_id = null;
      await this.store.saveDelivery(released);
      if (courierId) await this.#freeCourier(courierId);
      return this.get(id);
    });
  }

  pickup(id) {
    return this.#transaction(async () => {
      await this.transition(id, STATUS.COLETADA);
      return this.get(id);
    });
  }

  startRoute(id) {
    return this.#transaction(async () => {
      await this.transition(id, STATUS.EM_ROTA);
      return this.get(id);
    });
  }

  complete(id, { codigo, foto_url, recebedor }) {
    return this.#transaction(async () => {
      const d = await this.#find(id);
      if (d.status !== STATUS.EM_ROTA) {
        throw conflict('transicao_invalida', `Não é possível finalizar uma entrega "${d.status}"`);
      }
      if (codigo !== d.codigo_confirmacao) {
        throw unprocessable('codigo_invalido', 'Código de confirmação incorreto');
      }
      d.prova = { foto_url: foto_url ?? null, recebedor: recebedor ?? null, em: new Date().toISOString() };
      await this.store.saveDelivery(d);
      await this.transition(id, STATUS.ENTREGUE, { recebedor });
      if (d.entregador_id) await this.#freeCourier(d.entregador_id);
      return this.get(id);
    });
  }

  fail(id, motivo) {
    return this.#transaction(async () => {
      const d = await this.#find(id);
      d.motivo_falha = motivo;
      await this.store.saveDelivery(d);
      await this.transition(id, STATUS.FALHOU, { motivo });
      return this.get(id);
    });
  }

  startReturn(id) {
    return this.#transaction(async () => {
      await this.transition(id, STATUS.DEVOLVENDO);
      return this.get(id);
    });
  }

  completeReturn(id) {
    return this.#transaction(async () => {
      const d = await this.#find(id);
      await this.transition(id, STATUS.DEVOLVIDA);
      if (d.entregador_id) await this.#freeCourier(d.entregador_id);
      return this.get(id);
    });
  }

  // ---------- Entregadores ----------
  createCourier({ nome, telefone, veiculo, base_endereco }) {
    return this.#transaction(async () => {
      const point = base_endereco ? await this.geography.resolveLocation({ endereco: base_endereco }) : null;
      const c = {
        id: `edr_${randomUUID().slice(0, 8)}`,
        nome,
        telefone,
        veiculo,
        status: 'disponivel',
        endereco_base: base_endereco ?? null,
        posicao: point && { ...point, endereco: base_endereco, em: new Date().toISOString() },
      };
      return this.store.saveCourier(c);
    });
  }

  async listCouriers() {
    return this.store.listCouriers();
  }

  updateCourierPosition(id, location) {
    return this.#transaction(async () => {
      const c = await this.store.getCourier(id);
      if (!c) throw notFound('Entregador');
      const point = await this.geography.resolveLocation(location);
      c.posicao = {
        ...point,
        ...(location.endereco && { endereco: location.endereco }),
        ...(location.accuracy_m && { accuracy_m: location.accuracy_m }),
        em: new Date().toISOString(),
      };
      if (location.endereco) c.endereco_base = location.endereco;
      await this.store.saveCourier(c);
      return c;
    });
  }

  // ---------- Núcleo: toda mudança de status passa por aqui ----------
  transition(id, to, meta = {}) {
    return this.#transaction(async () => {
      const d = await this.#find(id);
      const from = d.status;
      assertTransition(from, to);
      d.status = to;
      d.atualizada_em = new Date().toISOString();
      await this.store.saveDelivery(d);
      await this.#record(d, from, to, meta);
      return d;
    });
  }

  async #record(d, de, para, meta = {}) {
    const evento = {
      id: `ev_${randomUUID().slice(0, 8)}`,
      entrega_id: d.id,
      de,
      para,
      em: new Date().toISOString(),
      meta,
    };
    await this.store.addEvent(evento);
    const emit = () => this.webhooks?.emit(WEBHOOK_EVENT[para], {
      entrega_id: d.id,
      pedido_externo_id: d.pedido_externo_id,
      status: para,
      final: FINAL_STATUSES.has(para),
      ...meta,
    });
    if (this.store.afterCommit) this.store.afterCommit(emit);
    else emit();
  }

  async #find(id, cliente) {
    const d = await this.store.getDelivery(id);
    if (!d || (cliente && d.cliente !== cliente)) throw notFound('Entrega');
    return d;
  }

  async #freeCourier(id) {
    const c = await this.store.getCourier(id);
    if (c) {
      c.status = 'disponivel';
      await this.store.saveCourier(c);
    }
  }

  async #dispatch(delivery) {
    if (delivery.forma_entrega === 'terceiro_express') return;
    const candidates = (await this.store.listCouriers())
      .filter((candidate) => candidate.status === 'disponivel' && candidate.posicao)
      .filter((candidate) => courierFitsVehicle(candidate.veiculo, delivery.veiculo));

    const ranked = await Promise.all(candidates.map(async (courier) => {
      const route = await this.geography.route(courier.posicao, delivery.coleta, courier.veiculo);
      return {
        courier,
        minutes: route.source === 'rota_viaria' ? route.durationMinutes : Number.POSITIVE_INFINITY,
      };
    }));
    const eligible = ranked
      .filter((candidate) => Number.isFinite(candidate.minutes))
      .sort((a, b) => a.minutes - b.minutes);

    for (const { courier } of eligible) {
      try {
        await this.assign(delivery.id, courier.id);
        return;
      } catch (error) {
        if (error.code !== 'entregador_indisponivel') throw error;
      }
    }
  }
}

// Moto só leva carga de moto; carro leva moto/carro; van leva tudo.
const RANK = { moto: 1, carro: 2, van: 3 };
const courierFitsVehicle = (courierVehicle, needed) => RANK[courierVehicle] >= RANK[needed];

function freshGpsPosition(position, config) {
  if (
    !position
    || !Number.isFinite(position.lat)
    || !Number.isFinite(position.lng)
    || !Number.isFinite(position.accuracy_m)
    || position.accuracy_m > config.gpsMaxAccuracyMeters
  ) return null;

  const ageMs = Date.now() - Date.parse(position.em);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > config.gpsPositionMaxAgeSeconds * 1000) return null;
  return { lat: position.lat, lng: position.lng };
}

function publicQuote(q) {
  return {
    cotacao_id: q.id,
    valor_centavos: q.valor_centavos,
    cobranca_externa: q.cobranca_externa,
    moeda: q.moeda,
    prazo_minutos: q.prazo_minutos,
    veiculo: q.veiculo,
    distancia_km: q.distancia_km,
    tempo_viagem_minutos: q.tempo_viagem_minutos,
    fonte_estimativa: q.fonte_estimativa,
    forma_entrega: q.forma_entrega,
    expira_em: q.expira_em,
  };
}

function publicDelivery(d) {
  // O código de confirmação vai para quem criou a entrega (sistema de vendas),
  // que o repassa ao cliente final. O app do entregador NÃO deve recebê-lo.
  const { cliente, ...rest } = d;
  return rest;
}
