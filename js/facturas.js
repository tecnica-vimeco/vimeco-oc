/* VIMECO S.A. — Facturas: cargar la factura (u otro archivo) de una OC existente */

let currentFile = null;
let allOCs      = [];
let pendingOC   = null;   // OC elegida para cargar manualmente (vista principal)
let viewerIsAdmin = false; // 0000 o usuario con permiso admin
let tipoCarga   = 'factura';  // 'factura' | 'otro'
let rawFile     = null;   // imagen original (sin escanear), para volver a pasarla por el escáner
let filePrevUrl = null;   // objectURL del preview actual
let filtroOC    = 'sin';  // 'sin' | 'con' | 'todas' — arranca en lo que falta cargar

const ES_MOBILE = 'ontouchstart' in window || window.innerWidth <= 768;

// En la carpeta de una compra conviven la OC, el presupuesto, la factura y los
// remitos: el prefijo es lo único que los distingue. "Otro archivo" va con su
// nombre original, para no rotular de factura algo que no lo es.
function archivoParaDrive(file) {
  if (tipoCarga !== 'factura') return file;
  return new File([file], nombreArchivoDrive('Factura', file.name), { type: file.type });
}

const $ = id => document.getElementById(id);



function fmtMoney(n) {
  return (parseFloat(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function displayToISODate(d) {
  const p = (d || '').split('/');
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : (d || '');
}

// ---- Estado de facturación de la OC ----

// Qué se le cargó ya a esta OC ('con' | 'otros' | 'sin'). El criterio vive en
// firebase.js —junto al escritor del nodo `adjuntos`— porque también lo lee el
// resumen del período en Reportes.
function estadoFactura(oc) {
  return estadoFacturaOC(oc);
}

// dd/mm a mano: toLocaleDateString('es-AR') con 2-digit igual devuelve "10/8".
function fmtFechaCorta(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function badgeFactura(f) {
  if (f.estado === 'con') {
    const tip = f.por ? `Factura cargada por ${f.por}` : 'Factura cargada';
    return `<span class="adj-badge adj-badge--con" title="${esc(tip)}">${icSvg('checkSm')} Factura ${fmtFechaCorta(f.ts)}</span>`;
  }
  if (f.estado === 'otros') {
    return `<span class="adj-badge adj-badge--otros" title="Archivos cargados antes de que la pantalla distinguiera la factura de otro archivo">${f.n} archivo${f.n > 1 ? 's' : ''}</span>`;
  }
  return '<span class="adj-badge adj-badge--sin">Sin factura</span>';
}

// Cargar una factura sobre una OC que ya la tiene suele ser el mismo archivo
// subido dos veces. Cargar "otro archivo" es legítimo y no se pregunta nada.
function confirmarDuplicado(oc) {
  if (tipoCarga !== 'factura') return true;
  const f = estadoFactura(oc);
  if (f.estado !== 'con') return true;
  const cuando = f.ts ? ' el ' + new Date(f.ts).toLocaleDateString('es-AR') : '';
  const quien  = f.por ? ' por ' + f.por : '';
  return confirm(`La OC ${oc.nroOC} ya tiene una factura cargada${cuando}${quien}.\n\n¿Cargar otra igual?`);
}

// Deja registrado el archivo en el historial para que la lista pueda mostrar el
// estado sin consultar Drive. Best-effort: si falla, el archivo ya está subido.
// Se refleja primero en memoria, así el sello cambia sin recargar la pantalla.
async function registrarAdjunto(oc, file) {
  const registro = {
    tipo:   tipoCarga === 'factura' ? 'factura' : 'otro',
    nombre: file.name,
    ts:     Date.now(),
    por:    sessionStorage.getItem('responsable_name') || ''
  };
  oc.adjuntos = oc.adjuntos || {};
  oc.adjuntos['local_' + registro.ts] = registro;
  try { await registrarAdjuntoOC(oc.nroOC, registro); }
  catch (e) { console.warn('registrarAdjunto:', e); }
}

// Repinta el sello de una tarjeta ya renderizada, sin rearmar la lista entera
// (rearmarla sacaría la tarjeta de la vista justo cuando el usuario mira si
// funcionó).
function refrescarBadge(oc) {
  const badge = document
    .querySelector(`[data-nro="${CSS.escape(oc.nroOC)}"]`)
    ?.closest('.adj-oc-card')?.querySelector('.adj-badge');
  if (badge) badge.outerHTML = badgeFactura(estadoFactura(oc));
}

// ---- Archivo ----

function setFile(file) {
  currentFile = file;
  $('import-zone').classList.add('hidden');
  $('file-ready-msg').innerHTML = `${icSvg('check')} ${esc(file.name)} &nbsp;(${(file.size / 1024).toFixed(0)} KB)`;
  $('file-info').classList.remove('hidden');
  $('step1-actions').classList.remove('hidden');
  mostrarPreview(file);
}

// El preview (con su botón de escanear) solo tiene sentido con imágenes: un PDF
// ya viene derecho y no pasa por el escáner.
function mostrarPreview(file) {
  if (filePrevUrl) { URL.revokeObjectURL(filePrevUrl); filePrevUrl = null; }
  const box = $('file-preview');
  if (!file.type.startsWith('image/') || typeof openScanner !== 'function') {
    box.classList.add('hidden');
    $('file-preview-img').removeAttribute('src');
    return;
  }
  filePrevUrl = URL.createObjectURL(file);
  $('file-preview-img').src = filePrevUrl;
  box.classList.remove('hidden');
}

function resetZone() {
  currentFile = null;
  rawFile     = null;
  if (filePrevUrl) { URL.revokeObjectURL(filePrevUrl); filePrevUrl = null; }
  $('import-zone').classList.remove('hidden');
  $('file-info').classList.add('hidden');
  $('file-preview').classList.add('hidden');
  $('file-preview-img').removeAttribute('src');
  $('step1-actions').classList.add('hidden');
  $('file-input').value     = '';
  $('camera-input').value   = '';
  $('manual-camera').value  = '';
}

// Pasa una foto por el escáner (recorte de perspectiva + filtro). Una factura
// enderezada se archiva mejor en Drive y la IA la lee mucho mejor.
// Devuelve el archivo a usar, o null si el usuario canceló el escaneo.
async function escanear(file) {
  if (!file || typeof openScanner !== 'function') return file || null;
  try {
    return await openScanner(file);
  } catch (_) {
    // Escáner no disponible (p. ej. sin conexión la primera vez): va la original.
    toast('Escáner no disponible; se usó la foto original.', 'warning');
    return file;
  }
}

async function checkShareFile() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open('share-target');
    const match = await cache.match('shared-file');
    if (!match) return null;
    const blob     = await match.blob();
    const filename = match.headers.get('X-File-Name') || 'archivo';
    const filetype = match.headers.get('Content-Type') || blob.type;
    return new File([blob], filename, { type: filetype });
  } catch (_) { return null; }
}

async function clearShareFile() {
  try {
    const cache = await caches.open('share-target');
    await cache.delete('shared-file');
  } catch (_) {}
}

// ---- Scoring ----

function normalizeProvName(s) {
  return (s || '').toLowerCase()
    .replace(/\b(s\.a\.|s\.r\.l\.|s\.a\.s\.|s\.a|s\.r\.l|sa|srl|sas)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function provSimilarity(a, b) {
  const na = normalizeProvName(a);
  const nb = normalizeProvName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wa = na.split(' ').filter(w => w.length > 2);
  const wb = nb.split(' ').filter(w => w.length > 2);
  if (!wa.length || !wb.length) return 0;
  const overlap = wa.filter(w => wb.some(x => x.includes(w) || w.includes(x)));
  return overlap.length / Math.max(wa.length, wb.length);
}

function scoreMatch(extracted, oc) {
  let score = 0;

  // Total: factor principal
  if (extracted.total_documento && oc.total && oc.total > 0) {
    const ratio = Math.abs(extracted.total_documento - oc.total) / oc.total;
    if (ratio <= 0.01)      score += 6;
    else if (ratio <= 0.05) score += 4;
    else if (ratio <= 0.15) score += 2;
    else if (ratio <= 0.30) score += 1;
  }

  // Proveedor
  const sim = provSimilarity(extracted.proveedor, oc.proveedor?.nombre);
  if (sim >= 0.65)      score += 2;
  else if (sim >= 0.3)  score += 1;

  // Fecha reciente
  if (oc.timestamp) {
    const diffDays = Math.abs(Date.now() - oc.timestamp) / 86400000;
    if (diffDays <= 45) score += 1;
  }

  return score;
}

function getTopMatches(extracted, ocs) {
  return ocs
    .map(oc => ({ oc, score: scoreMatch(extracted, oc) }))
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ---- Render ----

function renderMatchCards(matches) {
  return matches.map(({ oc, score }) => {
    const stars = score >= 7 ? '●●●' : score >= 4 ? '●●○' : '●○○';
    return `<div class="adj-oc-card">
      <div class="adj-oc-top">
        <span class="hist-nro">${esc(oc.nroOC)}</span>
        <span class="adj-match-score" title="Nivel de coincidencia">${stars}</span>
        <span class="hist-fecha">${esc(oc.fecha || '')}</span>
      </div>
      <div class="hist-proveedor">${esc(oc.proveedor?.nombre || '—')}</div>
      <div class="hist-obra">${esc(oc.obra || '—')}</div>
      <div class="adj-oc-bottom">
        <span class="adj-oc-meta">
          <span class="hist-total">${oc.total != null ? '$ ' + fmtMoney(oc.total) : '—'}</span>
          ${badgeFactura(estadoFactura(oc))}
        </span>
        <button class="btn btn-sm btn-primary btn-adj-attach" data-nro="${esc(oc.nroOC)}">Cargar acá</button>
      </div>
    </div>`;
  }).join('');
}

function renderOCListItems(ocs) {
  if (!ocs.length) return '<div class="hist-empty">No hay OC en el historial.</div>';
  return ocs.map(oc => `<div class="adj-oc-card">
    <div class="adj-oc-top">
      <span class="hist-nro">${esc(oc.nroOC)}</span>
      <span class="hist-fecha">${esc(oc.fecha || '')}</span>
    </div>
    <div class="hist-proveedor">${esc(oc.proveedor?.nombre || '—')}</div>
    <div class="hist-obra">${esc(oc.obra || '—')}</div>
    <div class="adj-oc-bottom">
      <span class="adj-oc-meta">
        <span class="hist-total">${oc.total != null ? '$ ' + fmtMoney(oc.total) : '—'}</span>
        ${badgeFactura(estadoFactura(oc))}
      </span>
      <button class="btn btn-sm btn-primary btn-adj-attach" data-nro="${esc(oc.nroOC)}">Cargar acá</button>
    </div>
  </div>`).join('');
}

function renderManualListHTML(ocs) {
  return `<input type="search" class="hist-search" id="adj-search"
    placeholder="Buscar por proveedor, obra o N° OC…"
    style="margin-bottom:.75rem;width:100%;">
  <div id="adj-oc-list">${renderOCListItems(ocs)}</div>`;
}

// ---- Vista principal: lista de OC (se elige el archivo al tocar Cargar) ----

function renderPrimaryListItems(ocs) {
  if (!ocs.length) {
    if ($('adj-search-main').value.trim()) return '<div class="hist-empty">No se encontraron OC.</div>';
    return `<div class="hist-empty">${
      filtroOC === 'sin' ? 'No queda ninguna OC sin factura.' :
      filtroOC === 'con' ? 'Todavía no hay ninguna OC con factura cargada.' :
                           'No hay OC en el historial.'}</div>`;
  }
  return ocs.map(oc => `<div class="adj-oc-card">
    <div class="adj-oc-top">
      <span class="hist-nro">${esc(oc.nroOC)}</span>
      <span class="hist-fecha">${esc(oc.fecha || '')}</span>
    </div>
    <div class="hist-proveedor">${esc(oc.proveedor?.nombre || '—')}</div>
    <div class="hist-obra">${esc(oc.obra || '—')}</div>
    ${viewerIsAdmin && oc.responsable?.nombre ? `<div class="hist-obra" style="color:var(--gray-500);font-size:.78rem;">por ${esc(oc.responsable.nombre)}</div>` : ''}
    <div class="adj-oc-bottom">
      <span class="adj-oc-meta">
        <span class="hist-total">${oc.total != null ? '$ ' + fmtMoney(oc.total) : '—'}</span>
        ${badgeFactura(estadoFactura(oc))}
      </span>
      <span class="adj-oc-actions">
        ${ES_MOBILE ? `<button class="btn btn-sm btn-secondary btn-icon btn-attach-cam" data-nro="${esc(oc.nroOC)}" title="Sacar foto" aria-label="Sacar foto"><svg class="icon" style="width:14px;height:14px;" viewBox="0 0 24 24"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg></button>` : ''}
        <button class="btn btn-sm btn-primary btn-attach-pick" data-nro="${esc(oc.nroOC)}"><svg class="icon" style="width:14px;height:14px;" viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg> Cargar</button>
      </span>
    </div>
  </div>`).join('');
}

function renderPrimaryList(filter = '') {
  const q = filter.toLowerCase().trim();
  // 'otros' cae del lado de "sin": que haya un archivo viejo sin rotular no
  // prueba que la factura esté cargada.
  let list = filtroOC === 'todas'
    ? allOCs
    : allOCs.filter(oc => (estadoFactura(oc).estado === 'con') === (filtroOC === 'con'));
  if (q) {
    list = list.filter(oc =>
      (oc.proveedor?.nombre || '').toLowerCase().includes(q) ||
      (oc.obra || '').toLowerCase().includes(q) ||
      (oc.nroOC || '').toLowerCase().includes(q));
  }
  const box = $('adj-oc-list-main');
  box.innerHTML = renderPrimaryListItems(pager.take('adj', list));
  bindPickButtons();
  pager.footer('adj', box, list, () => renderPrimaryList(filter));
}

function bindPickButtons() {
  document.querySelectorAll('.btn-attach-pick').forEach(btn => {
    btn.addEventListener('click', () => {
      const oc = allOCs.find(o => o.nroOC === btn.dataset.nro) || null;
      if (!oc || !confirmarDuplicado(oc)) return;
      pendingOC = oc;
      const mf = $('manual-file');
      mf.value = '';
      mf.click();
    });
  });

  // Sacar foto: la factura pasa por el escáner y se sube apenas se toca "Listo".
  document.querySelectorAll('.btn-attach-cam').forEach(btn => {
    btn.addEventListener('click', () => {
      const oc = allOCs.find(o => o.nroOC === btn.dataset.nro) || null;
      if (!oc || !confirmarDuplicado(oc)) return;
      pendingOC = oc;
      const ci = $('manual-camera');
      ci.value = '';
      ci.click();
    });
  });
}

// Registra la carga en el feed de Novedades (best-effort). Los eventos viejos
// siguen siendo 'adjunto' (podían ser cualquier cosa); los nuevos distinguen la
// factura, que es lo que la pantalla carga por defecto.
function logAdjuntoActivity(oc, file, folderId) {
  if (typeof logActivity !== 'function') return;
  const fid = folderId || oc.drive_folder_obras_id || oc.drive_folder_proveedores_id || oc.drive_folder_id || '';
  const esFactura = tipoCarga === 'factura';
  logActivity({
    tipo:    esFactura ? 'factura' : 'adjunto',
    nroOC:   oc.nroOC,
    usuario: {
      codigo: sessionStorage.getItem('responsable_code') || '',
      nombre: sessionStorage.getItem('responsable_name') || ''
    },
    titulo:   `${esFactura ? 'Factura' : 'Adjunto'} en OC ${oc.nroOC} — ${oc.proveedor?.nombre || 'Sin proveedor'}`,
    detalle:  `${file.name} · ${oc.obra || 'Sin obra'}`,
    driveUrl: fid ? `https://drive.google.com/drive/folders/${fid}` : ''
  });
}

async function doAttachPick(file, oc) {
  if (!file || !oc) return;
  const btn = document.querySelector(`.btn-attach-pick[data-nro="${oc.nroOC}"]`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Subiendo…'; }
  try {
    const subida = archivoParaDrive(file);
    const res = await attachToDriveOC(subida, {
      drive_folder_obras_id:       oc.drive_folder_obras_id       || null,
      drive_folder_proveedores_id: oc.drive_folder_proveedores_id || null,
      drive_folder_id:             oc.drive_folder_id             || null,
      obra:      oc.obra              || '',
      fecha:     displayToISODate(oc.fecha),
      proveedor: oc.proveedor?.nombre || '',
      nroOC:     oc.nroOC
    });
    logAdjuntoActivity(oc, subida, res?.folderId);
    await registrarAdjunto(oc, subida);
    refrescarBadge(oc);
    await clearShareFile();
    toast(`${tipoCarga === 'factura' ? 'Factura cargada' : 'Archivo cargado'} en OC ${oc.nroOC}`, 'success');
    if (btn) { btn.innerHTML = `${icSvg('checkSm')} Cargado`; }
  } catch (e) {
    console.error('doAttachPick:', e);
    toast('Error al subir el archivo a Drive.', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = 'Cargar'; }
  }
  pendingOC = null;
}

function bindButtons() {
  document.querySelectorAll('.btn-adj-attach').forEach(btn => {
    btn.addEventListener('click', async () => {
      const oc = allOCs.find(o => o.nroOC === btn.dataset.nro);
      if (oc && confirmarDuplicado(oc)) await doAttach(currentFile, oc, btn);
    });
  });

  const search = $('adj-search');
  if (search) {
    search.addEventListener('input', () => {
      const q      = search.value.toLowerCase().trim();
      const list   = $('adj-oc-list');
      const result = q
        ? allOCs.filter(oc =>
            (oc.proveedor?.nombre || '').toLowerCase().includes(q) ||
            (oc.obra || '').toLowerCase().includes(q) ||
            (oc.nroOC || '').toLowerCase().includes(q))
        : allOCs;
      list.innerHTML = renderOCListItems(result);
      bindButtons();
    });
  }
}

function showAIResults(extracted, matches) {
  $('result-title').textContent = 'Resultados del análisis';

  let html = '<div class="adj-extracted">';
  if (extracted.proveedor)       html += `<span class="adj-tag">${icSvg('building')} ${esc(extracted.proveedor)}</span>`;
  if (extracted.total_documento) html += `<span class="adj-tag">${icSvg('dollar')} $${fmtMoney(extracted.total_documento)}</span>`;
  html += '</div>';

  if (matches.length === 0) {
    html += '<p class="adj-no-match">No se encontraron coincidencias. Elegí una OC manualmente:</p>';
    html += renderManualListHTML(allOCs);
  } else {
    html += '<p class="adj-section-label">OC recomendadas:</p>';
    html += renderMatchCards(matches);
    html += `<div class="adj-manual-fallback">
      <button class="btn btn-outline btn-sm" id="btn-show-manual">Ver todas las OC</button>
    </div>`;
  }

  $('result-body').innerHTML = html;
  bindButtons();

  $('btn-show-manual')?.addEventListener('click', () => {
    $('result-title').textContent = 'Elegir OC';
    $('result-body').innerHTML = renderManualListHTML(allOCs);
    bindButtons();
  });
}

function showManualMode() {
  $('result-title').textContent = 'Elegir OC';
  $('result-body').innerHTML = renderManualListHTML(allOCs);
  bindButtons();
}

// ---- Attach ----

async function doAttach(file, oc, btn) {
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Subiendo…';
  try {
    const subida = archivoParaDrive(file);
    const res = await attachToDriveOC(subida, {
      drive_folder_obras_id:       oc.drive_folder_obras_id       || null,
      drive_folder_proveedores_id: oc.drive_folder_proveedores_id || null,
      drive_folder_id:             oc.drive_folder_id             || null,
      obra:      oc.obra              || '',
      fecha:     displayToISODate(oc.fecha),
      proveedor: oc.proveedor?.nombre || '',
      nroOC:     oc.nroOC
    });
    logAdjuntoActivity(oc, subida, res?.folderId);
    await registrarAdjunto(oc, subida);
    await clearShareFile();
    $('card-result').classList.add('hidden');
    $('success-detail').textContent = `${subida.name} → OC ${oc.nroOC} (${oc.proveedor?.nombre || ''})`;
    $('card-success').classList.remove('hidden');
  } catch (e) {
    toast('Error al subir el archivo a Drive.', 'error');
    console.error('doAttach:', e);
    btn.disabled    = false;
    btn.textContent = 'Cargar acá';
  }
}

// ---- Reset ----

function resetToStart() {
  resetZone();
  $('card-file').classList.remove('hidden');
  $('card-result').classList.add('hidden');
  $('card-success').classList.add('hidden');
  renderPrimaryList($('adj-search-main').value);   // la OC recién cargada cambió de sello
}

// ---- Init ----

document.addEventListener('DOMContentLoaded', async () => {
  const code = sessionStorage.getItem('responsable_code') || localStorage.getItem('responsable_code');
  const name = sessionStorage.getItem('responsable_name') || localStorage.getItem('responsable_name');
  if (!code || !name) { window.location.href = 'index.html'; return; }
  sessionStorage.setItem('responsable_code', code);
  sessionStorage.setItem('responsable_name', name);

  $('hdr-name').textContent = name;
  $('btn-back').addEventListener('click', () => { window.location.href = 'compras.html'; });
  $('btn-restart').addEventListener('click', resetToStart);
  $('btn-another').addEventListener('click', resetToStart);

  // Cargar historial y renderizar la lista principal.
  // El super-admin (0000) y los usuarios admin ven todas las OC.
  let isAdmin = code === '0000';
  if (!isAdmin) {
    try { const u = await getUsuario(code); isAdmin = !!(u && u.admin); } catch (_) {}
  }
  viewerIsAdmin = isAdmin;
  getHistorial(code, isAdmin)
    .then(async ocs => {
      allOCs = ocs;
      renderPrimaryList($('adj-search-main').value);
      // Primera vez tras el deploy: reconstruir el estado de las OC viejas a
      // partir del feed de Novedades. Después de eso ya viene en el historial.
      const sembrado = await sembrarAdjuntosDesdeActividad(ocs);
      if (sembrado) {
        allOCs.forEach(oc => {
          const reg = sembrado[String(oc.nroOC).replace(/-/g, '')];
          if (reg) oc.adjuntos = { ...reg, ...(oc.adjuntos || {}) };
        });
        renderPrimaryList($('adj-search-main').value);
      }
    })
    .catch(() => {
      const cached = typeof getHistorialCached === 'function' ? getHistorialCached(code) : null;
      if (cached) allOCs = cached;
      renderPrimaryList($('adj-search-main').value);
    });

  // Qué se está cargando (define el prefijo del archivo en Drive)
  $('adj-tipo').addEventListener('click', ev => {
    const btn = ev.target.closest('.cat-seg-btn');
    if (!btn) return;
    tipoCarga = btn.dataset.tipo;
    $('adj-tipo').querySelectorAll('.cat-seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  });

  // Filtro por estado de factura
  $('adj-filtro').addEventListener('click', ev => {
    const btn = ev.target.closest('.rem-tab');
    if (!btn) return;
    filtroOC = btn.dataset.filtro;
    $('adj-filtro').querySelectorAll('.rem-tab').forEach(b => b.classList.toggle('active', b === btn));
    pager.reset('adj');
    renderPrimaryList($('adj-search-main').value);
  });

  // Buscador de la lista principal
  $('adj-search-main').addEventListener('input', e => {
    pager.reset('adj');   // búsqueda nueva → volver a la primera página
    renderPrimaryList(e.target.value);
  });

  // Adjuntar manual: archivo elegido tras tocar "Adjuntar" en una OC
  $('manual-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f && pendingOC) doAttachPick(f, pendingOC);
  });

  // Foto sacada desde una OC de la lista: escáner y, si no se cancela, sube
  $('manual-camera').addEventListener('change', async e => {
    const f  = e.target.files[0];
    const oc = pendingOC;
    e.target.value = '';   // sacar dos veces la misma foto vuelve a disparar change
    if (!f || !oc) return;
    const scan = await escanear(f);
    if (scan) doAttachPick(scan, oc);
    else pendingOC = null;   // canceló el escaneo: no se sube nada
  });

  // Toggle del flujo IA (secundario)
  $('btn-toggle-ai').addEventListener('click', () => {
    $('card-file').classList.remove('hidden');
    $('card-file').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('btn-close-ai').addEventListener('click', () => {
    $('card-file').classList.add('hidden');
    $('card-result').classList.add('hidden');
    $('card-success').classList.add('hidden');
    resetZone();
  });

  // Archivo compartido por share target → abre el flujo IA con el archivo cargado
  const sharedFile = await checkShareFile();
  if (sharedFile) { $('card-file').classList.remove('hidden'); setFile(sharedFile); }

  // Botones de selección
  const fileInput   = $('file-input');
  const cameraInput = $('camera-input');

  if (ES_MOBILE) {
    $('btn-camera').classList.remove('hidden');
  }

  $('btn-select-file').addEventListener('click', () => fileInput.click());
  $('btn-camera').addEventListener('click', () => cameraInput.click());

  // Archivo elegido a mano: se usa tal cual (puede ser un PDF). Si es imagen,
  // queda disponible para escanearla desde el preview.
  function elegirArchivo(file) {
    if (!file) return;
    rawFile = file.type.startsWith('image/') ? file : null;
    setFile(file);
  }

  fileInput.addEventListener('change', () => elegirArchivo(fileInput.files[0]));

  // Foto de cámara: pasa por el escáner antes de quedar cargada
  cameraInput.addEventListener('change', async () => {
    const f = cameraInput.files[0];
    cameraInput.value = '';
    if (!f) return;
    rawFile = f;
    const scan = await escanear(f);
    if (scan) setFile(scan);   // null = canceló: no cambia nada
  });

  $('btn-file-rescan').addEventListener('click', async () => {
    const base = rawFile || currentFile;
    if (!base) return;
    const scan = await escanear(base);
    if (scan) setFile(scan);
  });

  // Drag & drop (desktop)
  const importZone = $('import-zone');
  importZone.addEventListener('dragover', e => { e.preventDefault(); importZone.classList.add('drag-over'); });
  importZone.addEventListener('dragleave', () => importZone.classList.remove('drag-over'));
  importZone.addEventListener('drop', e => {
    e.preventDefault();
    importZone.classList.remove('drag-over');
    elegirArchivo(e.dataTransfer.files[0]);
  });

  $('btn-change-file').addEventListener('click', resetZone);

  $('btn-use-ai').addEventListener('click', async () => {
    if (!currentFile) return;
    $('card-file').classList.add('hidden');
    $('card-result').classList.remove('hidden');
    $('result-title').textContent = 'Analizando con IA…';
    $('result-body').innerHTML    = `<div class="extract-status loading"><div class="spinner"></div> Analizando el documento…</div>`;
    try {
      const extracted = await extractBasicFromFile(currentFile);
      showAIResults(extracted, getTopMatches(extracted, allOCs));
    } catch (e) {
      $('result-title').textContent = 'No se pudo analizar';
      $('result-body').innerHTML    =
        `<div class="extract-status error" style="margin-bottom:1rem;">${esc(e.message)}</div>` +
        renderManualListHTML(allOCs);
      bindButtons();
    }
  });

  $('btn-use-manual').addEventListener('click', () => {
    if (!currentFile) return;
    $('card-file').classList.add('hidden');
    $('card-result').classList.remove('hidden');
    showManualMode();
  });
});
