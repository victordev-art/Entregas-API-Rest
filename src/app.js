import express from 'express';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { loadConfig } from './config.js';
import { MemoryStore } from './store/memory.js';
import { DeliveryService } from './services/deliveries.js';
import { createGeography } from './services/geography.js';
import { WebhookDispatcher } from './services/webhooks.js';
import { auth } from './middleware/auth.js';
import { idempotency } from './middleware/idempotency.js';
import { AppError } from './errors.js';
import {
  cotacaoSchema, criarEntregaSchema, cancelarSchema, atribuirSchema,
  finalizarSchema, falhaSchema, entregadorSchema, posicaoSchema, atribuirTerceiroSchema,
} from './schemas.js';

export function createApp({ config = loadConfig(), store = new MemoryStore(), webhooks, geography } = {}) {
  geography ??= createGeography(config);
  webhooks ??= new WebhookDispatcher({
    url: config.webhookUrl,
    secret: config.webhookSecret,
    retryDelaysMs: config.webhookRetryDelaysMs,
  });
  const service = new DeliveryService({ store, config, webhooks, geography });

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  const v1 = express.Router();
  v1.use(auth(config));
  v1.use(idempotency(store));

  const wrap = (fn) => (req, res, next) => {
    Promise.resolve().then(() => fn(req, res)).catch(next);
  };

  // ----- Cotação e entregas (usadas pelo sistema de vendas) -----
  v1.post('/entregas/cotacao', wrap(async (req, res) => {
    res.status(201).json(await service.createQuote(cotacaoSchema.parse(req.body)));
  }));

  v1.post('/entregas', wrap(async (req, res) => {
    const input = criarEntregaSchema.parse(req.body);
    res.status(201).json(await service.createDelivery({ cliente: req.cliente, input }));
  }));

  v1.get('/entregas', wrap(async (req, res) => {
    res.json({ data: await service.list({ cliente: req.cliente, status: req.query.status }) });
  }));

  v1.get('/planejamento', wrap(async (req, res) => {
    res.json(await service.planRoutes({ cliente: req.cliente }));
  }));

  v1.get('/entregas/:id', wrap(async (req, res) => {
    res.json(await service.get(req.params.id, req.cliente));
  }));

  v1.post('/entregas/:id/cancelar', wrap(async (req, res) => {
    const { motivo } = cancelarSchema.parse(req.body);
    await service.get(req.params.id, req.cliente); // garante que é dono
    res.json(await service.cancel(req.params.id, req.cliente, motivo));
  }));

  // ----- Operação (painel interno e app do entregador) -----
  // MVP: mesma API key. Em produção, separe com escopos/papéis (operador, entregador).
  v1.post('/entregas/:id/atribuir', wrap(async (req, res) => {
    const { entregador_id } = atribuirSchema.parse(req.body);
    res.json(await service.assign(req.params.id, entregador_id));
  }));
  v1.post('/entregas/:id/atribuir-terceiro', wrap(async (req, res) => {
    res.json(await service.assignExternal(req.params.id, atribuirTerceiroSchema.parse(req.body)));
  }));
  v1.post('/entregas/:id/liberar', wrap(async (req, res) => res.json(await service.release(req.params.id))));
  v1.post('/entregas/:id/coletar', wrap(async (req, res) => res.json(await service.pickup(req.params.id))));
  v1.post('/entregas/:id/iniciar-rota', wrap(async (req, res) => res.json(await service.startRoute(req.params.id))));
  v1.post('/entregas/:id/finalizar', wrap(async (req, res) => {
    res.json(await service.complete(req.params.id, finalizarSchema.parse(req.body)));
  }));
  v1.post('/entregas/:id/falha', wrap(async (req, res) => {
    res.json(await service.fail(req.params.id, falhaSchema.parse(req.body).motivo));
  }));
  v1.post('/entregas/:id/devolver', wrap(async (req, res) => res.json(await service.startReturn(req.params.id))));
  v1.post('/entregas/:id/devolucao-concluida', wrap(async (req, res) => res.json(await service.completeReturn(req.params.id))));

  v1.post('/entregadores', wrap(async (req, res) => {
    res.status(201).json(await service.createCourier(entregadorSchema.parse(req.body)));
  }));
  v1.get('/entregadores', wrap(async (_req, res) => res.json({ data: await service.listCouriers() })));
  v1.post('/entregadores/:id/posicao', wrap(async (req, res) => {
    res.json(await service.updateCourierPosition(req.params.id, posicaoSchema.parse(req.body)));
  }));

  app.use('/v1', v1);

  app.use((_req, _res, next) => next(new AppError(404, 'rota_nao_encontrada', 'Rota não encontrada')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        erro: { codigo: 'validacao', mensagem: 'Dados inválidos', detalhes: err.issues },
      });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({
        erro: { codigo: err.code, mensagem: err.message, detalhes: err.details },
      });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ erro: { codigo: 'json_invalido', mensagem: 'JSON inválido' } });
    }
    console.error(err);
    res.status(500).json({ erro: { codigo: 'erro_interno', mensagem: 'Erro interno' } });
  });

  app.locals.service = service;
  app.locals.webhooks = webhooks;
  app.locals.store = store;
  return app;
}
