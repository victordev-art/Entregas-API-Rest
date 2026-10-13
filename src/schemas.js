import { z } from 'zod';

const ponto = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
const regiaoAtendida = z.enum(['paranoa', 'itapoa']);
const cepOpcional = z.string().optional().transform((value) => {
  const digits = (value || '').replace(/\D/g, '');
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : undefined;
});
const localizacaoPorEndereco = z.object({
  endereco: z.string().min(3),
  regiao: regiaoAtendida.optional(),
  cep: cepOpcional,
});
const localizacao = z.union([ponto, localizacaoPorEndereco]);

const item = z.object({
  descricao: z.string().min(1),
  quantidade: z.number().int().positive(),
  peso_kg: z.number().positive().optional(),
  maior_lado_cm: z.number().positive().optional(),
});

const contato = z.object({
  nome: z.string().min(1),
  telefone: z.string().min(8),
});

const enderecoCtx = z.object({
  endereco: z.string().min(3),
  contato: contato,
  observacoes: z.string().optional(),
});

export const cotacaoSchema = z.object({
  origem: localizacao,
  destino: localizacao,
  itens: z.array(item).min(1),
  modalidade: z.enum(['padrao', 'urgente']).default('padrao'),
  forma_entrega: z.enum(['propria', 'terceiro_express']).default('propria'),
});

export const criarEntregaSchema = z.object({
  cotacao_id: z.string().min(1),
  pedido_externo_id: z.string().min(1),
  vendedor_nome: z.string().trim().min(1).optional(),
  entregador_id: z.string().min(1).optional(),
  coleta: enderecoCtx,
  entrega: enderecoCtx,
});

export const cancelarSchema = z.object({ motivo: z.string().optional() }).default({});

export const atribuirSchema = z.object({ entregador_id: z.string().min(1) });
export const atribuirTerceiroSchema = z.object({
  nome: z.string().min(1),
  telefone: z.string().min(8),
  custo_centavos: z.number().int().nonnegative().optional(),
});

export const finalizarSchema = z.object({
  codigo: z.string().length(4),
  foto_url: z.string().url().optional(),
  recebedor: z.string().optional(),
});

export const falhaSchema = z.object({ motivo: z.string().min(1) });

export const entregadorSchema = z.object({
  nome: z.string().min(1),
  telefone: z.string().min(8),
  veiculo: z.enum(['moto', 'carro', 'van']),
  base_endereco: z.string().min(3).optional(),
});

export const posicaoSchema = z.union([
  ponto.extend({ accuracy_m: z.number().positive().optional() }),
  z.object({ endereco: z.string().min(3) }),
]);
