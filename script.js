const $ = id => document.getElementById(id);
const metricDefinitions = {
  pct_sobrepeso_obesidad: { label: 'Sobrepeso u obesidad', unit: '%', type: 'risk' },
  pct_caries: { label: 'Caries', unit: '%', type: 'risk' },
  pct_visual: { label: 'Problemas visuales', unit: '%', type: 'risk' },
  imc_promedio: { label: 'IMC promedio', unit: '', type: 'imc' },
  prioridad_atencion: { label: 'Prioridad de atención', unit: '', type: 'priority' },
  pct_alertas_multiples: { label: 'Alertas múltiples', unit: '%', type: 'priority' },
  completitud: { label: 'Completitud de registros', unit: '%', type: 'completeness' }
};
const palettes = {
  risk: ['#d9eee8', '#85c5b1', '#efb366', '#ad3d4b'],
  priority: ['#d9eee8', '#85c5b1', '#efb366', '#ad3d4b'],
  completeness: ['#dbeafe', '#93c5e5', '#4b93c3', '#0f4c81'],
  imc: ['#147d7e']
};
const categoryLabels = {
  risk: ['Menor', 'Media baja', 'Media alta', 'Mayor'],
  priority: ['Bajo', 'Medio', 'Alto', 'Muy alto'],
  completeness: ['Menor', 'Media baja', 'Media alta', 'Mayor']
};

const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([19.38, -99.14], 11);
const lightMap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 20
}).addTo(map);
const streetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap', maxZoom: 19
});
L.control.layers({ 'Mapa claro': lightMap, 'Calles': streetMap }, null, { position: 'topleft' }).addTo(map);

let data = [];
let filtered = [];
let represented = [];
let schoolsLayer = L.layerGroup().addTo(map);
let boroughLayer = null;
let boroughByName = {};
let selectedRecord = null;
let markerById = new Map();
const quartileCache = new Map();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function normalize(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}
function isNumber(value) {
  return value !== null && value !== '' && Number.isFinite(Number(value));
}
function formatNumber(value, decimals = 1) {
  if (!isNumber(value)) return '—';
  return Number(value).toLocaleString('es-MX', { maximumFractionDigits: decimals });
}
function enrollment(record) {
  return Number(record.NUM_MATRICULA_TOTAL_ESCUELA) || Number(record.NUM_MATRICULA_TOTAL_ESCUELA_y) || Number(record.NUM_MATRICULA_TOTAL_ESCUELA_x) || Number(record.matricula) || 0;
}
function average(field, rows) {
  const values = rows.map(row => Number(row[field])).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
function currentMetric() {
  return $('metricSelect').value;
}
function quartiles(metric) {
  if (quartileCache.has(metric)) return quartileCache.get(metric);
  const values = data.map(row => Number(row[metric])).filter(Number.isFinite).sort((a, b) => a - b);
  const at = proportion => values[Math.min(values.length - 1, Math.floor((values.length - 1) * proportion))];
  const result = values.length ? [at(.25), at(.5), at(.75)] : [0, 0, 0];
  quartileCache.set(metric, result);
  return result;
}
function category(metric, value) {
  if (!isNumber(value)) return null;
  if (metricDefinitions[metric].type === 'imc') return 'Disponible';
  const [q1, q2, q3] = quartiles(metric);
  const numeric = Number(value);
  const index = numeric <= q1 ? 0 : numeric <= q2 ? 1 : numeric <= q3 ? 2 : 3;
  return categoryLabels[metricDefinitions[metric].type][index];
}
function categoryIndex(metric, value) {
  if (!isNumber(value)) return -1;
  if (metricDefinitions[metric].type === 'imc') return 0;
  const [q1, q2, q3] = quartiles(metric);
  const numeric = Number(value);
  return numeric <= q1 ? 0 : numeric <= q2 ? 1 : numeric <= q3 ? 2 : 3;
}
function metricColor(metric, value) {
  const index = categoryIndex(metric, value);
  if (index < 0) return null;
  return palettes[metricDefinitions[metric].type][index];
}
function metricValue(metric, value, decimals = 1) {
  const unit = metricDefinitions[metric].unit;
  return isNumber(value) ? `${formatNumber(value, decimals)}${unit}` : '—';
}

function populateFilters() {
  const populate = (id, field) => {
    [...new Set(data.map(row => row[field]).filter(value => String(value ?? '').trim()))]
      .sort((a, b) => String(a).localeCompare(String(b), 'es'))
      .forEach(value => $(id).add(new Option(value, value)));
  };
  populate('filterAlcaldia', 'alcaldia');
  populate('filterLevel', 'NIVEL');
  populate('filterCycle', 'REF_CICLO_ESCOLAR');
}

function applyFilters(options = {}) {
  const borough = $('filterAlcaldia').value;
  const level = $('filterLevel').value;
  const cycle = $('filterCycle').value;
  const priority = $('filterPriority').value;
  const alerts = $('filterAlerts').value;
  filtered = data.filter(row =>
    (!borough || row.alcaldia === borough) &&
    (!level || row.NIVEL === level) &&
    (!cycle || row.REF_CICLO_ESCOLAR === cycle) &&
    (!priority || category('prioridad_atencion', row.prioridad_atencion) === priority) &&
    (!alerts || category('pct_alertas_multiples', row.pct_alertas_multiples) === alerts)
  );
  represented = filtered.filter(row => isNumber(row[currentMetric()]));
  renderMap();
  updateLegend();
  updateSummary();
  updateActiveFilters();
  updateBoroughSummary();
  if (options.zoomBorough && borough) zoomToBorough(borough);
  if (selectedRecord) {
    if (filtered.some(row => row._id === selectedRecord._id)) showDetails(selectedRecord, false);
    else closeDetails();
  }
}

function renderMap() {
  schoolsLayer.clearLayers();
  markerById.clear();
  const metric = currentMetric();
  represented.forEach(record => {
    if (!isNumber(record.latitud) || !isNumber(record.longitud)) return;
    const marker = L.circleMarker([Number(record.latitud), Number(record.longitud)], {
      radius: selectedRecord?._id === record._id ? 9 : 6.5,
      weight: selectedRecord?._id === record._id ? 3 : 1.4,
      color: selectedRecord?._id === record._id ? '#0a355c' : '#ffffff',
      fillColor: metricColor(metric, record[metric]),
      fillOpacity: .94
    });
    marker.bindTooltip(`<strong>${escapeHtml(record.NOM_ESCUELA_ATENCION)}</strong><br><span>${escapeHtml(record.CVE_ESCUELA_ATENCION)} · ${escapeHtml(metricValue(metric, record[metric], 2))}</span>`, { direction: 'top' });
    marker.on('click', () => showDetails(record, true));
    marker.addTo(schoolsLayer);
    markerById.set(record._id, marker);
  });
  if ($('chkSchools').checked && !map.hasLayer(schoolsLayer)) map.addLayer(schoolsLayer);
  if (!$('chkSchools').checked && map.hasLayer(schoolsLayer)) map.removeLayer(schoolsLayer);
  $('mapStatusText').textContent = represented.length
    ? `${represented.length.toLocaleString('es-MX')} registros representados en el mapa.`
    : 'No hay registros con información para la selección actual.';
  $('footerCount').textContent = `${represented.length.toLocaleString('es-MX')} registros visibles`;
}

function updateLegend() {
  const metric = currentMetric();
  const definition = metricDefinitions[metric];
  $('legendTitle').textContent = definition.label;
  $('miniLegendTitle').textContent = definition.label;
  $('miniLegendBar').className = `mini-color-bar ${definition.type === 'imc' ? 'imc' : definition.type === 'completeness' ? 'completeness' : ''}`;
  if (definition.type === 'imc') {
    $('miniLegendLabels').innerHTML = '<span>Registros con IMC promedio</span><span></span>';
    $('legendBody').innerHTML = `<div class="legend-row"><span class="legend-dot" style="background:${palettes.imc[0]}"></span><span>Con valor disponible</span><small>${represented.length.toLocaleString('es-MX')}</small></div><p class="legend-note">El IMC promedio se muestra sin clasificación diagnóstica; su interpretación depende de la edad y el sexo de la población escolar.</p>`;
    return;
  }
  $('miniLegendLabels').innerHTML = '<span>Menor</span><span>Mayor</span>';
  const limits = quartiles(metric);
  const labels = categoryLabels[definition.type];
  const ranges = [
    `Hasta ${metricValue(metric, limits[0])}`,
    `>${metricValue(metric, limits[0])} a ${metricValue(metric, limits[1])}`,
    `>${metricValue(metric, limits[1])} a ${metricValue(metric, limits[2])}`,
    `Más de ${metricValue(metric, limits[2])}`
  ];
  $('legendBody').innerHTML = labels.map((label, index) => `<div class="legend-row"><span class="legend-dot" style="background:${palettes[definition.type][index]}"></span><span>${label}</span><small>${ranges[index]}</small></div>`).join('');
}

function updateSummary() {
  const metric = currentMetric();
  $('kSchools').textContent = represented.length.toLocaleString('es-MX');
  $('kEnrollment').textContent = represented.reduce((sum, row) => sum + enrollment(row), 0).toLocaleString('es-MX');
  $('kImc').textContent = formatNumber(average('imc_promedio', represented), 2);
  $('kMetric').textContent = metricValue(metric, average(metric, represented), 2);
  $('kMetricLabel').textContent = metricDefinitions[metric].label;
}

function updateActiveFilters() {
  const filters = [
    ['Alcaldía', $('filterAlcaldia').value], ['Nivel', $('filterLevel').value], ['Ciclo', $('filterCycle').value],
    ['Prioridad', $('filterPriority').selectedOptions[0]?.text && $('filterPriority').value ? $('filterPriority').selectedOptions[0].text : ''],
    ['Alertas', $('filterAlerts').selectedOptions[0]?.text && $('filterAlerts').value ? $('filterAlerts').selectedOptions[0].text : '']
  ].filter(([, value]) => value);
  $('activeFilters').innerHTML = filters.length
    ? filters.map(([label, value]) => `<span class="filter-chip">${escapeHtml(label)}: ${escapeHtml(value)}</span>`).join('')
    : '<span class="no-filters">Sin filtros activos</span>';
}

function updateBoroughSummary() {
  const groups = new Map();
  represented.forEach(row => {
    const name = row.alcaldia;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  });
  const metric = currentMetric();
  $('boroughSummary').innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'es')).map(([name, rows]) =>
    `<button class="borough-card" type="button" data-borough="${escapeHtml(name)}"><span><strong>${escapeHtml(name)}</strong><small>${rows.length.toLocaleString('es-MX')} registros</small></span><b>${escapeHtml(metricValue(metric, average(metric, rows), 1))}</b></button>`
  ).join('');
  document.querySelectorAll('.borough-card').forEach(button => button.addEventListener('click', () => {
    $('filterAlcaldia').value = button.dataset.borough;
    applyFilters({ zoomBorough: true });
  }));
}

function optionalInfo(label, value, formatter = value => escapeHtml(value)) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  return `<div class="info-card"><span>${escapeHtml(label)}</span><strong>${formatter(value)}</strong></div>`;
}
function indicatorRow(metric, record) {
  if (!isNumber(record[metric])) return '';
  return `<div class="indicator-row"><span>${escapeHtml(metricDefinitions[metric].label)}</span><strong>${escapeHtml(metricValue(metric, record[metric], 2))}</strong></div>`;
}
function plainIndicatorRow(label, value, unit = '') {
  if (!isNumber(value)) return '';
  return `<div class="indicator-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(`${formatNumber(value, 2)}${unit}`)}</strong></div>`;
}
function metricContext(metric, record) {
  const support = {
    pct_caries: ['casos_caries', 'registros_caries', 'casos'],
    pct_visual: ['casos_visual', 'registros_visual', 'casos'],
    pct_sobrepeso_obesidad: ['casos_sobrepeso_obesidad', 'registros_sobrepeso_obesidad', 'casos'],
    pct_alertas_multiples: ['casos_alertas_multiples', 'registros_alertas_multiples', 'casos con 2 o más alertas'],
    completitud: ['casos_completos', 'registros_completitud', 'registros completos'],
    imc_promedio: [null, 'registros_imc', 'registros considerados'],
    prioridad_atencion: [null, 'registros_salud', 'registros considerados']
  }[metric];
  if (!support || !isNumber(record[support[1]])) return '';
  const total = Number(record[support[1]]).toLocaleString('es-MX');
  if (!support[0] || !isNumber(record[support[0]])) return `${total} ${support[2]}`;
  const cases = Number(record[support[0]]).toLocaleString('es-MX');
  return `${cases} ${support[2]} de ${total} registros`;
}
function showDetails(record, focusMap = true) {
  selectedRecord = record;
  const metric = currentMetric();
  markerById.forEach((marker, id) => marker.setStyle({ radius: id === record._id ? 9 : 6.5, weight: id === record._id ? 3 : 1.4, color: id === record._id ? '#0a355c' : '#ffffff' }));
  $('detailsTitle').textContent = record.NOM_ESCUELA_ATENCION || 'Información de la escuela';
  const baseInfo = [
    optionalInfo('CCT', record.CVE_ESCUELA_ATENCION),
    optionalInfo('Turno', record.REF_TURNO_ATENCION),
    optionalInfo('Nivel educativo', record.NIVEL),
    optionalInfo('Alcaldía', record.alcaldia),
    optionalInfo('Ciclo escolar', record.REF_CICLO_ESCOLAR),
    optionalInfo('Matrícula', enrollment(record), value => Number(value).toLocaleString('es-MX'))
  ].join('');
  const indicators = Object.keys(metricDefinitions).map(key => indicatorRow(key, record)).join('') + plainIndicatorRow('Promedio de alertas', record.alertas_promedio);
  const classification = metricDefinitions[metric].type === 'imc' ? 'Valor disponible' : category(metric, record[metric]);
  const context = metricContext(metric, record);
  $('detailsBody').innerHTML = `
    <section class="detail-section"><div class="school-detail-header"><div class="school-detail-icon"><i class="fa-solid fa-school"></i></div><div><h3>${escapeHtml(record.NOM_ESCUELA_ATENCION)}</h3><p>${escapeHtml(record.CVE_ESCUELA_ATENCION)} · ${escapeHtml(record.NIVEL || '')}</p></div></div></section>
    <section class="detail-section"><h4>Datos de identificación</h4><div class="info-grid">${baseInfo}</div></section>
    ${isNumber(record[metric]) ? `<section class="detail-section"><h4>Indicador representado</h4><div class="metric-highlight" style="border-left-color:${metricColor(metric, record[metric])}"><span>${escapeHtml(metricDefinitions[metric].label)}</span><strong>${escapeHtml(metricValue(metric, record[metric], 2))}</strong><small>${escapeHtml([classification, context].filter(Boolean).join(' · '))}</small></div></section>` : ''}
    <section class="detail-section"><h4>Indicadores disponibles</h4><div class="indicator-list">${indicators}</div></section>`;
  $('detailsPanel').classList.remove('closed');
  $('appLayout').classList.remove('details-closed');
  setTimeout(() => map.invalidateSize(), 220);
  if (focusMap && isNumber(record.latitud) && isNumber(record.longitud)) map.setView([Number(record.latitud), Number(record.longitud)], Math.max(map.getZoom(), 15), { animate: true });
}
function closeDetails() {
  selectedRecord = null;
  $('detailsPanel').classList.add('closed');
  $('appLayout').classList.add('details-closed');
  markerById.forEach(marker => marker.setStyle({ radius: 6.5, weight: 1.4, color: '#ffffff' }));
  setTimeout(() => map.invalidateSize(), 220);
}

function loadBoroughs() {
  fetch('data/alcaldias.json').then(response => {
    if (!response.ok) throw new Error('No fue posible cargar los límites territoriales.');
    return response.json();
  }).then(geojson => {
    boroughLayer = L.geoJSON(geojson, {
      style: { color: '#365f78', weight: 1.5, fillColor: '#6d99ae', fillOpacity: .045 },
      interactive: false,
      onEachFeature: (feature, layer) => {
        const properties = feature.properties || {};
        const name = properties.NOMGEO || properties.alcaldia || properties.ALCALDIA || properties.nombre || properties.NOMBRE || Object.values(properties).find(value => typeof value === 'string');
        if (name) boroughByName[normalize(name)] = layer;
      }
    }).addTo(map);
    if (!$('chkAlcaldias').checked) map.removeLayer(boroughLayer);
  }).catch(() => { $('chkAlcaldias').disabled = true; });
}
function zoomToBorough(name) {
  const layer = boroughByName[normalize(name)];
  if (layer) map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 13 });
  else {
    const points = data.filter(row => row.alcaldia === name && isNumber(row.latitud) && isNumber(row.longitud)).map(row => [Number(row.latitud), Number(row.longitud)]);
    if (points.length) map.fitBounds(points, { padding: [24, 24], maxZoom: 13 });
  }
}

function renderSearch(query) {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length < 2) { $('searchResults').classList.remove('visible'); return; }
  const matches = data.filter(row => normalize(`${row.NOM_ESCUELA_ATENCION} ${row.CVE_ESCUELA_ATENCION} ${row.alcaldia}`).includes(normalizedQuery)).slice(0, 12);
  $('searchResults').innerHTML = matches.length ? matches.map(row =>
    `<button class="search-result-item" type="button" data-id="${row._id}"><strong>${escapeHtml(row.NOM_ESCUELA_ATENCION)}</strong><span>${escapeHtml(row.CVE_ESCUELA_ATENCION)} · ${escapeHtml(row.NIVEL)}</span><small>${escapeHtml(row.alcaldia)}</small></button>`
  ).join('') : '<div class="search-empty">No se encontraron coincidencias.</div>';
  $('searchResults').classList.add('visible');
  document.querySelectorAll('.search-result-item').forEach(button => button.addEventListener('click', () => selectSearchResult(Number(button.dataset.id))));
}
function selectSearchResult(id) {
  const record = data.find(row => row._id === id);
  if (!record) return;
  $('searchInput').value = `${record.CVE_ESCUELA_ATENCION} · ${record.NOM_ESCUELA_ATENCION}`;
  $('searchResults').classList.remove('visible');
  ['filterAlcaldia', 'filterLevel', 'filterCycle', 'filterPriority', 'filterAlerts'].forEach(filterId => $(filterId).value = '');
  if (!isNumber(record[currentMetric()])) $('metricSelect').value = 'pct_sobrepeso_obesidad';
  applyFilters();
  showDetails(record, true);
}

function toggleSection(sectionId, buttonId) {
  const section = $(sectionId);
  section.classList.toggle('is-collapsed');
  $(buttonId).setAttribute('aria-expanded', String(!section.classList.contains('is-collapsed')));
}
function clearFilters() {
  ['filterAlcaldia', 'filterLevel', 'filterCycle', 'filterPriority', 'filterAlerts'].forEach(id => $(id).value = '');
  $('searchInput').value = '';
  closeDetails();
  applyFilters();
  map.setView([19.38, -99.14], 11);
}

$('metricSelect').addEventListener('change', applyFilters);
$('filterAlcaldia').addEventListener('change', () => applyFilters({ zoomBorough: true }));
['filterLevel', 'filterCycle', 'filterPriority', 'filterAlerts'].forEach(id => $(id).addEventListener('change', applyFilters));
$('clearFilters').addEventListener('click', clearFilters);
$('closeDetails').addEventListener('click', closeDetails);
$('layersToggle').addEventListener('click', () => toggleSection('layersSection', 'layersToggle'));
$('boroughToggle').addEventListener('click', () => toggleSection('boroughSection', 'boroughToggle'));
$('chkSchools').addEventListener('change', renderMap);
$('chkAlcaldias').addEventListener('change', () => { if (!boroughLayer) return; $('chkAlcaldias').checked ? map.addLayer(boroughLayer) : map.removeLayer(boroughLayer); });
$('legendToggle').addEventListener('click', () => {
  $('legendBody').classList.toggle('collapsed');
  $('legendToggle').innerHTML = $('legendBody').classList.contains('collapsed') ? '<i class="fa-solid fa-plus"></i>' : '<i class="fa-solid fa-minus"></i>';
});
$('searchInput').addEventListener('input', event => renderSearch(event.target.value));
document.addEventListener('click', event => { if (!event.target.closest('.search-box')) $('searchResults').classList.remove('visible'); });
$('openFilters').addEventListener('click', () => $('filtersPanel').classList.toggle('open'));
map.on('click', () => { if (window.innerWidth <= 900) $('filtersPanel').classList.remove('open'); });
$('fullscreenBtn').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
});
document.addEventListener('fullscreenchange', () => {
  $('fullscreenBtn').innerHTML = document.fullscreenElement ? '<i class="fa-solid fa-compress"></i><span>Salir</span>' : '<i class="fa-solid fa-expand"></i><span>Pantalla completa</span>';
});
window.addEventListener('resize', () => map.invalidateSize());

Promise.all([
  fetch('data/salud_escolar.json').then(response => {
    if (!response.ok) throw new Error('No fue posible cargar la base de salud.');
    return response.json();
  })
]).then(([records]) => {
  data = records.map((record, index) => ({ ...record, _id: index }));
  filtered = [...data];
  populateFilters();
  loadBoroughs();
  applyFilters();
}).catch(error => {
  $('mapStatusText').textContent = error.message;
  $('footerCount').textContent = 'Error de carga';
});
