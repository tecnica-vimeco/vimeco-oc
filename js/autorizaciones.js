/* VIMECO S.A. — Bandeja de Autorizaciones
   OC que otros usuarios enviaron para que este usuario las firme. */

const $ = id => document.getElementById(id);

let pendientes  = [];      // OC en estado 'pendiente' dirigidas a mí (para firmar)
let misPedidos  = [];      // OC cuya autorización pedí yo (para ver el estado)
let resueltas   = [];      // OC que ya autoricé o rechacé yo
let myCode      = '';
let myName      = '';
let myFirma     = null;    // base64 de mi firma (o null si no tengo)
let currentOC   = null;    // OC abierta en la vista previa
let pendingSign = null;    // OC a firmar tras dibujar firma en el momento



function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeStr(str) {
  return (str || '').replace(/[^\w\s\-\.]/g, '_').substring(0, 60).trim();
}

function fmtMoney(n) {
  return (parseFloat(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---- Reconstrucción de los datos de la OC para el PDF ----
// Los pendientes guardan el payload completo (_payload); si faltara (registros
// viejos), se reconstruye desde los campos sueltos como en el historial.
function ocDataFromRecord(oc) {
  if (oc._payload) return { ...oc._payload };
  const prov = oc.proveedor || {};
  return {
    nroOC:    oc.nroOC,
    fecha:    oc.fecha,
    moneda:   oc.moneda || 'ARS',
    ejecutor: oc.responsable?.nombre || '',
    proveedor: {
      nombre:    prov.nombre       || '',
      cuit:      prov.cuit         || '',
      codigoInterno: prov.codigoInterno || '',
      domicilio: prov.domicilio    || '',
      telefonos: prov.telefonos    || '',
      iva:       prov.condicionIVA || '',
      pago:      oc.condicionPago  || '',
      plazo:     '',
      lugar:     '',
      ref:       prov.ref          || '',
      ubicacion: oc.obra           || ''
    },
    items: (oc.items || []).map(it => ({
      desc: it.desc || '', unidad: it.unidad || '', cant: it.cant || 0,
      unitario: it.unitario || 0, total: it.total || 0
    })),
    impuestos:       oc.impuestos      || [],
    totalLetras:     numberToWords(oc.total || 0),
    _total:          oc.total          || 0,
    _firma:          null,
    _descuento:      oc.descuento      || { pct: null, monto: 0 },
    _noGravado:      oc.noGravado      || { pct: null, monto: 0 },
    _impuestosExtra: oc.impuestosExtra || []
  };
}

// ---- Render de la lista ----
function render() {
  const list = $('aut-list');
  $('aut-count').textContent = pendientes.length
    ? `${pendientes.length} pendiente${pendientes.length !== 1 ? 's' : ''}` : '';

  if (!pendientes.length) {
    list.innerHTML = '<div class="hist-empty">No tenés OC pendientes de autorización.</div>';
    return;
  }

  list.innerHTML = '';
  pendientes.forEach(oc => {
    const card = document.createElement('div');
    card.className = 'hist-card';
    const solicitante = oc.autorizacion?.solicitadoPor?.nombre || oc.responsable?.nombre || '—';
    const total = oc.total != null ? `$ ${fmtMoney(oc.total)}` : '—';
    card.innerHTML = `
      <div class="aut-card-top">
        <span class="aut-nro">${esc(oc.nroOC)}</span>
        <span class="aut-fecha">${esc(oc.fecha || '')}</span>
      </div>
      <div class="aut-prov">${esc(oc.proveedor?.nombre || '—')}</div>
      <div class="aut-obra">${esc(oc.obra || '—')}</div>
      <div class="aut-bottom">
        <span class="aut-total">${total}</span>
        <span class="aut-meta">Pide: ${esc(solicitante)}</span>
      </div>
      <div class="aut-actions">
        <button class="btn btn-sm btn-primary btn-revisar">Revisar y firmar</button>
        <button class="btn btn-sm btn-outline btn-rechazar-rapido">Rechazar</button>
      </div>`;
    card.querySelector('.btn-revisar').addEventListener('click', () => abrirPreview(oc));
    card.querySelector('.btn-rechazar-rapido').addEventListener('click', () => { currentOC = oc; abrirRechazo(); });
    list.appendChild(card);
  });
}

// ---- "Mis pedidos": estado de las OC que YO mandé a autorizar ----
const SEEN_KEY = () => 'vimeco_solicitudes_vistas_' + myCode;

function estadoPedido(oc) {
  if (oc.estado === 'autorizada') return ['aprob',  'Aprobada'];
  if (oc.estado === 'rechazada')  return ['rech',   'Rechazada'];
  return ['espera', 'En espera'];
}

// Resueltas (aprobada/rechazada) que todavía no vi — alimenta el globito.
function pedidosSinVer() {
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY()) || '[]'); } catch (_) {}
  return misPedidos.filter(oc =>
    (oc.estado === 'autorizada' || oc.estado === 'rechazada') && !seen.includes(oc._key)).length;
}

// Al abrir la bandeja se dan por vistas: el globito del menú se limpia.
function marcarPedidosVistos() {
  const resueltas = misPedidos
    .filter(oc => oc.estado === 'autorizada' || oc.estado === 'rechazada')
    .map(oc => oc._key);
  try {
    const prev   = JSON.parse(localStorage.getItem(SEEN_KEY()) || '[]');
    const merged = [...new Set([...prev, ...resueltas])];
    localStorage.setItem(SEEN_KEY(), JSON.stringify(merged));
  } catch (_) {}
}

function renderPedidos() {
  const list = $('ped-list');
  $('ped-count').textContent = misPedidos.length
    ? `${misPedidos.length} pedido${misPedidos.length !== 1 ? 's' : ''}` : '';

  if (!misPedidos.length) {
    list.innerHTML = '<div class="hist-empty">No mandaste ninguna OC a autorizar.</div>';
    return;
  }

  list.innerHTML = '';
  misPedidos.forEach(oc => {
    const [cls, txt] = estadoPedido(oc);
    const a     = oc.autorizacion || {};
    const total = oc.total != null ? `$ ${fmtMoney(oc.total)}` : '—';
    const quien = a.solicitadoA?.nombre || '—';
    let extra = '';
    if (oc.estado === 'rechazada' && a.motivoRechazo) {
      extra = `<div class="aut-motivo">Motivo: ${esc(a.motivoRechazo)}</div>`;
    } else if (oc.estado === 'autorizada' && a.firmante) {
      extra = `<div class="aut-meta">Firmó: ${esc(a.firmante)}</div>`;
    }
    const card = document.createElement('div');
    card.className = 'hist-card';
    card.innerHTML = `
      <div class="aut-card-top">
        <span class="aut-nro">${esc(oc.nroOC)}</span>
        <span class="aut-estado aut-estado-${cls}">${txt}</span>
      </div>
      <div class="aut-prov">${esc(oc.proveedor?.nombre || '—')}</div>
      <div class="aut-obra">${esc(oc.obra || '—')}</div>
      <div class="aut-bottom">
        <span class="aut-total">${total}</span>
        <span class="aut-meta">A: ${esc(quien)}</span>
      </div>
      ${extra}`;
    list.appendChild(card);
  });
}

// ---- "Autorizadas": OC que YA resolví (firmé o rechacé) ----
function renderResueltas() {
  const list = $('res-list');
  const firmadas = resueltas.filter(oc => oc.estado === 'autorizada').length;
  $('res-count').textContent = firmadas
    ? `${firmadas} autorizada${firmadas !== 1 ? 's' : ''}` : '';

  if (!resueltas.length) {
    list.innerHTML = '<div class="hist-empty">Todavía no autorizaste ninguna OC.</div>';
    return;
  }

  list.innerHTML = '';
  resueltas.forEach(oc => {
    const [cls, txt] = estadoPedido(oc);
    const a       = oc.autorizacion || {};
    const total   = oc.total != null ? `$ ${fmtMoney(oc.total)}` : '—';
    const quien   = a.solicitadoPor?.nombre || oc.responsable?.nombre || '—';
    const cuando  = a.resueltoEn ? new Date(a.resueltoEn).toLocaleDateString('es-AR') : (oc.fecha || '');
    let extra = '';
    if (oc.estado === 'rechazada' && a.motivoRechazo) {
      extra = `<div class="aut-motivo">Motivo: ${esc(a.motivoRechazo)}</div>`;
    }
    const card = document.createElement('div');
    card.className = 'hist-card';
    card.innerHTML = `
      <div class="aut-card-top">
        <span class="aut-nro">${esc(oc.nroOC)}</span>
        <span class="aut-estado aut-estado-${cls}">${txt}</span>
      </div>
      <div class="aut-prov">${esc(oc.proveedor?.nombre || '—')}</div>
      <div class="aut-obra">${esc(oc.obra || '—')}</div>
      <div class="aut-bottom">
        <span class="aut-total">${total}</span>
        <span class="aut-meta">Pidió: ${esc(quien)}${cuando ? ' · ' + esc(cuando) : ''}</span>
      </div>
      ${extra}
      <div class="aut-actions">
        <button class="btn btn-sm btn-outline btn-ver">Ver PDF</button>
      </div>`;
    card.querySelector('.btn-ver').addEventListener('click', () => abrirPreview(oc, true));
    list.appendChild(card);
  });
}

// Al resolver una OC pasa de "Para firmar" a "Autorizadas" sin recargar.
function agregarAResueltas(oc, estado, aut) {
  resueltas.unshift({ ...oc, estado, autorizacion: aut });
  renderResueltas();
}

// ---- Tabs ----
function showTab(tab) {
  ['firmar', 'pedidos', 'resueltas'].forEach(t => {
    $('pane-' + t).classList.toggle('hidden', t !== tab);
    $('tab-' + t).classList.toggle('active', t === tab);
  });
}

function setTabCounts(sinVer) {
  const nf = $('n-firmar'), np = $('n-pedidos');
  if (pendientes.length) { nf.textContent = pendientes.length; nf.classList.remove('hidden'); }
  else nf.classList.add('hidden');
  if (sinVer) { np.textContent = sinVer; np.classList.remove('hidden'); }
  else np.classList.add('hidden');
}

// ---- Vista previa ----
function abrirPreview(oc, soloLectura) {
  currentOC = soloLectura ? null : oc;
  let blob;
  try {
    blob = generateOCBlob(ocDataFromRecord(oc));
  } catch (e) {
    toast('No se pudo generar la vista previa.', 'error');
    console.error('preview:', e);
    return;
  }
  const blobUrl  = URL.createObjectURL(blob);
  const modal    = $('modal-preview');
  const isMobile = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;

  $('preview-title').textContent = `OC N° ${oc.nroOC}`;
  const body = $('preview-body');
  body.innerHTML = '';
  if (isMobile) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:2rem;text-align:center;';
    wrap.innerHTML = `
      <p style="margin-bottom:1.25rem;color:var(--gray-600);">Abrí el PDF para revisarlo antes de firmar.</p>
      <a href="${blobUrl}" target="_blank" class="btn btn-primary">Abrir PDF en nueva pestaña</a>`;
    body.appendChild(wrap);
  } else {
    const iframe = document.createElement('iframe');
    iframe.src = blobUrl;
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
    body.appendChild(iframe);
  }

  // Link al archivo fuente (presupuesto/factura) si el solicitante lo adjuntó.
  const fuente = $('preview-fuente');
  if (oc.fuenteUrl) { fuente.href = oc.fuenteUrl; fuente.classList.remove('hidden'); }
  else { fuente.classList.add('hidden'); }

  // Las ya resueltas se abren solo para mirarlas.
  $('preview-firmar').classList.toggle('hidden', !!soloLectura);
  $('preview-rechazar').classList.toggle('hidden', !!soloLectura);

  modal.dataset.blobUrl = blobUrl;
  modal.classList.remove('hidden');
}

function cerrarPreview() {
  const modal   = $('modal-preview');
  const blobUrl = modal.dataset.blobUrl;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); delete modal.dataset.blobUrl; }
  $('preview-body').innerHTML = '';
  modal.classList.add('hidden');
}

// ---- Firmar y autorizar ----
async function firmarOC(oc) {
  if (!oc) return;
  if (!myFirma) { pendingSign = oc; openFirmaModal(); return; }

  const btn = $('preview-firmar');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Autorizando…'; }

  const ocData = ocDataFromRecord(oc);
  ocData._firma    = myFirma;   // firma del autorizador
  ocData._firmante = myName;    // nombre del autorizador bajo la firma
  // ocData.ejecutor queda igual = creador de la OC

  let blob;
  try {
    blob = generateOCBlob(ocData);
  } catch (e) {
    toast('Error al generar el PDF.', 'error');
    console.error('firmarOC/pdf:', e);
    if (btn) { btn.disabled = false; btn.innerHTML = 'Firmar y autorizar'; }
    return;
  }

  const fname = `OC_${oc.nroOC}_${sanitizeStr(ocData.proveedor.nombre || 'SinProveedor')}.pdf`;
  const meta  = {
    obra:      oc.obra || ocData.proveedor.ubicacion || 'Sin obra',
    fecha:     (oc.timestamp ? new Date(oc.timestamp) : new Date()).toISOString().slice(0, 10),
    proveedor: ocData.proveedor.nombre || 'Sin proveedor',
    nroOC:     oc.nroOC,
    obrasFolderId:       oc.drive_folder_obras_id       || null,
    proveedoresFolderId: oc.drive_folder_proveedores_id || null
  };

  let folderIds = {};
  try {
    if (typeof uploadPdfToDrive === 'function') folderIds = await uploadPdfToDrive(blob, fname, meta);
  } catch (e) {
    console.warn('uploadPdfToDrive:', e);
    toast('OC autorizada, pero no se pudo subir el PDF a Drive.', 'warning');
  }

  const nuevaAut = {
    ...(oc.autorizacion || {}),
    resueltoEn:  Date.now(),
    firmaCodigo: myCode,
    firmante:    myName,
    motivoRechazo: null
  };
  try {
    await patchHistorialEntry(oc.nroOC.replace(/-/g, ''), {
      estado: 'autorizada',
      autorizacion: nuevaAut,
      drive_folder_obras_id:       folderIds.obrasFolderId       || oc.drive_folder_obras_id       || null,
      drive_folder_proveedores_id: folderIds.proveedoresFolderId || oc.drive_folder_proveedores_id || null
    });
  } catch (e) {
    toast('No se pudo actualizar el estado de la OC.', 'error');
    console.error('firmarOC/patch:', e);
    if (btn) { btn.disabled = false; btn.innerHTML = 'Firmar y autorizar'; }
    return;
  }

  if (typeof logOCActivity === 'function') {
    const folderId = folderIds.obrasFolderId || folderIds.proveedoresFolderId ||
                      oc.drive_folder_obras_id || oc.drive_folder_proveedores_id;
    logOCActivity(oc.nroOC, ocData.proveedor.nombre, oc.obra, oc.total, folderId);
  }

  quitarDeLista(oc);
  agregarAResueltas(oc, 'autorizada', nuevaAut);
  cerrarPreview();
  if (btn) { btn.disabled = false; btn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Firmar y autorizar'; }
  toast(`OC ${oc.nroOC} autorizada.`, 'success');
}

// ---- Rechazar ----
function abrirRechazo() {
  $('rechazo-motivo').value = '';
  $('modal-rechazo').classList.remove('hidden');
}
function cerrarRechazo() { $('modal-rechazo').classList.add('hidden'); }

async function rechazarOC(oc, motivo) {
  const nuevaAut = {
    ...(oc.autorizacion || {}),
    resueltoEn:    Date.now(),
    motivoRechazo: motivo || ''
  };
  try {
    await patchHistorialEntry(oc.nroOC.replace(/-/g, ''), { estado: 'rechazada', autorizacion: nuevaAut });
  } catch (e) {
    toast('No se pudo rechazar la OC.', 'error');
    console.error('rechazarOC:', e);
    return;
  }
  quitarDeLista(oc);
  agregarAResueltas(oc, 'rechazada', nuevaAut);
  cerrarRechazo();
  cerrarPreview();
  toast(`OC ${oc.nroOC} rechazada.`, 'info');
}

function quitarDeLista(oc) {
  pendientes = pendientes.filter(p => p.nroOC !== oc.nroOC);
  render();
}

// ---- Firma (canvas) ----
let _firmaDrawing = false, _firmaLX = 0, _firmaLY = 0;

function openFirmaModal() {
  const canvas = $('firma-canvas');
  const ctx    = canvas.getContext('2d');
  if (!canvas._ready) {
    canvas.width = 560; canvas.height = 200; canvas._ready = true;
    function pos(e) {
      const r  = canvas.getBoundingClientRect();
      const sx = canvas.width / r.width, sy = canvas.height / r.height;
      const s  = e.touches ? e.touches[0] : e;
      return { x: (s.clientX - r.left) * sx, y: (s.clientY - r.top) * sy };
    }
    function stroke(e) {
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(_firmaLX, _firmaLY); ctx.lineTo(p.x, p.y); ctx.stroke();
      _firmaLX = p.x; _firmaLY = p.y;
    }
    canvas.addEventListener('mousedown',  e => { _firmaDrawing = true; const p = pos(e); _firmaLX = p.x; _firmaLY = p.y; });
    canvas.addEventListener('mousemove',  e => { if (_firmaDrawing) stroke(e); });
    canvas.addEventListener('mouseup',    () => _firmaDrawing = false);
    canvas.addEventListener('mouseleave', () => _firmaDrawing = false);
    canvas.addEventListener('touchstart', e => { e.preventDefault(); _firmaDrawing = true; const p = pos(e); _firmaLX = p.x; _firmaLY = p.y; }, { passive: false });
    canvas.addEventListener('touchmove',  e => { e.preventDefault(); if (_firmaDrawing) stroke(e); }, { passive: false });
    canvas.addEventListener('touchend',   () => _firmaDrawing = false);
  }
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1a3a5c'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (myFirma) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = myFirma;
  }
  $('modal-firma').classList.remove('hidden');
}

function setupFirmaModal() {
  $('modal-firma-close').addEventListener('click', () => { $('modal-firma').classList.add('hidden'); pendingSign = null; });
  $('btn-firma-limpiar').addEventListener('click', () => {
    const canvas = $('firma-canvas');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  });
  $('btn-firma-guardar').addEventListener('click', async () => {
    const canvas = $('firma-canvas');
    const base64 = canvas.toDataURL('image/png');
    const btn = $('btn-firma-guardar');
    btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      await saveFirma(myCode, base64);
      myFirma = base64;
      $('modal-firma').classList.add('hidden');
      toast('Firma guardada.', 'success');
      const oc = pendingSign; pendingSign = null;
      if (oc) firmarOC(oc);   // continúa con la autorización
    } catch {
      toast('Error al guardar la firma.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Guardar y autorizar';
    }
  });
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', async () => {
  let sess = null;
  try { sess = JSON.parse(localStorage.getItem('vimeco_session')); } catch (_) {}
  myCode = sessionStorage.getItem('responsable_code') || localStorage.getItem('responsable_code') || sess?.codigo || '';
  myName = sessionStorage.getItem('responsable_name') || localStorage.getItem('responsable_name') || sess?.nombre || '';
  if (!myCode) { window.location.href = 'index.html'; return; }
  sessionStorage.setItem('responsable_code', myCode);
  sessionStorage.setItem('responsable_name', myName);

  $('hdr-name').textContent = myName || '';
  $('btn-back').addEventListener('click', () => { window.location.href = 'menu.html'; });
  // Modales
  $('modal-preview-close').addEventListener('click', cerrarPreview);
  $('modal-preview-close2').addEventListener('click', cerrarPreview);
  $('preview-firmar').addEventListener('click', () => firmarOC(currentOC));
  $('preview-rechazar').addEventListener('click', abrirRechazo);
  $('modal-rechazo-close').addEventListener('click', cerrarRechazo);
  $('btn-rechazo-cancel').addEventListener('click', cerrarRechazo);
  $('btn-rechazo-confirm').addEventListener('click', () => {
    if (currentOC) rechazarOC(currentOC, $('rechazo-motivo').value.trim());
  });
  setupFirmaModal();

  // Tabs
  $('tab-firmar').addEventListener('click', () => showTab('firmar'));
  $('tab-pedidos').addEventListener('click', () => showTab('pedidos'));
  $('tab-resueltas').addEventListener('click', () => showTab('resueltas'));

  // Mi firma (para autorizar sin volver a dibujarla)
  getFirma(myCode).then(f => { myFirma = f || null; }).catch(() => {});

  // Cargar ambas bandejas: lo que me piden firmar y lo que yo pedí.
  try {
    [pendientes, misPedidos, resueltas] = await Promise.all([
      getAutorizacionesPendientes(myCode),
      (typeof getMisSolicitudes === 'function' ? getMisSolicitudes(myCode) : Promise.resolve([])).catch(() => []),
      (typeof getAutorizacionesResueltas === 'function' ? getAutorizacionesResueltas(myCode) : Promise.resolve([])).catch(() => [])
    ]);
  } catch (e) {
    $('aut-list').innerHTML = '<div class="hist-empty">No se pudieron cargar las autorizaciones. Revisá tu conexión.</div>';
    console.error('getAutorizacionesPendientes:', e);
    return;
  }

  const sinVer = pedidosSinVer();   // antes de marcarlos vistos
  render();
  renderPedidos();
  renderResueltas();
  setTabCounts(sinVer);
  // Abre en la pestaña con algo para hacer: firmar si tengo pendientes, si no mis pedidos.
  showTab(pendientes.length ? 'firmar' : (misPedidos.length ? 'pedidos' : 'firmar'));
  marcarPedidosVistos();
});
