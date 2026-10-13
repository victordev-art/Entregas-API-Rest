// Configuração central. Tudo pode ser sobrescrito por variáveis de ambiente.
export function loadConfig(overrides = {}) {
  const env = process.env;
  return {
    port: Number(env.PORT || 3000),
    databaseUrl: env.DATABASE_URL || '',
    dataFile: env.DATA_FILE || 'data/entregas.json',
    geocodingUrl: env.GEOCODING_URL || 'https://nominatim.openstreetmap.org/search',
    geocodingFallbackUrl: env.GEOCODING_FALLBACK_URL || 'https://photon.komoot.io/api/',
    routingUrl: env.ROUTING_URL || 'https://router.project-osrm.org/route/v1/driving',
    motorcycleRoutingUrl: env.MOTORCYCLE_ROUTING_URL || 'https://valhalla1.openstreetmap.de/route',
    gpsPositionMaxAgeSeconds: Number(env.GPS_POSITION_MAX_AGE_SECONDS || 600),
    gpsMaxAccuracyMeters: Number(env.GPS_MAX_ACCURACY_METERS || 300),

    // Clientes autorizados: "chave1:Loja Centro,chave2:Sistema de Vendas"
    apiKeys: parseApiKeys(env.API_KEYS || 'dev-key-123:sistema-vendas'),

    // Webhook (MVP: um único destino; depois vira tabela por cliente)
    webhookUrl: env.WEBHOOK_URL || '',
    webhookSecret: env.WEBHOOK_SECRET || 'troque-este-segredo',
    webhookRetryDelaysMs: [60_000, 300_000, 1_800_000], // 1min, 5min, 30min

    // Cotação
    quoteTtlMinutes: 15,
    pricing: {
      baseCents: { moto: 800, carro: 1500, van: 3000 },
      perKmCents: { moto: 180, carro: 300, van: 520 },
      perKgCents: 20, // acima de 5 kg
      freeKg: 5,
      urgentMultiplier: 1.5,
      minCents: { moto: 1000, carro: 2000, van: 4000 },
      prepMinutes: 10,
    },

    // Despacho
    acceptTimeoutSeconds: 60,

    ...overrides,
  };
}

function parseApiKeys(raw) {
  const map = new Map();
  for (const pair of raw.split(',')) {
    const [key, name] = pair.split(':');
    if (key) map.set(key.trim(), (name || 'cliente').trim());
  }
  return map;
}
