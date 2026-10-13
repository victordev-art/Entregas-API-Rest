import { AppError } from '../errors.js';

const REGION_BIASES = {
  paranoa: { name: 'Paranoá', lat: -15.7795, lng: -47.7784, viewbox: '-47.84,-15.69,-47.70,-15.85' },
  itapoa: { name: 'Itapoã', lat: -15.7485, lng: -47.7697, viewbox: '-47.82,-15.68,-47.71,-15.82' },
};

export function createGeography(config, fetchFn = fetch) {
  const geocodeCache = new Map();
  const routeCache = new Map();
  let geocodeQueue = Promise.resolve();
  let lastGeocodeAt = 0;

  async function resolveLocation(location) {
    if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) {
      return { lat: location.lat, lng: location.lng };
    }

    const address = location.endereco?.trim();
    if (!address) throw new AppError(400, 'endereco_obrigatorio', 'Informe um endereço completo');
    const region = REGION_BIASES[location.regiao] ? location.regiao : null;
    const postalCode = location.cep?.trim();
    const cacheKey = `${region || ''}:${postalCode || ''}:${address.toLocaleLowerCase('pt-BR')}`;
    if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey);

    const request = geocodeQueue.then(async () => {
      let reachedProvider = false;
      for (const providerUrl of [config.geocodingUrl, config.geocodingFallbackUrl].filter(Boolean)) {
        for (const query of geocodingQueries(address, region, postalCode)) {
          const delay = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          lastGeocodeAt = Date.now();

          const url = new URL(providerUrl);
          url.searchParams.set('q', query);
          url.searchParams.set('limit', '5');
          url.searchParams.set('lang', 'pt');
          if (url.hostname === 'nominatim.openstreetmap.org') url.searchParams.set('format', 'geojson');
          if (region) {
            const bias = REGION_BIASES[region];
            url.searchParams.set('lat', String(bias.lat));
            url.searchParams.set('lon', String(bias.lng));
            if (url.hostname === 'nominatim.openstreetmap.org') url.searchParams.set('viewbox', bias.viewbox);
          }

          try {
            const response = await fetchFn(url, {
              headers: { accept: 'application/geo+json, application/json', 'user-agent': 'EntregasAPI/0.1 (address lookup)' },
              signal: AbortSignal.timeout(8000),
            });
            if (!response.ok) continue;
            reachedProvider = true;
            const result = await response.json();
            const feature = preferredFeature(result.features, region);
            const coordinates = feature?.geometry?.coordinates;
            if (!coordinates || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) continue;
            const point = { lat: coordinates[1], lng: coordinates[0] };
            geocodeCache.set(cacheKey, point);
            return point;
          } catch {
            // Continue to the normalized query or configured fallback provider.
          }
        }
      }

      if (reachedProvider) throw new AppError(422, 'endereco_nao_encontrado', `Endereço não localizado: ${address}`);
      throw new AppError(503, 'geocodificacao_indisponivel', 'Os serviços de localização estão indisponíveis; tente novamente');
    });
    geocodeQueue = request.catch(() => {});
    return request;
  }

  async function route(origin, destination, vehicle = 'moto', { includeGeometry = false } = {}) {
    const cacheKey = `${origin.lat},${origin.lng}:${destination.lat},${destination.lng}:${vehicle}:${includeGeometry}`;
    if (routeCache.has(cacheKey)) return routeCache.get(cacheKey);

    const route = vehicle === 'moto'
      ? await motorcycleRoute(origin, destination, includeGeometry)
      : await osrmRoute(origin, destination, includeGeometry);
    if (route.source === 'rota_viaria') routeCache.set(cacheKey, route);
    return route;
  }

  async function motorcycleRoute(origin, destination, includeGeometry) {
    try {
      const response = await fetchFn(config.motorcycleRoutingUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          locations: [
            { lat: origin.lat, lon: origin.lng, type: 'break' },
            { lat: destination.lat, lon: destination.lng, type: 'break' },
          ],
          costing: 'motor_scooter',
          units: 'kilometers',
          shape_format: 'polyline6',
          alternates: 2,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const result = await response.json();
        const candidates = [result.trip, ...(result.alternates || []).map((alternative) => alternative.trip)]
          .filter((trip) => Number.isFinite(trip?.summary?.length) && Number.isFinite(trip?.summary?.time))
          .sort((a, b) => a.summary.time - b.summary.time);
        const selected = candidates[0];
        const leg = selected?.legs?.[0];
        if (selected && (!includeGeometry || (leg?.shape && leg.shape.length > 0))) {
          return {
            distanceKm: selected.summary.length,
            durationMinutes: selected.summary.time / 60,
            source: 'rota_viaria',
            perfil: 'motor_scooter',
            ...(includeGeometry && { geometry: decodePolyline6(leg.shape) }),
          };
        }
      }
    } catch {
      // A ausência de rota não deve virar um atalho em linha reta.
    }

    return { distanceKm: null, durationMinutes: null, source: 'rota_indisponivel' };
  }

  async function osrmRoute(origin, destination, includeGeometry) {
    try {
      const overview = includeGeometry ? 'full' : 'false';
      const geometry = includeGeometry ? '&geometries=geojson' : '';
      const url = `${config.routingUrl}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=${overview}&alternatives=false&steps=false${geometry}`;
      const response = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const result = await response.json();
        const selected = result.routes?.[0];
        if (result.code === 'Ok' && selected && Number.isFinite(selected.distance) && Number.isFinite(selected.duration)) {
          return {
            distanceKm: selected.distance / 1000,
            durationMinutes: selected.duration / 60,
            source: 'rota_viaria',
            perfil: 'driving',
            ...(includeGeometry && selected.geometry?.coordinates && { geometry: selected.geometry.coordinates }),
          };
        }
      }
    } catch {
      // A ausência de rota não deve virar um atalho em linha reta.
    }

    return { distanceKm: null, durationMinutes: null, source: 'rota_indisponivel' };
  }

  return { resolveLocation, route };
}

function geocodingQueries(address, region, postalCode) {
  const normalized = address
    .replace(/\bQD\.?\s*/gi, 'Quadra ')
    .replace(/\bConj\.?\s*/gi, 'Conjunto ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*\d{5}-\d{3}$/, '')
    .replace(/\bDF\s*$/i, 'DF, Brasil');
  const regionName = region && REGION_BIASES[region].name;
  const withPostalCode = (query) => postalCode ? `${query}, CEP ${postalCode}` : query;
  const contextual = regionName ? `${normalized}, ${regionName}, Brasília, DF, Brasil` : normalized;
  return [...new Set([
    withPostalCode(address),
    withPostalCode(normalized),
    withPostalCode(contextual),
    contextual,
  ])];
}

function preferredFeature(features = [], region) {
  const valid = features.filter((feature) => {
    const coordinates = feature.geometry?.coordinates;
    return Number.isFinite(coordinates?.[0]) && Number.isFinite(coordinates?.[1]);
  });
  if (!valid.length || !region) return valid[0];

  const bias = REGION_BIASES[region];
  return valid.sort((a, b) => {
    const [aLng, aLat] = a.geometry.coordinates;
    const [bLng, bLat] = b.geometry.coordinates;
    const aDistance = (aLat - bias.lat) ** 2 + (aLng - bias.lng) ** 2;
    const bDistance = (bLat - bias.lat) ** 2 + (bLng - bias.lng) ** 2;
    return aDistance - bDistance;
  })[0];
}

function decodePolyline6(encoded) {
  const points = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    const latitudeDelta = decodePolylineValue(encoded, index);
    latitude += latitudeDelta.value;
    index = latitudeDelta.nextIndex;
    const longitudeDelta = decodePolylineValue(encoded, index);
    longitude += longitudeDelta.value;
    index = longitudeDelta.nextIndex;
    points.push([longitude / 1_000_000, latitude / 1_000_000]);
  }

  return points;
}

function decodePolylineValue(encoded, startIndex) {
  let value = 0;
  let shift = 0;
  let index = startIndex;
  let chunk;

  do {
    chunk = encoded.charCodeAt(index++) - 63;
    value |= (chunk & 0x1f) << shift;
    shift += 5;
  } while (chunk >= 0x20 && index < encoded.length);

  const delta = value & 1 ? ~(value >> 1) : value >> 1;
  return { value: delta, nextIndex: index };
}