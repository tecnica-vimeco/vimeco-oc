/* ===================================================
   VIMECO S.A. — Respaldo de OC en Drive
   driveBackup.js

   Lógica compartida sobre el respaldo de las OC en Drive. La usan Novedades
   (panel de OC sin respaldo + resubida) y Reportes (alcance del reporte).

   Requiere: firebase.js. Para resubir además ocGenerator.js + drive.js.
   =================================================== */

// Obras que se usan para probar la app: no son gasto real ni fallas reales.
// Match exacto sobre el nombre normalizado — ninguna obra real tiene un
// nombre de un solo carácter.
const OBRAS_PRUEBA = new Set(['x']);
function esObraPrueba(oc) {
  return OBRAS_PRUEBA.has((oc.obra || '').trim().toLowerCase());
}

// Mismo criterio para el proveedor: una OC cargada contra "X" (o "x") es una
// prueba, no una compra real. Ningún proveedor real se llama con una sola letra.
function esProveedorPrueba(oc) {
  return (oc.proveedor?.nombre || '').trim().toLowerCase() === 'x';
}

// Clave del registro en /historial (así se guarda en saveOCToHistory).
function histKeyOf(oc) { return (oc.nroOC || '').replace(/-/g, ''); }

// Una OC respaldada guarda el id de su carpeta al subir el PDF.
function driveFolderId(oc) {
  return oc.drive_folder_obras_id || oc.drive_folder_proveedores_id || null;
}

function driveUrlOf(oc) {
  const id = driveFolderId(oc);
  return id ? `https://drive.google.com/drive/folders/${id}` : '';
}

// El corte se deduce de los datos: la OC respaldada más antigua marca el momento
// en que el respaldo empezó a existir. Todo lo anterior es de las primeras
// iteraciones y no tiene sentido reclamarlo. Se usa la fecha (no la presencia
// del id) para no perder una OC reciente cuya subida sigue en la cola offline.
function driveCutoff(list) {
  const conRespaldo = list.filter(driveFolderId).map(o => o.timestamp || 0).filter(Boolean);
  return conRespaldo.length ? Math.min(...conRespaldo) : 0;
}

// Una OC pendiente de autorización todavía no tiene PDF, y una rechazada nunca
// lo va a tener: no se les puede reclamar respaldo ni resubirlas (hacerlo
// emitiría el PDF de una orden sin autorizar).
const SIN_PDF = new Set(['pendiente', 'rechazada']);

// OC que deberían tener respaldo y no lo tienen: emitidas, posteriores al corte,
// sin carpeta registrada y sin contar las obras de prueba. Más recientes primero.
function ocsSinRespaldo(list) {
  const corte = driveCutoff(list);
  return list
    .filter(oc => (oc.timestamp || 0) >= corte &&
                  !SIN_PDF.has(oc.estado) &&
                  !driveFolderId(oc) &&
                  !esObraPrueba(oc))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

// OC con PDF real emitido (directo o por autorización): son las que deberían
// tener su tarjeta en el feed de novedades.
const CON_PDF = new Set(['emitida', 'autorizada']);

// OC que deberían tener novedad y no la tienen. El feed se arma con llamadas
// "fire and forget" (logActivity) desde varios puntos del código — cualquiera
// de ellos puede perderse por un corte de red, o directamente no haberse
// escrito nunca (le pasó a las OC autorizadas antes de que autorizaciones.js
// avisara). Se reconcilia contra /historial, la fuente de verdad, en vez de
// confiar en que cada aviso haya llegado.
function ocsSinNovedad(list, actEvents) {
  const conNovedad = new Set(
    (actEvents || []).filter(e => e.tipo === 'oc').map(e => e.nroOC).filter(Boolean)
  );
  // Eventos viejos (previos al campo nroOC) sólo se pueden matchear por texto.
  const titulos = (actEvents || []).filter(e => e.tipo === 'oc').map(e => e.titulo || '');
  return list.filter(oc =>
    CON_PDF.has(oc.estado) &&
    !esObraPrueba(oc) &&
    !oc.novedad_borrada &&           // un admin borró su novedad: no revivirla
    !conNovedad.has(oc.nroOC) &&
    !titulos.some(t => t.includes(oc.nroOC))
  );
}

// OC esperando que alguien las autorice. Más recientes primero.
function ocsPendientes(list) {
  return list
    .filter(oc => oc.estado === 'pendiente' && oc.autorizacion?.solicitadoA && !esObraPrueba(oc))
    .sort((a, b) => (b.autorizacion?.solicitadoEn || b.timestamp || 0) -
                    (a.autorizacion?.solicitadoEn || a.timestamp || 0));
}

// Reconstruye el payload que espera generateOCBlob a partir del registro del
// historial. Las OC nuevas guardan `_payload` y se regeneran idénticas; las
// viejas se rearman campo por campo.
async function ocDataDe(oc) {
  const prov = oc.proveedor || {};
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
      plazo:     '', lugar:        '',
      ref:       prov.ref          || '',
      ubicacion: oc.obra           || ''
    },
    rubro:  oc.rubro  || null,
    equipo: oc.equipo || null,
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

  if (oc.estado === 'autorizada' && oc.autorizacion) {
    ocData._firmante = oc.autorizacion.firmante || ocData.ejecutor;
    if (oc.autorizacion.firmaCodigo && typeof getFirma === 'function') {
      try { ocData._firma = await getFirma(oc.autorizacion.firmaCodigo); } catch (_) {}
    }
  }
  return ocData;
}

// Deja registrado en el historial dónde quedó archivada la OC y muta `oc` para
// que quien la tenga en memoria la vea respaldada.
async function registrarCarpetasOC(oc, obrasFolderId, proveedoresFolderId) {
  await patchHistorialEntry(histKeyOf(oc), {
    drive_folder_obras_id:       obrasFolderId       || null,
    drive_folder_proveedores_id: proveedoresFolderId || null
  });
  oc.drive_folder_obras_id       = obrasFolderId;
  oc.drive_folder_proveedores_id = proveedoresFolderId;
}

// Respalda una OC que figura sin respaldo. Antes de subir nada mira si el PDF
// ya está en Drive: la causa más común de "sin respaldo" no es que la subida
// haya fallado sino que llegó y el registro de las carpetas no (le pasó a la OC
// 0004-00000218, archivada el 24/07 y reclamada igual). En ese caso sólo se
// registran las carpetas, sin dejar una segunda copia del PDF en la misma
// carpeta. Devuelve { yaEstaba } para poder decirlo en pantalla.
// El presupuesto (el archivo que se analizó con IA para armar la OC) sólo
// existe en memoria mientras se crea la orden. Si la subida falló, la cola
// offline lo guardó en IndexedDB: esa es la única copia que queda. Sin esto la
// resubida archivaba el PDF y daba la OC por respaldada, dejándola para siempre
// sin presupuesto y sin avisar.
// Ojo: la cola vive en el navegador que creó la OC. Resubir desde otro
// dispositivo no lo va a encontrar, y la app no puede saber si esa OC llegó a
// tener presupuesto (el historial no lo registra).
async function presupuestoEnCola(oc) {
  if (typeof driveQueue === 'undefined') return null;
  try {
    const pend = await driveQueue.getAll();
    const it   = pend.find(x => x.histKey === histKeyOf(oc));
    if (!it || !it.srcBuf) return null;
    return {
      histKey: it.histKey,
      file: new File([it.srcBuf], it.srcName || 'presupuesto',
                     { type: it.srcType || 'application/octet-stream' })
    };
  } catch (_) { return null; }
}

async function resubirOC(oc) {
  const fname = `OC_${oc.nroOC}_${sanitize(oc.proveedor?.nombre || 'SinProveedor')}.pdf`;
  // La fecha de la OC, no la de hoy: la carpeta destino se llama
  // "{fecha} | {proveedor}" y tiene que ser la de la orden original.
  const fecha = new Date(oc.timestamp || Date.now()).toISOString().slice(0, 10);
  const meta  = {
    obra: oc.obra || 'Sin obra', fecha,
    proveedor: oc.proveedor?.nombre || 'Sin proveedor', nroOC: oc.nroOC
  };

  // El PDF se regenera siempre porque hay que tenerlo listo por si falta alguna
  // copia; uploadOCIfMissing decide qué subir (y no sube nada si ya está todo).
  const blob   = generateOCBlob(await ocDataDe(oc));
  const enCola = await presupuestoEnCola(oc);
  const { obrasFolderId, proveedoresFolderId, yaEstaba, presupuestoArchivado } =
    await uploadOCIfMissing(blob, fname, meta, enCola?.file || null);

  await registrarCarpetasOC(oc, obrasFolderId, proveedoresFolderId);

  // Sólo se vacía la cola si quedó archivado TODO lo que había en ella. El
  // presupuesto encolado es su única copia (vive sólo en este navegador): si la
  // subida falló, borrarlo acá lo pierde para siempre. Queda para el reintento,
  // que ahora es idempotente y no va a duplicar el PDF.
  const presupuestoPendiente = !!enCola && !presupuestoArchivado;
  if (enCola && !presupuestoPendiente && typeof driveQueue !== 'undefined') {
    try { await driveQueue.dequeue(enCola.histKey); } catch (_) {}
  }

  return {
    yaEstaba,
    presupuestoRecuperado: !!enCola && !presupuestoPendiente,
    presupuestoPendiente
  };
}

// La tarjeta de una novedad guarda el link a la carpeta en el momento de
// crearse: si la OC se respaldó (o se registró su carpeta) después, queda "sin
// link" para siempre aunque el PDF esté en Drive. Rellena esas tarjetas contra
// /historial y devuelve cuántas corrigió. Muta los eventos recibidos.
async function completarLinksNovedades(hist, eventos) {
  if (typeof patchActividad !== 'function') return 0;
  const porNro = new Map((hist || []).map(oc => [oc.nroOC, oc]));
  // Los eventos viejos (previos al campo nroOC) sólo se pueden matchear por texto.
  const ocDe = e => porNro.get(e.nroOC) ||
    (hist || []).find(oc => oc.nroOC && (e.titulo || '').includes(oc.nroOC)) || {};
  const huerfanos = (eventos || []).filter(e =>
    e.tipo === 'oc' && !e.driveUrl && driveUrlOf(ocDe(e)));

  let ok = 0;
  for (const e of huerfanos) {
    const url = driveUrlOf(ocDe(e));
    try { await patchActividad(e.key, { driveUrl: url }); e.driveUrl = url; ok++; }
    catch (_) { /* se reintenta sola en la próxima carga */ }
  }
  return ok;
}
