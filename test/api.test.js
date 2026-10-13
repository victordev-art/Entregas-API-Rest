import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { haversineKm } from '../src/services/quote.js';
import { sign } from '../src/services/webhooks.js';
import { createGeography } from '../src/services/geography.js';
import { DeliveryService } from '../src/services/deliveries.js';
import { MemoryStore } from '../src/store/memory.js';
import { FileStore } from '../src/store/file.js';

let server, base, webhookCalls;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-key-123' };

const api = async (method, path, body, headers = H) => {
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), headers: res.headers };
};

const ORIGEM = { lat: -15.8, lng: -47.9 };
const DESTINO = { lat: -15.83, lng: -47.88 };
const itens = [{ descricao: 'Pastilha de freio', quantidade: 2, peso_kg: 1.2 }];

async function novaEntrega(extra = {}) {
  const cot = await api('POST', '/v1/entregas/cotacao', { origem: ORIGEM, destino: DESTINO, itens, ...extra });
  const ent = await api('POST', '/v1/entregas', {
    cotacao_id: cot.body.cotacao_id,
    pedido_externo_id: 'PED-1',
    coleta: { endereco: 'SIA Trecho 3', contato: { nome: 'Expedição', telefone: '61999990000' } },
    entrega: { endereco: 'QI 10 Lago Sul', contato: { nome: 'Oficina', telefone: '61988880000' } },
  });
  return { cot, ent };
}

before(async () => {
  webhookCalls = [];
  const fetchFn = async (url, init) => {
    webhookCalls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const config = loadConfig({ webhookUrl: 'http://cliente.test/hook', webhookSecret: 's3', apiKeys: new Map([['dev-key-123', 'vendas'], ['outra', 'outro']]) });
  const { WebhookDispatcher } = await import('../src/services/webhooks.js');
  const webhooks = new WebhookDispatcher({ url: config.webhookUrl, secret: config.webhookSecret, fetchFn });
  const geography = {
    resolveLocation: async (location) => location.endereco
      ? location.endereco.toLowerCase().includes('longe')
        ? { lat: -15.82, lng: -47.9 }
        : location.endereco.toLowerCase().includes('perto')
          ? { lat: -15.801, lng: -47.9 }
          : location.endereco.toLowerCase().includes('origem') ? ORIGEM : DESTINO
      : location,
    route: async (origin, destination, _vehicle, { includeGeometry = false } = {}) => {
      if (destination.lat === DESTINO.lat && destination.lng === DESTINO.lng) {
        return {
          distanceKm: 5.15,
          durationMinutes: 10.3,
          source: 'rota_viaria',
          ...(includeGeometry && { geometry: [[origin.lng, origin.lat], [destination.lng, destination.lat]] }),
        };
      }
      return { distanceKm: haversineKm(origin, destination), durationMinutes: haversineKm(origin, destination) * 2, source: 'rota_viaria' };
    },
  };
  const app = createApp({ config, webhooks, geography });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('serve o painel web na rota raiz', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const page = await res.text();
  assert.match(page, /Central de opera/);
  assert.match(page, /id="service-map"/);
  assert.match(page, /ORIGEM FIXA · DISPPAR AUTOPEÇAS/);
  assert.match(page, /VENDEDOR RESPONSÁVEL/);
  assert.match(page, /MOTOBOY RESPONSÁVEL/);
  assert.match(page, /ORIGEM FIXA · DISPPAR AUTOPEÇAS/);
  assert.match(page, /QD\. 34 Conj\. C Lote 25 - Paranoá, Brasília - DF, 71573-403/);
  assert.match(page, /name="destino_regiao"/);
  assert.match(page, /name="entrega_cep"/);
  assert.match(page, /id="destination-map"/);
  assert.match(page, /id="choose-destination-map"/);
  assert.match(page, /type="hidden" name="destino_lat"/);
  assert.match(page, /type="hidden" name="destino_lng"/);
  assert.match(page, /option value="itapoa">Itapoã/);
  assert.doesNotMatch(page, /name="entrega_cep"[^>]*maxlength/);
  assert.doesNotMatch(page, /name="origem_lat"|name="item_peso"|<label[^>]*>(LATITUDE|LONGITUDE)/);
});

test('exige autenticação', async () => {
  const r = await api('POST', '/v1/entregas/cotacao', {}, { 'content-type': 'application/json' });
  assert.equal(r.status, 401);
});

test('valida o corpo da cotação', async () => {
  const r = await api('POST', '/v1/entregas/cotacao', { origem: ORIGEM });
  assert.equal(r.status, 400);
  assert.equal(r.body.erro.codigo, 'validacao');
});

test('cotação: moto para peça pequena, urgente custa mais', async () => {
  const a = await api('POST', '/v1/entregas/cotacao', { origem: ORIGEM, destino: DESTINO, itens });
  const b = await api('POST', '/v1/entregas/cotacao', { origem: ORIGEM, destino: DESTINO, itens, modalidade: 'urgente' });
  assert.equal(a.status, 201);
  assert.equal(a.body.veiculo, 'moto');
  assert.ok(b.body.valor_centavos > a.body.valor_centavos);
});

test('cotação: peça grande exige carro', async () => {
  const r = await api('POST', '/v1/entregas/cotacao', {
    origem: ORIGEM, destino: DESTINO,
    itens: [{ descricao: 'Para-choque', quantidade: 1, peso_kg: 6, maior_lado_cm: 150 }],
  });
  assert.equal(r.body.veiculo, 'carro');
});

test('cotação aceita endereços sem latitude, longitude ou peso', async () => {
  const r = await api('POST', '/v1/entregas/cotacao', {
    origem: { endereco: 'Loja Origem, Brasília' },
    destino: { endereco: 'Oficina Destino, Brasília' },
    itens: [{ descricao: 'Peça automotiva', quantidade: 1 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.distancia_km, 5.15);
  assert.equal(r.body.fonte_estimativa, 'rota_viaria');
});

test('CEP opcional incompleto é ignorado e não invalida a cotação regional', async () => {
  const r = await api('POST', '/v1/entregas/cotacao', {
    origem: ORIGEM,
    destino: { endereco: 'Rua 1', regiao: 'itapoa', cep: '71572-41' },
    itens: [{ descricao: 'Peça de teste', quantidade: 1 }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.distancia_km, 5.15);
});

test('geocodificação usa fallback e não cria rota linear quando o roteador falha', async () => {
  const config = loadConfig();
  const requests = [];
  const geography = createGeography(config, async (url) => {
    requests.push(new URL(url).hostname);
    if (new URL(url).hostname === 'nominatim.openstreetmap.org') return { ok: false };
    if (new URL(url).hostname === 'photon.komoot.io') {
      return { ok: true, json: async () => ({ features: [{ geometry: { coordinates: [-47.9, -15.8] } }] }) };
    }
    throw new Error('serviço de rota indisponível');
  });
  const point = await geography.resolveLocation({ endereco: 'Endereço de teste, Brasília' });
  const route = await geography.route(point, { lat: -15.83, lng: -47.88 }, 'moto');
  assert.deepEqual(point, { lat: -15.8, lng: -47.9 });
  assert.ok(requests.includes('photon.komoot.io'));
  assert.equal(route.source, 'rota_indisponivel');
  assert.equal(route.geometry, undefined);
});

test('origem fixa da empresa geocodifica com abreviações normalizadas', async () => {
  const config = loadConfig({ geocodingFallbackUrl: '' });
  const queries = [];
  const geography = createGeography(config, async (url) => {
    const query = new URL(url).searchParams.get('q');
    queries.push(query);
    const found = query.startsWith('Quadra 34 Conjunto C Lote 25');
    return {
      ok: true,
      json: async () => ({
        features: found ? [{ geometry: { coordinates: [-47.7796898, -15.7594732] } }] : [],
      }),
    };
  });
  const point = await geography.resolveLocation({
    endereco: 'QD. 34 Conj. C Lote 25 - Paranoá, Brasília - DF, 71573-403',
  });
  assert.deepEqual(point, { lat: -15.7594732, lng: -47.7796898 });
  assert.equal(queries[1], 'Quadra 34 Conjunto C Lote 25, Paranoá, Brasília, DF, Brasil');
});

test('geocodificação contextualiza abreviações em Itapoã e escolhe o resultado próximo', async () => {
  const requests = [];
  const geography = createGeography(loadConfig(), async (url) => {
    const requestUrl = new URL(url);
    requests.push(requestUrl);
    const query = requestUrl.searchParams.get('q');
    const features = query.startsWith('Quadra 12 Conjunto B')
      ? [
        { geometry: { coordinates: [-47.7, -15.7] } },
        { geometry: { coordinates: [-47.7697, -15.7485] } },
      ]
      : [];
    return { ok: true, json: async () => ({ features }) };
  });
  const point = await geography.resolveLocation({ endereco: 'QD 12 Conj B, Rua 1', regiao: 'itapoa' });
  assert.deepEqual(point, { lat: -15.7485, lng: -47.7697 });
  assert.equal(requests[1].searchParams.get('lat'), '-15.7485');
  assert.match(requests[1].searchParams.get('q'), /Quadra 12 Conjunto B/);
});

test('CEP refina a busca e mantém tentativa regional como fallback', async () => {
  const queries = [];
  const geography = createGeography(loadConfig({ geocodingFallbackUrl: '' }), async (url) => {
    const query = new URL(url).searchParams.get('q');
    queries.push(query);
    const found = query.includes('Paranoá, Brasília, DF, Brasil') && !query.includes('CEP');
    return {
      ok: true,
      json: async () => ({ features: found ? [{ geometry: { coordinates: [-47.78, -15.78] } }] : [] }),
    };
  });
  const point = await geography.resolveLocation({
    endereco: 'Quadra 10, conjunto B', regiao: 'paranoa', cep: '71573-403',
  });
  assert.ok(queries[0].includes('CEP 71573-403'));
  assert.deepEqual(point, { lat: -15.78, lng: -47.78 });
});

test('geografia devolve a linha GeoJSON completa para o mapa', async () => {
  const geography = createGeography(loadConfig(), async () => ({
    ok: true,
    json: async () => ({
      code: 'Ok',
      routes: [{ distance: 12500, duration: 900, geometry: { coordinates: [[-47.9, -15.8], [-47.88, -15.83]] } }],
    }),
  }));
  const route = await geography.route(ORIGEM, DESTINO, 'carro', { includeGeometry: true });
  assert.equal(route.source, 'rota_viaria');
  assert.deepEqual(route.geometry, [[-47.9, -15.8], [-47.88, -15.83]]);
  assert.equal(route.distanceKm, 12.5);
});

test('motoboy usa perfil scooter e escolhe a alternativa viária mais rápida', async () => {
  let requestBody;
  const geography = createGeography(loadConfig(), async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        trip: { summary: { length: 24.245, time: 2738 }, legs: [{ shape: '??' }] },
        alternates: [{ trip: { summary: { length: 22.817, time: 2506.8 }, legs: [{ shape: '??AA' }] } }],
      }),
    };
  });
  const route = await geography.route(ORIGEM, DESTINO, 'moto', { includeGeometry: true });
  assert.equal(requestBody.costing, 'motor_scooter');
  assert.equal(route.perfil, 'motor_scooter');
  assert.equal(route.distanceKm, 22.817);
  assert.equal(route.durationMinutes, 2506.8 / 60);
  assert.deepEqual(route.geometry, [[0, 0], [0.000001, 0.000001]]);
});

test('cotação não calcula preço ou ETA se não houver rota por ruas', async () => {
  const store = new MemoryStore();
  const service = new DeliveryService({
    store,
    config: loadConfig(),
    webhooks: { emit() {} },
    geography: {
      resolveLocation: async (location) => location,
      route: async () => ({ source: 'rota_indisponivel', distanceKm: null, durationMinutes: null }),
    },
  });
  await assert.rejects(
    service.createQuote({ origem: ORIGEM, destino: DESTINO, itens }),
    (error) => error.status === 503 && error.code === 'rota_indisponivel',
  );
  assert.equal(store.cotacoes.size, 0);
});

test('planejamento omite a linha do mapa quando não recebe geometria viária', async () => {
  const store = new MemoryStore();
  store.saveDelivery({
    id: 'ent_sem_rota',
    cliente: 'sistema-vendas',
    pedido_externo_id: 'PED-SEM-ROTA',
    status: 'em_rota',
    coleta: ORIGEM,
    entrega: DESTINO,
    veiculo: 'moto',
    distancia_km: 5,
  });
  const service = new DeliveryService({
    store,
    config: loadConfig(),
    webhooks: { emit() {} },
    geography: { route: async () => ({ source: 'rota_indisponivel', distanceKm: null, durationMinutes: null }) },
  });
  const planning = await service.planRoutes({ cliente: 'sistema-vendas' });
  assert.equal(planning.data[0].geometry, null);
  assert.equal(planning.data[0].fonte_estimativa, 'rota_indisponivel');
});

test('GPS recente do motoboy recalcula a rota restante e o ETA', async () => {
  const store = new MemoryStore();
  const gps = { lat: -15.82, lng: -47.9, accuracy_m: 18, em: new Date().toISOString() };
  store.saveCourier({ id: 'edr_gps', nome: 'Ana', status: 'em_entrega', posicao: gps });
  store.saveDelivery({
    id: 'ent_gps',
    cliente: 'sistema-vendas',
    pedido_externo_id: 'PED-GPS',
    status: 'em_rota',
    entregador_id: 'edr_gps',
    coleta: ORIGEM,
    entrega: DESTINO,
    veiculo: 'moto',
    distancia_km: 6,
  });
  let routeOrigin;
  const service = new DeliveryService({
    store,
    config: loadConfig(),
    webhooks: { emit() {} },
    geography: {
      route: async (origin, destination) => {
        routeOrigin = origin;
        return {
          source: 'rota_viaria',
          distanceKm: 3.2,
          durationMinutes: 8.1,
          geometry: [[origin.lng, origin.lat], [destination.lng, destination.lat]],
        };
      },
    },
  });

  const planning = await service.planRoutes({ cliente: 'sistema-vendas' });
  assert.deepEqual(routeOrigin, { lat: gps.lat, lng: gps.lng });
  assert.equal(planning.data[0].distancia_km, 3.2);
  assert.equal(planning.data[0].tempo_restante_minutos, 9);
  assert.deepEqual(planning.data[0].geometry[0], [gps.lng, gps.lat]);
});

test('terceiro express registra o responsável e o custo fora da cobrança da API', async () => {
  const quote = await api('POST', '/v1/entregas/cotacao', {
    origem: ORIGEM, destino: DESTINO, itens, forma_entrega: 'terceiro_express',
  });
  assert.equal(quote.body.cobranca_externa, true);
  assert.equal(quote.body.valor_centavos, null);
  const delivery = await api('POST', '/v1/entregas', {
    cotacao_id: quote.body.cotacao_id,
    pedido_externo_id: 'PED-TERCEIRO',
    coleta: { endereco: 'SIA Trecho 3', contato: { nome: 'Expedição', telefone: '61999990000' } },
    entrega: { endereco: 'QI 10 Lago Sul', contato: { nome: 'Oficina', telefone: '61988880000' } },
  });
  const assigned = await api('POST', `/v1/entregas/${delivery.body.id}/atribuir-terceiro`, {
    nome: 'Entrega Expressa', telefone: '61977770000', custo_centavos: 2500,
  });
  assert.equal(assigned.body.status, 'entregador_atribuido');
  assert.equal(assigned.body.entregador.tipo, 'terceiro');
  assert.equal(assigned.body.entregador.custo_centavos, 2500);
  assert.equal(assigned.body.valor_centavos, null);
});

test('pedido guarda o vendedor e permite escolher o motoboy na criação', async () => {
  const courier = await api('POST', '/v1/entregadores', {
    nome: 'Marina', telefone: '61977770000', veiculo: 'moto', base_endereco: 'Base Origem, Brasília',
  });
  const quote = await api('POST', '/v1/entregas/cotacao', {
    origem: ORIGEM, destino: DESTINO, itens,
  });
  const delivery = await api('POST', '/v1/entregas', {
    cotacao_id: quote.body.cotacao_id,
    pedido_externo_id: 'PED-VENDEDOR',
    vendedor_nome: 'Carla Souza',
    entregador_id: courier.body.id,
    coleta: { endereco: 'SIA Trecho 3', contato: { nome: 'Expedição', telefone: '61999990000' } },
    entrega: { endereco: 'QI 10 Lago Sul', contato: { nome: 'Oficina', telefone: '61988880000' } },
  });
  assert.equal(delivery.status, 201);
  assert.equal(delivery.body.vendedor_nome, 'Carla Souza');
  assert.equal(delivery.body.status, 'entregador_atribuido');
  assert.equal(delivery.body.entregador.id, courier.body.id);
});

test('FileStore mantém pedidos, entregadores e identificadores ao reiniciar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entregas-api-'));
  const filePath = join(directory, 'entregas.json');
  try {
    const firstStore = new FileStore({ filePath });
    await firstStore.saveCourier({ id: 'edr_teste', nome: 'Ana', telefone: '61999990000', veiculo: 'moto', status: 'disponivel' });
    await firstStore.saveDelivery({ id: 'ent_teste', pedido_externo_id: 'PED-100', status: 'procurando_entregador' });
    const reloadedStore = new FileStore({ filePath });
    assert.equal((await reloadedStore.listCouriers())[0].nome, 'Ana');
    assert.equal((await reloadedStore.listDeliveries({}))[0].pedido_externo_id, 'PED-100');
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).entregas.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('fluxo completo: criar → atribuir → coletar → rota → finalizar com código', async () => {
  const mot = await api('POST', '/v1/entregadores', { nome: 'Ana', telefone: '61977770000', veiculo: 'moto' });
  const { ent } = await novaEntrega();
  assert.equal(ent.status, 201);
  assert.equal(ent.body.status, 'procurando_entregador');
  const id = ent.body.id;

  assert.equal((await api('POST', `/v1/entregas/${id}/atribuir`, { entregador_id: mot.body.id })).body.status, 'entregador_atribuido');
  assert.equal((await api('POST', `/v1/entregas/${id}/coletar`)).body.status, 'coletada');
  assert.equal((await api('POST', `/v1/entregas/${id}/iniciar-rota`)).body.status, 'em_rota');

  const errado = await api('POST', `/v1/entregas/${id}/finalizar`, { codigo: ent.body.codigo_confirmacao === '0000' ? '1111' : '0000' });
  assert.equal(errado.status, 422);

  const ok = await api('POST', `/v1/entregas/${id}/finalizar`, { codigo: ent.body.codigo_confirmacao, recebedor: 'João' });
  assert.equal(ok.body.status, 'entregue');
  assert.equal(ok.body.prova.recebedor, 'João');
  assert.deepEqual(ok.body.eventos.map((e) => e.status), [
    'criada', 'procurando_entregador', 'entregador_atribuido', 'coletada', 'em_rota', 'entregue',
  ]);

  // entregador volta a ficar disponível
  const lista = await api('GET', '/v1/entregadores');
  assert.equal(lista.body.data.find((c) => c.id === mot.body.id).status, 'disponivel');
});

test('despacho automático escolhe o entregador compatível mais próximo da coleta', async () => {
  const distante = await api('POST', '/v1/entregadores', { nome: 'Lia', telefone: '61944440000', veiculo: 'moto', base_endereco: 'Base longe, Brasília' });
  const proximo = await api('POST', '/v1/entregadores', { nome: 'Nina', telefone: '61933330000', veiculo: 'moto', base_endereco: 'Base perto, Brasília' });

  const { ent } = await novaEntrega();
  assert.equal(ent.body.status, 'entregador_atribuido');
  assert.equal(ent.body.entregador.id, proximo.body.id);
});

test('planejamento retorna as rotas ativas com geometria para o mapa', async () => {
  const { ent } = await novaEntrega();
  const planning = await api('GET', '/v1/planejamento');
  const route = planning.body.data.find((item) => item.id === ent.body.id);
  assert.equal(planning.status, 200);
  assert.equal(route.pedido_externo_id, 'PED-1');
  assert.deepEqual(route.geometry, [
    [ORIGEM.lng, ORIGEM.lat],
    [DESTINO.lng, DESTINO.lat],
  ]);
  assert.equal(route.fonte_estimativa, 'rota_viaria');
});

test('transição inválida retorna 409', async () => {
  const { ent } = await novaEntrega();
  const r = await api('POST', `/v1/entregas/${ent.body.id}/iniciar-rota`);
  assert.equal(r.status, 409);
  assert.equal(r.body.erro.codigo, 'transicao_invalida');
});

test('moto não pode levar carga que exige carro', async () => {
  const mot = await api('POST', '/v1/entregadores', { nome: 'Beto', telefone: '61966660000', veiculo: 'moto' });
  const { ent } = await novaEntrega({ itens: [{ descricao: 'Escapamento', quantidade: 1, peso_kg: 25 }] });
  const r = await api('POST', `/v1/entregas/${ent.body.id}/atribuir`, { entregador_id: mot.body.id });
  assert.equal(r.status, 422);
  assert.equal(r.body.erro.codigo, 'veiculo_incompativel');
});

test('cancelar antes da coleta funciona; depois da coleta, não', async () => {
  const a = await novaEntrega();
  assert.equal((await api('POST', `/v1/entregas/${a.ent.body.id}/cancelar`, { motivo: 'cliente desistiu' })).body.status, 'cancelada');

  const mot = await api('POST', '/v1/entregadores', { nome: 'Caio', telefone: '61955550000', veiculo: 'moto' });
  const b = await novaEntrega();
  await api('POST', `/v1/entregas/${b.ent.body.id}/atribuir`, { entregador_id: mot.body.id });
  await api('POST', `/v1/entregas/${b.ent.body.id}/coletar`);
  assert.equal((await api('POST', `/v1/entregas/${b.ent.body.id}/cancelar`)).status, 409);
});

test('cotação só pode ser usada uma vez', async () => {
  const { cot } = await novaEntrega();
  const r = await api('POST', '/v1/entregas', {
    cotacao_id: cot.body.cotacao_id, pedido_externo_id: 'PED-2',
    coleta: { endereco: 'x x x', contato: { nome: 'a', telefone: '12345678' } },
    entrega: { endereco: 'y y y', contato: { nome: 'b', telefone: '12345678' } },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.erro.codigo, 'cotacao_usada');
});

test('Idempotency-Key evita entrega duplicada', async () => {
  const cot = await api('POST', '/v1/entregas/cotacao', { origem: ORIGEM, destino: DESTINO, itens });
  const corpo = {
    cotacao_id: cot.body.cotacao_id, pedido_externo_id: 'PED-IDEM',
    coleta: { endereco: 'SIA', contato: { nome: 'a', telefone: '12345678' } },
    entrega: { endereco: 'Lago Sul', contato: { nome: 'b', telefone: '12345678' } },
  };
  const h = { ...H, 'idempotency-key': 'k-1' };
  const r1 = await api('POST', '/v1/entregas', corpo, h);
  const r2 = await api('POST', '/v1/entregas', corpo, h);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(r2.headers.get('idempotent-replayed'), 'true');
  assert.equal(r1.body.id, r2.body.id);
});

test('um cliente não enxerga entregas de outro', async () => {
  const { ent } = await novaEntrega();
  const r = await api('GET', `/v1/entregas/${ent.body.id}`, undefined, { authorization: 'Bearer outra' });
  assert.equal(r.status, 404);
});

test('webhooks são enviados com assinatura HMAC válida', async () => {
  const { ent } = await novaEntrega();
  const call = webhookCalls.findLast((c) => JSON.parse(c.init.body).data.entrega_id === ent.body.id);
  assert.ok(call, 'webhook enviado');
  const esperado = `sha256=${sign('s3', call.init.body)}`;
  assert.equal(call.init.headers['x-signature'], esperado);
});

test('atualização de posição persiste a precisão fornecida pelo GPS', async () => {
  const courier = await api('POST', '/v1/entregadores', {
    nome: 'GPS Teste', telefone: '61977770001', veiculo: 'moto',
  });
  const update = await api('POST', `/v1/entregadores/${courier.body.id}/posicao`, {
    lat: -15.82, lng: -47.9, accuracy_m: 12,
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.posicao.accuracy_m, 12);
});
