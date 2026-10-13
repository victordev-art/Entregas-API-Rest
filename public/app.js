const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const STATUS_LABELS = {
  criada: 'Criada',
  procurando_entregador: 'Aguardando entregador',
  entregador_atribuido: 'Entregador atribuído',
  coletada: 'Coletada',
  em_rota: 'Em rota',
  entregue: 'Entregue',
  falhou: 'Falhou',
  devolvendo: 'Devolvendo',
  devolvida: 'Devolvida',
  cancelada: 'Cancelada',
};
const VEHICLE_LABELS = { moto: 'Moto', carro: 'Carro', van: 'Van' };
const REGION_MAP_CENTERS = { paranoa: [-15.7795, -47.7784], itapoa: [-15.7485, -47.7697] };
const ACTIVE_STATUSES = new Set(['criada', 'procurando_entregador', 'entregador_atribuido', 'coletada', 'em_rota', 'falhou', 'devolvendo']);
let deliveries = [];
let couriers = [];
let routePlanning = { data: [], motoboys: [] };
let currentQuote = null;
let selectedDelivery = null;
let activeView = 'dashboard';
let operationsMap = null;
let routeLayer = null;
let courierLayer = null;
let destinationPickerMap = null;
let destinationPinMarker = null;
let pendingDestinationPin = null;
let quoteDebounceTimer = null;
let quoteRevision = 0;

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function money(cents) {
  if (cents == null) return 'Pagamento externo';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function dateTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function shortId(value) {
  return escapeHTML(value || '—');
}

function statusClass(status) {
  if (['procurando_entregador', 'falhou', 'devolvendo'].includes(status)) return 'status-pending';
  if (status === 'em_rota' || status === 'coletada') return 'status-route';
  if (status === 'cancelada') return 'status-canceled';
  return '';
}

function statusPill(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHTML(STATUS_LABELS[status] || status)}</span>`;
}

async function api(path, options = {}) {
  const headers = { Authorization: `Bearer ${$('#api-key').value.trim()}`, ...options.headers };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.erro?.mensagem || `Erro HTTP ${response.status}`);
    error.code = result.erro?.codigo;
    throw error;
  }
  return result;
}

function notify(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' is-error' : ''}`;
  toast.textContent = message;
  $('#toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 4300);
}

function setConnection(online) {
  const label = $('#connection-label');
  label.textContent = online ? 'API conectada' : 'API indisponível';
  label.closest('.connection-status').classList.toggle('is-offline', !online);
}

function renderDeliveries(target, items, compact = false) {
  if (!items.length) {
    target.innerHTML = `<div class="empty-state">${compact ? 'Nenhuma entrega ainda. Crie uma cotação para começar.' : 'Nenhuma entrega corresponde a esses filtros.'}</div>`;
    return;
  }
  const planned = [...items].sort((a, b) => new Date(a.previsao_entrega_em || a.criada_em) - new Date(b.previsao_entrega_em || b.criada_em));
  target.innerHTML = `<table><thead><tr><th>PEDIDO / ID</th><th>VENDEDOR</th><th>DESTINO</th><th>STATUS</th><th>ROTA / PREVISÃO</th><th></th></tr></thead><tbody>${planned.map((delivery) => `<tr>
    <td><span class="cell-primary">${escapeHTML(delivery.pedido_externo_id)}</span><span class="cell-secondary">${shortId(delivery.id)}</span></td>
    <td>${escapeHTML(delivery.vendedor_nome || '—')}</td>
    <td><span class="cell-primary">${escapeHTML(delivery.entrega?.endereco || 'Endereço não informado')}</span><span class="cell-secondary">${dateTime(delivery.criada_em)}</span></td>
    <td>${statusPill(delivery.status)}</td><td><span class="cell-primary">${Number(delivery.distancia_km || 0).toFixed(1)} km · ${delivery.prazo_minutos || '—'} min</span><span class="cell-secondary">Chegada ${dateTime(delivery.previsao_entrega_em)}</span></td>
    <td><button class="row-action" type="button" data-open-delivery="${shortId(delivery.id)}">Detalhes →</button></td></tr>`).join('')}</tbody></table>`;
}

function filteredDeliveries() {
  const query = ($('#delivery-search')?.value || '').trim().toLocaleLowerCase('pt-BR');
  const status = $('#delivery-filter')?.value || '';
  return deliveries.filter((delivery) => {
    const matchesStatus = !status || delivery.status === status;
    const searchText = `${delivery.pedido_externo_id} ${delivery.vendedor_nome || ''} ${delivery.id} ${delivery.coleta?.endereco} ${delivery.entrega?.endereco}`.toLocaleLowerCase('pt-BR');
    return matchesStatus && (!query || searchText.includes(query));
  });
}

function renderCourierList() {
  const target = $('#courier-list');
  $('#courier-total').textContent = `${couriers.length} ${couriers.length === 1 ? 'entregador' : 'entregadores'}`;
  $('#metric-couriers').textContent = couriers.length;
  const available = couriers.filter((courier) => courier.status === 'disponivel').length;
  $('#metric-courier-note').textContent = `${available} dispon${available === 1 ? 'ível' : 'íveis'} agora`;
  const select = $('#position-courier');
  const currentSelection = select.value;
  select.innerHTML = `<option value="">Selecione</option>${couriers.map((courier) => `<option value="${shortId(courier.id)}">${escapeHTML(courier.nome)} · ${VEHICLE_LABELS[courier.veiculo] || escapeHTML(courier.veiculo)}</option>`).join('')}`;
  if (couriers.some((courier) => courier.id === currentSelection)) select.value = currentSelection;
  const deliverySelect = $('#selected-courier');
  const selectedCourier = deliverySelect.value;
  const availableCouriers = couriers.filter((courier) => courier.status === 'disponivel');
  deliverySelect.innerHTML = `<option value="">Despacho automático · menor tempo estimado</option>${availableCouriers.map((courier) => `<option value="${shortId(courier.id)}">${escapeHTML(courier.nome)} · ${VEHICLE_LABELS[courier.veiculo] || escapeHTML(courier.veiculo)}</option>`).join('')}`;
  if (availableCouriers.some((courier) => courier.id === selectedCourier)) deliverySelect.value = selectedCourier;
  if (!couriers.length) {
    target.innerHTML = '<div class="empty-state">Nenhum entregador cadastrado. Use o formulário ao lado para adicionar a equipe.</div>';
    return;
  }
  target.innerHTML = `<table><thead><tr><th>ENTREGADOR</th><th>VEÍCULO</th><th>DISPONIBILIDADE</th><th>POSIÇÃO</th></tr></thead><tbody>${couriers.map((courier) => `<tr>
    <td><div class="courier-cell"><span class="courier-avatar">${escapeHTML(courier.nome.slice(0, 1).toLocaleUpperCase('pt-BR'))}</span><span><span class="cell-primary">${escapeHTML(courier.nome)}</span><span class="cell-secondary">${escapeHTML(courier.telefone)}</span></span></div></td>
    <td>${VEHICLE_LABELS[courier.veiculo] || escapeHTML(courier.veiculo)}</td><td>${statusPill(courier.status === 'disponivel' ? 'entregue' : 'em_rota').replace(STATUS_LABELS.entregue, 'Disponível').replace(STATUS_LABELS.em_rota, 'Em entrega')}</td>
    <td>${courier.posicao ? `<span class="cell-primary">${escapeHTML(courier.posicao.endereco || courier.endereco_base || 'Localização informada')}</span><span class="cell-secondary">${dateTime(courier.posicao.em)}</span>` : '<span class="cell-secondary">Endereço-base não informado</span>'}</td></tr>`).join('')}</tbody></table>`;
}

function initializeOperationsMap() {
  if (operationsMap) return true;
  if (!globalThis.L) {
    $('#map-empty').textContent = 'Biblioteca do mapa indisponível';
    return false;
  }
  operationsMap = L.map('service-map', { scrollWheelZoom: false, zoomControl: false }).setView([-15.8, -47.9], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(operationsMap);
  L.control.zoom({ position: 'bottomright' }).addTo(operationsMap);
  routeLayer = L.layerGroup().addTo(operationsMap);
  courierLayer = L.layerGroup().addTo(operationsMap);
  return true;
}

function placeDestinationPin(latlng) {
  pendingDestinationPin = { lat: latlng.lat, lng: latlng.lng };
  if (destinationPinMarker) destinationPinMarker.remove();
  destinationPinMarker = L.marker(latlng).addTo(destinationPickerMap);
  $('#destination-map-message').textContent = 'Ponto escolhido. Confirme para calcular a rota.';
  $('#confirm-destination-pin').disabled = false;
}

function openDestinationPicker() {
  if (!globalThis.L) {
    notify('O mapa não carregou. Atualize a página e tente novamente.', true);
    return;
  }
  const region = $('#quote-form [name="destino_regiao"]').value;
  const center = REGION_MAP_CENTERS[region] || REGION_MAP_CENTERS.paranoa;
  if (!destinationPickerMap) {
    destinationPickerMap = L.map('destination-map').setView(center, 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(destinationPickerMap);
    destinationPickerMap.on('click', (event) => placeDestinationPin(event.latlng));
  } else {
    destinationPickerMap.setView(center, 14);
  }

  const latitude = Number($('#quote-form [name="destino_lat"]').value);
  const longitude = Number($('#quote-form [name="destino_lng"]').value);
  if (Number.isFinite(latitude) && Number.isFinite(longitude) && (latitude || longitude)) {
    placeDestinationPin({ lat: latitude, lng: longitude });
  } else {
    pendingDestinationPin = null;
    if (destinationPinMarker) destinationPinMarker.remove();
    destinationPinMarker = null;
    $('#destination-map-message').textContent = 'Clique no ponto exato de entrega.';
    $('#confirm-destination-pin').disabled = true;
  }

  $('#destination-map-dialog').showModal();
  window.setTimeout(() => destinationPickerMap.invalidateSize(), 0);
}

function clearDestinationPin() {
  $('#quote-form [name="destino_lat"]').value = '';
  $('#quote-form [name="destino_lng"]').value = '';
  $('#destination-pin-status').textContent = '';
  pendingDestinationPin = null;
  if (destinationPinMarker) destinationPinMarker.remove();
  destinationPinMarker = null;
}

function mapDistanceKm(pointA, pointB) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(pointB.lat - pointA.lat);
  const longitudeDelta = radians(pointB.lng - pointA.lng);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(pointA.lat)) * Math.cos(radians(pointB.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(arc));
}

function renderOperationsMap() {
  if (!initializeOperationsMap()) return;
  routeLayer.clearLayers();
  courierLayer.clearLayers();
  const bounds = [];
  const routes = routePlanning.data || [];
  const mappedRoutes = routes.filter((route) => Array.isArray(route.geometry) && route.geometry.length > 1);
  const riders = routePlanning.motoboys || [];
  const missingRoutes = routes.length - mappedRoutes.length;
  $('#map-route-count').textContent = `${mappedRoutes.length} ROTAS${missingRoutes ? ` · ${missingRoutes} PENDENTE${missingRoutes === 1 ? '' : 'S'}` : ''}`;
  $('#map-empty').textContent = routes.length && !mappedRoutes.length
    ? 'Rota viária indisponível. Verifique os endereços ou o serviço de rotas.'
    : 'Nenhuma rota ativa no momento';

  mappedRoutes.forEach((route, index) => {
    const points = (route.geometry || [])
      .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map(([longitude, latitude]) => [latitude, longitude]);
    if (points.length < 2) return;

    const thirdParty = route.forma_entrega === 'terceiro_express';
    const assigned = Boolean(route.motoboy);
    const color = thirdParty ? '#b86d43' : assigned ? ['#398777', '#527c9f', '#ab7e35', '#597563'][index % 4] : '#9b9b71';
    L.polyline(points, {
      color: '#fff',
      weight: 8,
      opacity: 0.92,
      interactive: false,
    }).addTo(routeLayer);
    const path = L.polyline(points, {
      color,
      weight: 3,
      opacity: 0.88,
      dashArray: thirdParty ? '8 7' : assigned ? null : '4 7',
    }).addTo(routeLayer);
    const remaining = route.tempo_restante_minutos ? ` · ${route.tempo_restante_minutos} min restantes` : '';
    path.bindTooltip(`${escapeHTML(route.pedido_externo_id)} · ${escapeHTML(route.motoboy?.nome || (thirdParty ? 'Terceiro expresso' : STATUS_LABELS[route.status] || 'Aguardando motoboy'))}${remaining}`);
    L.circleMarker(points[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#398777', fillOpacity: 1 })
      .bindTooltip(`Coleta · ${escapeHTML(route.pedido_externo_id)}`).addTo(routeLayer);
    L.circleMarker(points.at(-1), { radius: 6, color, weight: 3, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`Entrega · ${escapeHTML(route.pedido_externo_id)}`).addTo(routeLayer);
    bounds.push(...points);
  });

  const ridersNearRoutes = riders.filter((rider) => {
    const point = rider.posicao;
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return false;
    return mappedRoutes.some((route) =>
      (Number.isFinite(route.coleta?.lat) && Number.isFinite(route.coleta?.lng)
        && mapDistanceKm(point, route.coleta) <= 40)
      || (Number.isFinite(route.entrega?.lat) && Number.isFinite(route.entrega?.lng)
        && mapDistanceKm(point, route.entrega) <= 40),
    );
  });

  ridersNearRoutes.forEach((rider) => {
    const point = rider.posicao;
    const icon = L.divIcon({
      className: '',
      html: `<span class="map-courier-marker">${escapeHTML(rider.nome.slice(0, 1).toLocaleUpperCase('pt-BR'))}</span>`,
      iconSize: [27, 27],
      iconAnchor: [13, 13],
    });
    L.marker([point.lat, point.lng], { icon })
      .bindTooltip(`${escapeHTML(rider.nome)} · ${rider.status === 'disponivel' ? 'Disponível' : 'Em entrega'}${point.accuracy_m ? ` · GPS ±${point.accuracy_m} m` : ''}`)
      .addTo(courierLayer);
  });

  $('#map-empty').classList.toggle('is-hidden', bounds.length > 0);
  $('#map-summary').textContent = `${mappedRoutes.length} ${mappedRoutes.length === 1 ? 'trajeto traçado' : 'trajetos traçados'}${missingRoutes ? ` · ${missingRoutes} aguardando rota` : ''} · ETA sem trânsito ao vivo`;
  if (bounds.length) operationsMap.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
  else operationsMap.setView([-15.8, -47.9], 12);
  operationsMap.invalidateSize();
}

function renderDashboard() {
  const pending = deliveries.filter((delivery) => ['criada', 'procurando_entregador'].includes(delivery.status)).length;
  const onRoute = deliveries.filter((delivery) => ['coletada', 'em_rota'].includes(delivery.status)).length;
  $('#metric-total').textContent = deliveries.length;
  $('#metric-pending').textContent = pending;
  $('#metric-route').textContent = onRoute;
  $('#nav-delivery-count').textContent = deliveries.filter((delivery) => ACTIVE_STATUSES.has(delivery.status)).length;
  renderDeliveries($('#recent-deliveries'), deliveries.slice(0, 5), true);
  renderDeliveries($('#all-deliveries'), filteredDeliveries());
  renderCourierList();
  renderOperationsMap();
}

async function refresh() {
  try {
    const [deliveryResult, courierResult, planningResult] = await Promise.all([
      api('/v1/entregas'),
      api('/v1/entregadores'),
      api('/v1/planejamento'),
    ]);
    deliveries = deliveryResult.data;
    couriers = courierResult.data;
    routePlanning = planningResult;
    setConnection(true);
    renderDashboard();
    $('#last-updated').textContent = `Atualizado às ${new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
    return true;
  } catch (error) {
    setConnection(false);
    notify(error.message, true);
    $('#last-updated').textContent = 'Falha ao carregar dados';
    return false;
  }
}

function showView(view) {
  const titles = { dashboard: 'Visão geral', deliveries: 'Entregas', couriers: 'Entregadores', 'new-delivery': 'Nova entrega' };
  activeView = view;
  $$('.view').forEach((section) => {
    const visible = section.id === `view-${view}`;
    section.classList.toggle('is-visible', visible);
    section.hidden = !visible;
  });
  $$('.nav-item[data-view]').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  $('#breadcrumb-current').textContent = titles[view] || 'Visão geral';
  if (view === 'deliveries') renderDeliveries($('#all-deliveries'), filteredDeliveries());
  if (view === 'couriers') renderCourierList();
  if (view === 'dashboard' && operationsMap) window.setTimeout(renderOperationsMap, 0);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function quoteBody(form) {
  const data = new FormData(form);
  const cepDigits = data.get('entrega_cep').replace(/\D/g, '');
  const cep = cepDigits.length === 8 ? `${cepDigits.slice(0, 5)}-${cepDigits.slice(5)}` : '';
  const pinLatitude = data.get('destino_lat');
  const pinLongitude = data.get('destino_lng');
  const destination = pinLatitude && pinLongitude
    ? { lat: Number(pinLatitude), lng: Number(pinLongitude) }
    : {
      endereco: data.get('entrega_endereco').trim(),
      regiao: data.get('destino_regiao'),
      ...(cep && { cep }),
    };
  return {
    origem: { endereco: data.get('coleta_endereco').trim() },
    destino: destination,
    itens: [{ descricao: data.get('item_descricao').trim(), quantidade: Number(data.get('item_quantidade')) }],
    forma_entrega: data.get('forma_entrega'),
  };
}

function createBody(form, quote) {
  const data = new FormData(form);
  const destination = data.get('entrega_endereco').trim();
  const cepDigits = data.get('entrega_cep').replace(/\D/g, '');
  const cep = cepDigits.length === 8 ? `${cepDigits.slice(0, 5)}-${cepDigits.slice(5)}` : '';
  const body = {
    cotacao_id: quote.cotacao_id,
    pedido_externo_id: data.get('pedido_externo_id').trim(),
    vendedor_nome: data.get('vendedor_nome').trim(),
    coleta: { endereco: data.get('coleta_endereco').trim(), contato: { nome: data.get('coleta_nome').trim(), telefone: data.get('coleta_telefone').trim() } },
    entrega: { endereco: cep ? `${destination}, CEP ${cep}` : destination, contato: { nome: data.get('entrega_nome').trim(), telefone: data.get('entrega_telefone').trim() } },
  };
  const courierId = data.get('entregador_id');
  if (quote.forma_entrega === 'propria' && courierId) body.entregador_id = courierId;
  return body;
}

function renderQuote(quote) {
  const panel = $('#quote-panel');
  const external = quote.forma_entrega === 'terceiro_express';
  const sourceLabel = quote.fonte_estimativa === 'rota_viaria' ? 'rota viária' : 'estimativa por distância';
  panel.innerHTML = `<div class="quote-result-label">PLANEJAMENTO CALCULADO</div><div class="quote-price">${external ? 'Expresso' : money(quote.valor_centavos)}</div><div class="quote-result-label">${Number(quote.distancia_km).toFixed(2)} km · ${sourceLabel}</div>
    <div class="quote-meta"><div class="quote-meta-row"><span>Operação</span><strong>${external ? 'Terceiro expresso' : 'Frota própria'}</strong></div><div class="quote-meta-row"><span>Tempo estimado de rota</span><strong>${quote.tempo_viagem_minutos} min</strong></div><div class="quote-meta-row"><span>Previsão de chegada</span><strong>${quote.prazo_minutos} min</strong></div><div class="quote-meta-row"><span>${external ? 'Pagamento do parceiro' : 'Cobrança da entrega'}</span><strong>${external ? 'Feito por fora' : money(quote.valor_centavos)}</strong></div></div>
    <button class="button button-primary" id="confirm-delivery" type="button">${external ? 'Registrar pedido expresso' : 'Confirmar entrega'} <span>→</span></button><p class="quote-expiry">A previsão usa ${sourceLabel}; trânsito e tempo real de coleta podem alterar a chegada.</p>`;
}

function actionButton(action, label, secondary = false) {
  return `<button class="button ${secondary ? 'button-secondary' : 'button-primary'}" type="button" data-delivery-action="${action}">${label}</button>`;
}

function renderDeliveryActions(delivery) {
  switch (delivery.status) {
    case 'criada':
    case 'procurando_entregador': {
      if (delivery.forma_entrega === 'terceiro_express') {
        return `<label class="field"><span>NOME DO TERCEIRO</span><input id="external-name" required placeholder="Nome do prestador"></label><label class="field"><span>TELEFONE</span><input id="external-phone" type="tel" required minlength="8" placeholder="Telefone do prestador"></label><label class="field"><span>CUSTO PAGO FORA DA API (R$)</span><input id="external-cost" type="number" min="0" step="0.01" placeholder="Opcional"></label>${actionButton('assign-external', 'Registrar contratação')}${actionButton('cancel', 'Cancelar', true)}`;
      }
      const available = couriers.filter((courier) => courier.status === 'disponivel');
      if (!available.length) return `${actionButton('cancel', 'Cancelar', true)}<span class="form-note">Cadastre um entregador para atribuir esta entrega.</span>`;
      return `<label class="field"><span>ENTREGADOR DISPONÍVEL</span><select id="assign-courier">${available.map((courier) => `<option value="${shortId(courier.id)}">${escapeHTML(courier.nome)} · ${VEHICLE_LABELS[courier.veiculo] || escapeHTML(courier.veiculo)}</option>`).join('')}</select></label>${actionButton('assign', 'Atribuir')}${actionButton('cancel', 'Cancelar', true)}`;
    }
    case 'entregador_atribuido': return `${actionButton('pickup', 'Confirmar coleta')}${actionButton('release', 'Liberar entregador', true)}${actionButton('cancel', 'Cancelar', true)}`;
    case 'coletada': return `${actionButton('start-route', 'Iniciar rota')}${actionButton('fail', 'Registrar falha', true)}`;
    case 'em_rota': return `<label class="field"><span>CÓDIGO DE CONFIRMAÇÃO</span><input id="confirmation-code" inputmode="numeric" maxlength="4" placeholder="4 dígitos" value="${escapeHTML(delivery.codigo_confirmacao || '')}"></label>${actionButton('complete', 'Finalizar entrega')}${actionButton('fail', 'Registrar falha', true)}`;
    case 'falhou': return actionButton('start-return', 'Iniciar devolução');
    case 'devolvendo': return actionButton('complete-return', 'Confirmar devolução');
    default: return '<span class="form-note">Esta entrega não possui ações pendentes.</span>';
  }
}

async function openDelivery(id) {
  try {
    selectedDelivery = await api(`/v1/entregas/${encodeURIComponent(id)}`);
    const delivery = selectedDelivery;
    const events = delivery.eventos || [];
    $('#delivery-detail').innerHTML = `<div class="dialog-content"><div class="dialog-top"><div><div class="eyebrow">DETALHES DA ENTREGA</div><h2>${escapeHTML(delivery.pedido_externo_id)}</h2><span class="cell-secondary">${shortId(delivery.id)}</span></div><button class="dialog-close" type="button" data-close-dialog aria-label="Fechar">×</button></div>
      <div class="detail-grid"><div class="detail-item"><span>STATUS</span>${statusPill(delivery.status)}</div><div class="detail-item"><span>PREVISÃO DE CHEGADA</span><strong>${dateTime(delivery.previsao_entrega_em)}</strong></div><div class="detail-item"><span>DISTÂNCIA / TEMPO</span><strong>${Number(delivery.distancia_km || 0).toFixed(2)} km · ${delivery.prazo_minutos || '—'} min</strong></div><div class="detail-item"><span>COBRANÇA</span><strong>${money(delivery.valor_centavos)}</strong></div><div class="detail-item"><span>COLETA</span><strong>${escapeHTML(delivery.coleta?.endereco)}</strong></div><div class="detail-item"><span>ENTREGA</span><strong>${escapeHTML(delivery.entrega?.endereco)}</strong></div><div class="detail-item"><span>VEÍCULO</span><strong>${VEHICLE_LABELS[delivery.veiculo] || escapeHTML(delivery.veiculo)}</strong></div><div class="detail-item"><span>ENTREGADOR</span><strong>${escapeHTML(delivery.entregador?.nome || 'Ainda não atribuído')}</strong></div>${delivery.entregador?.tipo === 'terceiro' ? `<div class="detail-item"><span>PAGAMENTO EXTERNO REGISTRADO</span><strong>${money(delivery.entregador.custo_centavos)}</strong></div><div class="detail-item"><span>CONTATO DO TERCEIRO</span><strong>${escapeHTML(delivery.entregador.telefone)}</strong></div>` : ''}</div>
      <div class="detail-code seller-code"><span>VENDEDOR RESPONSÁVEL</span><strong>${escapeHTML(delivery.vendedor_nome || 'Não informado')}</strong></div>
      <div class="detail-code"><span>CÓDIGO PARA CONFIRMAR A ENTREGA</span><strong>${escapeHTML(delivery.codigo_confirmacao || '----')}</strong></div>
      <div class="eyebrow">HISTÓRICO DE EVENTOS</div><ul class="event-list">${events.map((event) => `<li><span>${escapeHTML(STATUS_LABELS[event.status] || event.status)}</span><time>${dateTime(event.em)}</time></li>`).join('') || '<li>Sem eventos registrados</li>'}</ul>
      <div class="detail-actions">${renderDeliveryActions(delivery)}</div></div>`;
    $('#delivery-dialog').showModal();
  } catch (error) {
    notify(error.message, true);
  }
}

async function runDeliveryAction(action) {
  if (!selectedDelivery) return;
  const id = encodeURIComponent(selectedDelivery.id);
  const routes = {
    pickup: [`/v1/entregas/${id}/coletar`, {}],
    'start-route': [`/v1/entregas/${id}/iniciar-rota`, {}],
    release: [`/v1/entregas/${id}/liberar`, {}],
    cancel: [`/v1/entregas/${id}/cancelar`, {}],
    'start-return': [`/v1/entregas/${id}/devolver`, {}],
    'complete-return': [`/v1/entregas/${id}/devolucao-concluida`, {}],
  };
  try {
    if (action === 'assign') {
      const courierId = $('#assign-courier')?.value;
      if (!courierId) throw new Error('Selecione um entregador disponível.');
      await api(`/v1/entregas/${id}/atribuir`, { method: 'POST', body: JSON.stringify({ entregador_id: courierId }) });
    } else if (action === 'assign-external') {
      const nome = $('#external-name')?.value.trim();
      const telefone = $('#external-phone')?.value.trim();
      const costInput = $('#external-cost')?.value;
      if (!nome || !telefone) throw new Error('Informe o nome e o telefone do terceiro.');
      await api(`/v1/entregas/${id}/atribuir-terceiro`, { method: 'POST', body: JSON.stringify({ nome, telefone, ...(costInput ? { custo_centavos: Math.round(Number(costInput) * 100) } : {}) }) });
    } else if (action === 'complete') {
      const code = $('#confirmation-code')?.value.trim();
      if (!code || code.length !== 4) throw new Error('Informe o código de confirmação com 4 dígitos.');
      await api(`/v1/entregas/${id}/finalizar`, { method: 'POST', body: JSON.stringify({ codigo: code }) });
    } else if (action === 'fail') {
      const motivo = window.prompt('Descreva o motivo da falha:');
      if (!motivo?.trim()) return;
      await api(`/v1/entregas/${id}/falha`, { method: 'POST', body: JSON.stringify({ motivo: motivo.trim() }) });
    } else {
      const [path, body] = routes[action];
      await api(path, { method: 'POST', body: JSON.stringify(body) });
    }
    notify('Entrega atualizada com sucesso.');
    $('#delivery-dialog').close();
    await refresh();
    if (activeView === 'deliveries') renderDeliveries($('#all-deliveries'), filteredDeliveries());
  } catch (error) {
    notify(error.message, true);
  }
}

document.addEventListener('click', async (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    showView(viewButton.dataset.view);
    return;
  }
  if (event.target.closest('#refresh-button')) {
    await refresh();
    notify('Dados atualizados.');
    return;
  }
  if (event.target.closest('#capture-gps-button')) {
    await captureCourierGps();
    return;
  }
  if (event.target.closest('#choose-destination-map')) {
    openDestinationPicker();
    return;
  }
  if (event.target.closest('[data-close-destination-map]')) {
    $('#destination-map-dialog').close();
    return;
  }
  if (event.target.id === 'confirm-destination-pin') {
    if (!pendingDestinationPin) return;
    $('#quote-form [name="destino_lat"]').value = pendingDestinationPin.lat;
    $('#quote-form [name="destino_lng"]').value = pendingDestinationPin.lng;
    $('#destination-pin-status').textContent = 'Ponto de entrega marcado no mapa';
    $('#destination-map-dialog').close();
    invalidateQuote(true);
    return;
  }
  const openButton = event.target.closest('[data-open-delivery]');
  if (openButton) {
    await openDelivery(openButton.dataset.openDelivery);
    return;
  }
  const actionButtonElement = event.target.closest('[data-delivery-action]');
  if (actionButtonElement) {
    await runDeliveryAction(actionButtonElement.dataset.deliveryAction);
    return;
  }
  if (event.target.closest('[data-close-dialog]')) $('#delivery-dialog').close();
  if (event.target.id === 'confirm-delivery') {
    try {
      if (!$('#quote-form').reportValidity()) return;
      const idempotencyKey = globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const created = await api('/v1/entregas', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(createBody($('#quote-form'), currentQuote)) });
      currentQuote = null;
      notify('Entrega criada e enviada para despacho.');
      await refresh();
      showView('deliveries');
      await openDelivery(created.id);
    } catch (error) {
      notify(error.message, true);
    }
  }
});

function invalidateQuote(schedule = false) {
  quoteRevision += 1;
  window.clearTimeout(quoteDebounceTimer);
  currentQuote = null;
  $('#quote-panel').innerHTML = '<div class="quote-empty"><span class="quote-empty-mark">ETA</span><h2>Recalcule o planejamento</h2><p>Os dados do pedido mudaram. Recalcule a rota antes de confirmar.</p></div>';
  if (!schedule) return;

  const form = $('#quote-form');
  const destination = form.elements.entrega_endereco.value.trim();
  const hasManualPin = Boolean(form.elements.destino_lat.value && form.elements.destino_lng.value);
  const description = form.elements.item_descricao.value.trim();
  if ((!hasManualPin && destination.length < 5) || !description) return;

  const revision = quoteRevision;
  $('#quote-panel').innerHTML = '<div class="quote-empty"><span class="quote-empty-mark">ETA</span><h2>Calculando rota</h2><p>Buscando o melhor caminho viário e o horário estimado.</p></div>';
  quoteDebounceTimer = window.setTimeout(() => calculateQuote(form, revision), 800);
}

function updateCourierSelection() {
  const ownFleet = $('#quote-form [name="forma_entrega"]').value === 'propria';
  $('#selected-courier-field').hidden = !ownFleet;
}

const quoteInputNames = new Set(['entrega_endereco', 'entrega_cep', 'destino_regiao', 'item_descricao', 'item_quantidade', 'forma_entrega']);
$('#quote-form').addEventListener('input', (event) => {
  if (event.target.name === 'entrega_endereco') clearDestinationPin();
  if (quoteInputNames.has(event.target.name)) invalidateQuote(true);
});
$('#quote-form').addEventListener('change', (event) => {
  if (event.target.name === 'forma_entrega') updateCourierSelection();
  if (event.target.name === 'destino_regiao') clearDestinationPin();
  if (quoteInputNames.has(event.target.name)) invalidateQuote(true);
});
updateCourierSelection();

async function calculateQuote(form, revision = ++quoteRevision) {
  if (revision !== quoteRevision) return;
  const button = $('#quote-form button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Calculando rota…';
  try {
    const quote = await api('/v1/entregas/cotacao', { method: 'POST', body: JSON.stringify(quoteBody(form)) });
    if (revision !== quoteRevision) return;
    currentQuote = quote;
    renderQuote(quote);
  } catch (error) {
    if (revision !== quoteRevision) return;
    const message = error.code === 'endereco_nao_encontrado'
      ? `${error.message}. Se o endereço não aparecer na busca, marque o ponto no mapa.`
      : error.message;
    $('#quote-panel').innerHTML = `<p class="quote-panel-error">${escapeHTML(message)}</p>`;
    currentQuote = null;
  } finally {
    if (revision === quoteRevision) {
      button.disabled = false;
      button.innerHTML = 'Atualizar rota <span>→</span>';
    }
  }
}

$('#quote-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  calculateQuote(event.currentTarget);
});

$('#courier-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    await api('/v1/entregadores', { method: 'POST', body: JSON.stringify({ nome: data.get('nome').trim(), telefone: data.get('telefone').trim(), veiculo: data.get('veiculo'), base_endereco: data.get('base_endereco').trim() }) });
    form.reset();
    notify('Entregador cadastrado.');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
});

async function captureCourierGps() {
  const courierId = $('#position-courier').value;
  const button = $('#capture-gps-button');
  if (!courierId) {
    notify('Selecione o motoboy antes de capturar o GPS.', true);
    return;
  }
  if (!navigator.geolocation) {
    notify('Este navegador não disponibiliza geolocalização.', true);
    return;
  }

  button.disabled = true;
  $('#gps-status').textContent = 'Obtendo posição GPS…';
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 20000,
      });
    });
    const location = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy_m: Math.round(position.coords.accuracy),
    };
    await api(`/v1/entregadores/${encodeURIComponent(courierId)}/posicao`, {
      method: 'POST',
      body: JSON.stringify(location),
    });
    $('#position-form [name="gps_lat"]').value = location.lat;
    $('#position-form [name="gps_lng"]').value = location.lng;
    $('#position-form [name="gps_accuracy"]').value = location.accuracy_m;
    $('#position-form [name="endereco"]').value = '';
    $('#gps-status').textContent = `GPS atualizado · precisão de ±${location.accuracy_m} m · ${dateTime(new Date(position.timestamp).toISOString())}`;
    notify('GPS salvo. O mapa agora usa a posição recente do motoboy.');
    await refresh();
  } catch (error) {
    const message = error.code === 1
      ? 'Permita o acesso à localização no navegador para capturar o GPS.'
      : error.code === 2
        ? 'O aparelho não conseguiu obter uma posição GPS.'
        : error.code === 3
          ? 'A leitura do GPS demorou demais; tente novamente em uma área aberta.'
          : error.message || 'Não foi possível salvar a posição GPS.';
    $('#gps-status').textContent = message;
    notify(message, true);
  } finally {
    button.disabled = false;
  }
}

$('#position-form [name="endereco"]').addEventListener('input', () => {
  $('#position-form [name="gps_lat"]').value = '';
  $('#position-form [name="gps_lng"]').value = '';
  $('#position-form [name="gps_accuracy"]').value = '';
  $('#gps-status').textContent = 'Localização manual selecionada.';
});

$('#position-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const courierId = data.get('entregador_id');
  const latitude = data.get('gps_lat');
  const longitude = data.get('gps_lng');
  const address = data.get('endereco').trim();
  const location = latitude && longitude
    ? { lat: Number(latitude), lng: Number(longitude), accuracy_m: Number(data.get('gps_accuracy')) }
    : address ? { endereco: address } : null;
  try {
    if (!courierId) throw new Error('Selecione um motoboy.');
    if (!location) throw new Error('Capture o GPS ou informe um endereço atual.');
    await api(`/v1/entregadores/${encodeURIComponent(courierId)}/posicao`, { method: 'POST', body: JSON.stringify(location) });
    $('#gps-status').textContent = location.accuracy_m
      ? `GPS salvo · precisão de ±${location.accuracy_m} m`
      : 'Endereço atualizado manualmente.';
    notify('Localização atualizada. O trecho restante foi recalculado.');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
});

$('#delivery-search').addEventListener('input', () => renderDeliveries($('#all-deliveries'), filteredDeliveries()));
$('#delivery-filter').addEventListener('change', () => renderDeliveries($('#all-deliveries'), filteredDeliveries()));
$('#delivery-dialog').addEventListener('click', (event) => {
  if (event.target === $('#delivery-dialog')) $('#delivery-dialog').close();
});

$('#pickup-address').value = $('#pickup-origin-address').textContent;
initializeOperationsMap();
refresh();