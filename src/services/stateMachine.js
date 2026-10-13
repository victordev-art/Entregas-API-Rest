import { conflict } from '../errors.js';

export const STATUS = {
  CRIADA: 'criada',
  PROCURANDO: 'procurando_entregador',
  ATRIBUIDA: 'entregador_atribuido',
  COLETADA: 'coletada',
  EM_ROTA: 'em_rota',
  ENTREGUE: 'entregue',
  FALHOU: 'falhou',
  DEVOLVENDO: 'devolvendo',
  DEVOLVIDA: 'devolvida',
  CANCELADA: 'cancelada',
};

// Transições permitidas: de -> [para...]
const TRANSITIONS = {
  [STATUS.CRIADA]: [STATUS.PROCURANDO, STATUS.CANCELADA],
  [STATUS.PROCURANDO]: [STATUS.ATRIBUIDA, STATUS.CANCELADA],
  // entregador recusou/desistiu antes da coleta -> volta a procurar
  [STATUS.ATRIBUIDA]: [STATUS.COLETADA, STATUS.PROCURANDO, STATUS.CANCELADA],
  [STATUS.COLETADA]: [STATUS.EM_ROTA, STATUS.FALHOU],
  [STATUS.EM_ROTA]: [STATUS.ENTREGUE, STATUS.FALHOU],
  [STATUS.FALHOU]: [STATUS.DEVOLVENDO],
  [STATUS.DEVOLVENDO]: [STATUS.DEVOLVIDA],
  [STATUS.ENTREGUE]: [],
  [STATUS.DEVOLVIDA]: [],
  [STATUS.CANCELADA]: [],
};

export const FINAL_STATUSES = new Set([STATUS.ENTREGUE, STATUS.DEVOLVIDA, STATUS.CANCELADA]);

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw conflict('transicao_invalida', `Não é possível ir de "${from}" para "${to}"`);
  }
}

// Status -> nome do evento de webhook
export const WEBHOOK_EVENT = {
  [STATUS.CRIADA]: 'entrega.criada',
  [STATUS.PROCURANDO]: 'entrega.procurando_entregador',
  [STATUS.ATRIBUIDA]: 'entrega.entregador_atribuido',
  [STATUS.COLETADA]: 'entrega.coletada',
  [STATUS.EM_ROTA]: 'entrega.em_rota',
  [STATUS.ENTREGUE]: 'entrega.entregue',
  [STATUS.FALHOU]: 'entrega.falhou',
  [STATUS.DEVOLVENDO]: 'entrega.devolvendo',
  [STATUS.DEVOLVIDA]: 'entrega.devolvida',
  [STATUS.CANCELADA]: 'entrega.cancelada',
};
