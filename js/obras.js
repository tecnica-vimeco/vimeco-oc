/* VIMECO S.A. — Gestión de Obras (solo Admin) */

const $ = id => document.getElementById(id);



function showConfirm(title, msg) {
  return new Promise(resolve => {
    $('modal-confirm-title').textContent = title;
    $('modal-confirm-msg').textContent   = msg;
    const modal = $('modal-confirm');
    modal.classList.remove('hidden');
    $('modal-confirm-no').onclick  = () => { modal.classList.add('hidden'); resolve(false); };
    $('modal-confirm-yes').onclick = () => { modal.classList.add('hidden'); resolve(true); };
  });
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let allObras = [];
let allJefes = [];  // usuarios con rol jefeObra

// ---- Rubros de la obra en edición ----
// Se editan en memoria y recién se persisten al Guardar el modal.
let editingRubros   = [];     // [{ id, nombre, orden }]
let rubrosCerrados  = false;  // cerrada = las OC de la obra piden rubro

function nuevoRubroId(nombre) {
  const slug = String(nombre).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').substring(0, 30);
  return (slug || 'rubro') + '_' + Date.now().toString(36);
}

function renderRubros() {
  const cont   = $('obra-rubros-list');
  const badge  = $('obra-rubros-estado');
  const toggle = $('btn-toggle-rubros');

  badge.textContent = rubrosCerrados ? 'Lista cerrada' : 'Lista abierta';
  badge.className   = 'u-badge ' + (rubrosCerrados ? 'u-badge-activo' : 'u-badge-pwd-none');
  toggle.textContent = rubrosCerrados ? 'Reabrir lista para editar' : 'Cerrar lista';
  toggle.disabled    = !rubrosCerrados && !editingRubros.length;

  if (!editingRubros.length) {
    cont.innerHTML = '<span style="color:var(--gray-500);font-size:.85rem;">Todavía no hay rubros cargados.</span>';
    return;
  }

  // Con la lista cerrada el nombre no se edita (renombrar rompe la lectura de
  // las OC viejas): para eso hay que reabrirla.
  cont.innerHTML = editingRubros.map((r, i) => `
    <div style="display:flex;gap:.5rem;align-items:center;">
      <input type="text" class="form-control rubro-nombre" data-i="${i}" value="${esc(r.nombre)}"
        ${rubrosCerrados ? 'readonly' : ''}>
      <button type="button" class="btn btn-sm btn-danger btn-icon btn-del-rubro" data-i="${i}"
        aria-label="Quitar rubro" title="Quitar rubro">${icSvg('x')}</button>
    </div>
  `).join('');

  cont.querySelectorAll('.rubro-nombre').forEach(inp => {
    inp.addEventListener('input', () => { editingRubros[+inp.dataset.i].nombre = inp.value; });
  });
  cont.querySelectorAll('.btn-del-rubro').forEach(btn => {
    btn.addEventListener('click', () => quitarRubro(+btn.dataset.i));
  });
}

async function quitarRubro(i) {
  const r = editingRubros[i];
  if (!r) return;
  const ok = await showConfirm('Quitar rubro',
    `¿Quitar "${r.nombre}"? Las OC ya emitidas con ese rubro lo conservan, pero deja de ofrecerse en las OC nuevas.`);
  if (!ok) return;
  editingRubros.splice(i, 1);
  editingRubros.forEach((x, n) => { x.orden = n; });
  renderRubros();
}

function agregarRubro() {
  const input = $('rubro-nuevo');
  const nombre = input.value.trim();
  if (!nombre) return;
  const dup = editingRubros.some(r =>
    r.nombre.trim().toLowerCase() === nombre.toLowerCase());
  if (dup) { showToast('Ese rubro ya está en la lista.', 'error'); return; }
  editingRubros.push({ id: nuevoRubroId(nombre), nombre, orden: editingRubros.length });
  input.value = '';
  renderRubros();
  input.focus();
}

async function toggleCierreRubros() {
  if (!rubrosCerrados) {
    const vacios = editingRubros.some(r => !r.nombre.trim());
    if (vacios) { showToast('Hay rubros sin nombre.', 'error'); return; }
    const ok = await showConfirm('Cerrar lista de rubros',
      'A partir de ahora, toda OC nueva de esta obra va a tener que elegir un rubro. Podés reabrir la lista cuando quieras.');
    if (!ok) return;
    rubrosCerrados = true;
  } else {
    const ok = await showConfirm('Reabrir lista de rubros',
      'Mientras esté abierta, las OC nuevas de esta obra se emiten sin rubro.');
    if (!ok) return;
    rubrosCerrados = false;
  }
  renderRubros();
}

// Objeto para Firebase: { <id>: { nombre, orden } }. null si no quedó ninguno.
function rubrosParaGuardar() {
  const obj = {};
  editingRubros.forEach((r, i) => {
    const nombre = r.nombre.trim();
    if (nombre) obj[r.id] = { nombre, orden: i };
  });
  return Object.keys(obj).length ? obj : null;
}

async function loadJefes() {
  try {
    const usuarios = await getAllUsuarios();
    allJefes = usuarios
      .filter(u => u.jefeObra && u.activo)
      .map(u => ({ codigo: u.codigo, nombre: u.nombre }));
  } catch (_) {
    allJefes = [];
  }
}

function renderJefesChecklist(seleccionados) {
  const cont = $('obra-jefes-list');
  const sel = seleccionados || {};
  if (!allJefes.length) {
    cont.innerHTML = '<span style="color:var(--gray-500);font-size:.85rem;">No hay usuarios con rol Jefe de Obra. Asigná el rol desde Usuarios.</span>';
    return;
  }
  cont.innerHTML = allJefes.map(j => `
    <label style="display:flex;align-items:center;gap:.5rem;padding:.25rem 0;cursor:pointer;">
      <input type="checkbox" class="obra-jefe-chk" value="${esc(j.codigo)}" ${sel[j.codigo] ? 'checked' : ''}>
      <span>${esc(j.nombre)} <span style="color:var(--gray-400);">(${esc(j.codigo)})</span></span>
    </label>
  `).join('');
}

function getJefesSeleccionados() {
  const obj = {};
  document.querySelectorAll('.obra-jefe-chk:checked').forEach(chk => { obj[chk.value] = true; });
  return obj;
}

function renderObras(list) {
  const container = $('obras-list');
  if (!list.length) {
    container.innerHTML = '<div class="hist-empty">No hay obras cargadas.</div>';
    return;
  }
  container.innerHTML = list.map(o => {
    const nRubros = rubrosList(o.rubros).length;
    const rubrosBadge = o.rubrosCerrados
      ? `<span class="u-badge u-badge-pwd-ok">${nRubros} rubro${nRubros !== 1 ? 's' : ''}</span>`
      : `<span class="u-badge u-badge-pwd-none">${nRubros ? `${nRubros} rubro${nRubros !== 1 ? 's' : ''} sin cerrar` : 'Sin rubros'}</span>`;
    return `
    <div class="user-card ${o.activa ? '' : 'user-card--inactive'}">
      <div class="user-card-info">
        <span class="user-card-name">${esc(o.nombre)}</span>
        ${o.lugar_entrega ? `<span style="font-size:.8rem;color:var(--gray-500);">${esc(o.lugar_entrega)}</span>` : ''}
        <span class="u-badge ${o.activa ? 'u-badge-activo' : 'u-badge-inactivo'}">${o.activa ? 'Activa' : 'Inactiva'}</span>
        ${rubrosBadge}
      </div>
      <div class="user-card-actions">
        <button class="btn btn-sm btn-outline btn-edit-obra">Editar</button>
        <button class="btn btn-sm ${o.activa ? 'btn-danger' : 'btn-success'} btn-toggle-obra">
          ${o.activa ? 'Desactivar' : 'Activar'}
        </button>
      </div>
    </div>
  `; }).join('');

  container.querySelectorAll('.user-card').forEach((card, i) => {
    const o = list[i];
    card.querySelector('.btn-edit-obra').addEventListener('click', () => editObra(o.key));
    card.querySelector('.btn-toggle-obra').addEventListener('click', () =>
      toggleActiva(o.key, o.activa, o.nombre));
  });
}

async function loadObras() {
  try {
    allObras = await getAllObras();
    renderObras(allObras);
  } catch (_) {
    $('obras-list').innerHTML = '<div class="hist-empty">Error al cargar obras.</div>';
  }
}

let editingKey = null;

function openAddModal() {
  editingKey = null;
  $('modal-obra-title').textContent = 'Agregar obra';
  $('modal-obra-error').classList.add('hidden');
  $('obra-nombre').value   = '';
  $('obra-lugar').value    = '';
  $('obra-jornada').value  = '8';
  $('obra-comida').value   = '';
  $('rubro-nuevo').value   = '';
  editingRubros  = [];
  rubrosCerrados = false;
  renderRubros();
  renderJefesChecklist({});
  $('modal-obra').classList.remove('hidden');
  setTimeout(() => $('obra-nombre').focus(), 50);
}

window.editObra = function (key) {
  const obra = allObras.find(o => o.key === key) || {};
  editingKey = key;
  $('modal-obra-title').textContent = 'Editar obra';
  $('modal-obra-error').classList.add('hidden');
  $('obra-nombre').value  = obra.nombre || '';
  $('obra-lugar').value   = obra.lugar_entrega || '';
  const c = obra.constantes || {};
  $('obra-jornada').value = (c.jornadaHoras ?? 8);
  $('obra-comida').value  = (c.valorComida ?? '');
  $('rubro-nuevo').value  = '';
  editingRubros  = rubrosList(obra.rubros);
  rubrosCerrados = !!obra.rubrosCerrados;
  renderRubros();
  renderJefesChecklist(obra.jefes || {});
  $('modal-obra').classList.remove('hidden');
  setTimeout(() => $('obra-nombre').focus(), 50);
};

async function saveObraModal() {
  const nombre = $('obra-nombre').value.trim();
  const lugar  = $('obra-lugar').value.trim();
  const errEl  = $('modal-obra-error');

  if (!nombre) {
    errEl.textContent = 'El nombre es requerido.';
    errEl.classList.remove('hidden');
    return;
  }

  const jornadaHoras = parseFloat($('obra-jornada').value) || 0;
  const valorComida  = parseFloat($('obra-comida').value)  || 0;
  const constantes   = { jornadaHoras, valorComida };
  const jefes        = getJefesSeleccionados();
  const rubros       = rubrosParaGuardar();
  // Sin rubros no hay lista que cerrar: el flag no puede quedar en true.
  const cerrados     = !!(rubros && rubrosCerrados);

  const saveBtn = $('modal-obra-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando…';

  try {
    if (editingKey) {
      await patchObra(editingKey, {
        nombre, lugar_entrega: lugar, constantes, jefes,
        rubros, rubrosCerrados: cerrados
      });
    } else {
      const key = nombre.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').substring(0, 40)
        + '_' + Date.now();
      await saveObra(key, {
        nombre, lugar_entrega: lugar, activa: true, creadaEn: Date.now(), constantes, jefes,
        rubros, rubrosCerrados: cerrados
      });
    }
    $('modal-obra').classList.add('hidden');
    showToast(editingKey ? 'Obra actualizada.' : 'Obra creada.');
    await loadObras();
  } catch (_) {
    errEl.textContent = 'Error al guardar. Intentá de nuevo.';
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Guardar';
  }
}

window.toggleActiva = async function (key, activa, nombre) {
  const ok = await showConfirm(
    activa ? 'Desactivar obra' : 'Activar obra',
    activa
      ? `¿Desactivar "${nombre}"? No aparecerá en el desplegable de nuevas OC.`
      : `¿Activar "${nombre}"?`
  );
  if (!ok) return;
  try {
    await patchObra(key, { activa: !activa });
    showToast(`Obra ${activa ? 'desactivada' : 'activada'}.`);
    await loadObras();
  } catch (_) {
    showToast('Error al actualizar la obra.', 'error');
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const code = sessionStorage.getItem('responsable_code') || localStorage.getItem('responsable_code');
  const name = sessionStorage.getItem('responsable_name') || localStorage.getItem('responsable_name');
  if (!code || !name || code !== '0000') { window.location.href = 'index.html'; return; }
  sessionStorage.setItem('responsable_code', code);
  sessionStorage.setItem('responsable_name', name);

  $('hdr-name').textContent = name;
  $('btn-back').addEventListener('click', () => { window.location.href = 'administracion.html'; });
  $('btn-add-obra').addEventListener('click', openAddModal);
  $('modal-obra-close').addEventListener('click',  () => $('modal-obra').classList.add('hidden'));
  $('modal-obra-cancel').addEventListener('click', () => $('modal-obra').classList.add('hidden'));
  $('modal-obra-save').addEventListener('click', saveObraModal);
  $('obra-nombre').addEventListener('keydown', e => { if (e.key === 'Enter') saveObraModal(); });
  $('btn-add-rubro').addEventListener('click', agregarRubro);
  $('rubro-nuevo').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); agregarRubro(); }
  });
  $('btn-toggle-rubros').addEventListener('click', toggleCierreRubros);

  loadJefes();
  loadObras();
});
