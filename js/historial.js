/* VIMECO S.A. — Historial de Órdenes de Compra */

let allOCs = [];
let viewerIsAdmin = false;   // 0000 o usuario con permiso admin

const $ = id => document.getElementById(id);



function fmtMoney(n) {
  return (parseFloat(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Badge de estado de autorización. Las OC viejas (sin `estado`) se consideran emitidas.
function estadoBadge(oc) {
  const e = oc.estado || 'emitida';
  const base = 'display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.72rem;font-weight:700;';
  if (e === 'pendiente') {
    const quien = oc.autorizacion?.solicitadoA?.nombre;
    return `<span style="${base}background:#fff4e0;color:#9a6a00;">Pendiente${quien ? ' — ' + esc(quien) : ''}</span>`;
  }
  if (e === 'autorizada') {
    const quien = oc.autorizacion?.firmante;
    return `<span style="${base}background:#e3f5e8;color:#1e7d3a;">Autorizada${quien ? ' — ' + esc(quien) : ''}</span>`;
  }
  if (e === 'rechazada') {
    const motivo = oc.autorizacion?.motivoRechazo;
    return `<span style="${base}background:#fde6e6;color:#b02a2a;" title="${esc(motivo || '')}">Rechazada</span>`;
  }
  return '';
}

// Estado de entrega, espejado en la OC por Remitos (`entrega.estado`). Las OC
// sin remitos no muestran nada: sólo se avisa de lo que ya empezó a llegar.
function entregaBadge(oc) {
  const e = oc.entrega?.estado;
  if (!e || e === 'sin') return '';
  const base = 'display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.72rem;font-weight:700;';
  if (e === 'parcial')
    return `<span style="${base}background:#fff4e0;color:#9a6a00;">Entrega parcial</span>`;
  return `<span style="${base}background:#e3f5e8;color:#1e7d3a;">Entregada</span>`;
}

function renderCards(ocs) {
  const isAdmin = viewerIsAdmin;
  const list = $('hist-list');

  $('hist-count').textContent = ocs.length === 0 ? '' : `${ocs.length} orden${ocs.length !== 1 ? 'es' : ''}`;

  if (ocs.length === 0) {
    list.innerHTML = '<div class="hist-empty">No se encontraron órdenes de compra.</div>';
    return;
  }

  const canRegen = typeof generateOCBlob === 'function';

  list.innerHTML = '';
  // `hist-count` sigue mostrando el total del filtro; acá se pinta sólo la página.
  pager.take('hist', ocs).forEach(oc => {
    const card = document.createElement('div');
    card.className = 'hist-card';

    const provNombre = oc.proveedor?.nombre || '—';
    const obra       = oc.obra || '—';
    const total      = oc.total != null ? `$ ${fmtMoney(oc.total)}` : '—';
    const resp       = oc.responsable?.nombre || '';
    const badge      = estadoBadge(oc);
    const entrega    = entregaBadge(oc);
    // Las OC pendientes todavía no tienen PDF definitivo → no se descarga.
    const showRegen  = canRegen && oc.estado !== 'pendiente';

    card.innerHTML = `
      <div class="hist-card-top">
        <span class="hist-nro">${esc(oc.nroOC)}</span>
        <span class="hist-fecha">${esc(oc.fecha || '')}</span>
      </div>
      <div class="hist-proveedor">${esc(provNombre)}</div>
      <div class="hist-obra">${esc(obra)}</div>
      ${badge || entrega ? `<div style="margin-top:.35rem;display:flex;gap:.35rem;flex-wrap:wrap;">${badge}${entrega}</div>` : ''}
      <div class="hist-card-bottom">
        <span class="hist-total">${total}</span>
        ${isAdmin && resp ? `<span class="hist-responsable">${esc(resp)}</span>` : ''}
        <div class="hist-actions">
          ${showRegen ? `<button class="btn btn-sm btn-outline btn-regenerar" title="Regenerar y descargar PDF">${icSvg('print')}</button>` : ''}
          <button class="btn btn-sm btn-primary btn-usar-base" title="Cargar en formulario">Usar como base</button>
        </div>
      </div>`;

    card.querySelector('.btn-usar-base').addEventListener('click', () => usarComoBase(oc));

    if (showRegen) {
      const regenBtn = card.querySelector('.btn-regenerar');
      regenBtn.addEventListener('click', () => regenerarPDF(oc, regenBtn));
    }

    list.appendChild(card);
  });

  pager.footer('hist', list, ocs, () => renderCards(ocs));
}

function displayToISODate(d) {
  const p = (d || '').split('/');
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : (d || '');
}

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function sanitizeStr(str) {
  return (str || '').replace(/[^\w\s\-\.]/g, '_').substring(0, 60).trim();
}

// ---- Filtros ----
function applyFilters() {
  // Filtro nuevo → la lista es otra, se vuelve a la primera página.
  pager.reset('hist');
  const q     = ($('hist-search').value || '').toLowerCase().trim();
  const desde = $('hist-desde').value; // YYYY-MM-DD
  const hasta = $('hist-hasta').value;

  let result = allOCs;

  if (q) {
    result = result.filter(oc =>
      (oc.proveedor?.nombre || '').toLowerCase().includes(q) ||
      (oc.obra || '').toLowerCase().includes(q) ||
      (oc.nroOC || '').toLowerCase().includes(q)
    );
  }

  if (desde || hasta) {
    const desdeTs = desde ? new Date(desde + 'T00:00:00').getTime() : 0;
    const hastaTs = hasta ? new Date(hasta + 'T23:59:59').getTime() : Infinity;
    result = result.filter(oc => {
      const ts = oc.timestamp || 0;
      return ts >= desdeTs && ts <= hastaTs;
    });
    $('btn-clear-dates').classList.remove('hidden');
  } else {
    $('btn-clear-dates').classList.add('hidden');
  }

  renderCards(result);
}

// ---- Regenerar PDF ----
async function regenerarPDF(oc, btn) {
  btn.disabled = true;
  try {
    const prov = oc.proveedor || {};
    // Preferir el payload guardado (regenera el PDF idéntico al original);
    // si no está (registros viejos), reconstruir desde los campos sueltos.
    const ocData = oc._payload ? { ...oc._payload } : {
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
      rubro:       oc.rubro  || null,
      equipo:      oc.equipo || null,
      items: (oc.items || []).map(it => ({
        desc:    it.desc    || '',
        unidad:  it.unidad  || '',
        cant:    it.cant    || 0,
        unitario: it.unitario || 0,
        total:   it.total   || 0
      })),
      impuestos:       oc.impuestos      || [],
      totalLetras:     numberToWords(oc.total || 0),
      _total:          oc.total          || 0,
      _firma:          null,
      _descuento:      oc.descuento      || { pct: null, monto: 0 },
      _noGravado:      oc.noGravado      || { pct: null, monto: 0 },
      _impuestosExtra: oc.impuestosExtra || []
    };

    // OC autorizada por otro usuario → re-incrustar su firma y su nombre.
    if (oc.estado === 'autorizada' && oc.autorizacion) {
      ocData._firmante = oc.autorizacion.firmante || ocData.ejecutor;
      if (oc.autorizacion.firmaCodigo && typeof getFirma === 'function') {
        try { ocData._firma = await getFirma(oc.autorizacion.firmaCodigo); } catch (_) {}
      }
    }

    const blob  = generateOCBlob(ocData);
    const fname = `OC_${oc.nroOC}_${sanitizeStr(prov.nombre || 'SinProveedor')}.pdf`;

    const isMobile = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    if (isMobile && navigator.canShare) {
      const shareFile = new File([blob], fname, { type: 'application/pdf' });
      if (navigator.canShare({ files: [shareFile] })) {
        try {
          await navigator.share({ title: `OC ${oc.nroOC} — VIMECO S.A.`, files: [shareFile] });
          toast(`PDF de OC ${oc.nroOC} compartido.`, 'success');
          return;
        } catch (e) {
          if (e.name === 'AbortError') return;
          // otro error → caer al download
        }
      }
    }
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
    toast(`PDF de OC ${oc.nroOC} generado.`, 'success');
  } catch (e) {
    toast('Error al regenerar el PDF.', 'error');
    console.error('regenerarPDF:', e);
  } finally {
    btn.disabled = false;
  }
}

function usarComoBase(oc) {
  sessionStorage.setItem('oc_base', JSON.stringify(oc));
  window.location.href = 'app.html';
}

document.addEventListener('DOMContentLoaded', async () => {
  const code = sessionStorage.getItem('responsable_code') || localStorage.getItem('responsable_code');
  const name = sessionStorage.getItem('responsable_name') || localStorage.getItem('responsable_name');
  if (!code || !name) { window.location.href = 'index.html'; return; }
  sessionStorage.setItem('responsable_code', code);
  sessionStorage.setItem('responsable_name', name);

  $('hdr-name').textContent = name;

  $('btn-facturas').addEventListener('click', () => { window.location.href = 'facturas.html'; });
  $('btn-back').addEventListener('click',    () => { window.location.href = 'compras.html'; });
  $('hist-search').addEventListener('input',  applyFilters);
  $('hist-desde').addEventListener('change',  applyFilters);
  $('hist-hasta').addEventListener('change',  applyFilters);
  $('btn-clear-dates').addEventListener('click', () => {
    $('hist-desde').value = '';
    $('hist-hasta').value = '';
    applyFilters();
  });

  // Indicador de pendientes Drive
  if (typeof driveQueue !== 'undefined') {
    try {
      const pending = await driveQueue.getAll();
      if (pending.length > 0)
        toast(`${pending.length} OC${pending.length > 1 ? 's' : ''} pendiente${pending.length > 1 ? 's' : ''} de subir a Drive.`, 'warning');
    } catch (_) {}
  }

  let isAdmin = code === '0000';
  if (!isAdmin) {
    try { const u = await getUsuario(code); isAdmin = !!(u && u.admin); } catch (_) {}
  }
  viewerIsAdmin = isAdmin;

  try {
    allOCs = await getHistorial(code, isAdmin);
    renderCards(allOCs);
  } catch (e) {
    const cached = typeof getHistorialCached === 'function' ? getHistorialCached(code) : null;
    if (cached && cached.length) {
      allOCs = cached;
      renderCards(allOCs);
      $('hist-list').insertAdjacentHTML('afterbegin',
        `<div class="hist-offline-notice">${icSvg('wifi0')} Sin conexión — mostrando últimas 5 OC guardadas</div>`);
    } else {
      $('hist-list').innerHTML = '<div class="hist-empty">Sin conexión y sin datos locales. Abrí el historial con red al menos una vez.</div>';
    }
    console.error('getHistorial:', e);
  }
});
