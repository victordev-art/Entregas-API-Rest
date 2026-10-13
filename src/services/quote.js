import { randomUUID } from 'node:crypto';

const EARTH_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

// Dimensões são opcionais; sem informação adicional, a operação usa moto.
export function pickVehicle(itens) {
  const pesoTotal = itens.reduce((s, i) => s + (i.peso_kg ?? 0) * i.quantidade, 0);
  const maiorLado = Math.max(...itens.map((i) => i.maior_lado_cm ?? 0));
  if (pesoTotal > 80 || maiorLado > 180) return 'van';
  if (pesoTotal > 20 || maiorLado > 70) return 'carro';
  return 'moto';
}

export function calcQuote({ origem, destino, itens, modalidade, forma_entrega = 'propria', routeMetrics }, cfg) {
  if (
    routeMetrics?.source !== 'rota_viaria'
    || !Number.isFinite(routeMetrics.distanceKm)
    || !Number.isFinite(routeMetrics.durationMinutes)
  ) {
    throw new TypeError('A cotação exige uma rota viária calculada');
  }
  const p = cfg.pricing;
  const veiculo = pickVehicle(itens);
  const pesoTotal = itens.reduce((s, i) => s + (i.peso_kg ?? 0) * i.quantidade, 0);

  const distanciaKm = routeMetrics.distanceKm;
  const tempoViagemMinutos = routeMetrics.durationMinutes;
  const prazoMinutos = Math.ceil((forma_entrega === 'terceiro_express' ? 5 : p.prepMinutes) + tempoViagemMinutos)
    + (forma_entrega === 'terceiro_express' ? 0 : modalidade === 'urgente' ? 0 : 20);

  let cents = p.baseCents[veiculo] + distanciaKm * p.perKmCents[veiculo];
  cents += Math.max(0, pesoTotal - p.freeKg) * p.perKgCents;
  if (modalidade === 'urgente') cents *= p.urgentMultiplier;
  cents = Math.max(Math.round(cents), p.minCents[veiculo]);

  const agora = new Date();
  return {
    id: `cot_${randomUUID().slice(0, 8)}`,
    origem,
    destino,
    itens,
    modalidade,
    forma_entrega,
    veiculo,
    distancia_km: Number(distanciaKm.toFixed(2)),
    tempo_viagem_minutos: Math.ceil(tempoViagemMinutos),
    fonte_estimativa: routeMetrics.source,
    valor_centavos: forma_entrega === 'terceiro_express' ? null : cents,
    cobranca_externa: forma_entrega === 'terceiro_express',
    moeda: 'BRL',
    prazo_minutos: prazoMinutos,
    criada_em: agora.toISOString(),
    expira_em: new Date(agora.getTime() + cfg.quoteTtlMinutes * 60_000).toISOString(),
    usada: false,
  };
}
