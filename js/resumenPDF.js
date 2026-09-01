/* =====================================================
   VIMECO S.A. — PDF del "Resumen del período"
   resumenPDF.js

   Documento A4 apaisado con el resumen de compras de un rango de fechas:
   franja de totales, top obras / top proveedores y el listado completo de
   las OC emitidas en el período con su estado de factura.

   No sabe nada de monedas ni de conversiones: recibe todo ya formateado
   desde reportes.js (ver el contrato en generateResumenBlob).
   ===================================================== */

/* global jspdf, LOGO_BASE64, C, VIMECO */

// ─── Paleta / datos fijos ────────────────────────────
// Se toman de ocGenerator.js si está cargado (misma identidad que la OC);
// si no, valen estos fallbacks. `typeof` porque son const de script, no
// propiedades de window: un acceso directo tiraría ReferenceError.
const RC = (typeof C !== 'undefined') ? C : {
  azul: [43, 57, 70], azulMed: [61, 81, 102], amarillo: [225, 174, 58],
  gris: [242, 242, 242], borde: [170, 170, 170], blanco: [255, 255, 255], negro: [20, 20, 20]
};
const RV = (typeof VIMECO !== 'undefined') ? VIMECO : { cuit: '30-50424533-7' };

// Semáforo de la columna Factura.
const F_COL = {
  con:   [30, 125, 58],    // verde
  sin:   [176, 42, 42],    // rojo
  otros: [154, 106, 0]     // ámbar (archivos sin rotular)
};

// ─── Geometría A4 apaisado ───────────────────────────
const RP = {
  w: 297, h: 210,
  ml: 10, mt: 10, mb: 14,
  get cw()   { return this.w - 2 * this.ml; },   // 277mm
  get maxY() { return this.h - this.mb; }        // 196mm
};

// Anchos de la tabla del listado, en mm (suman 277).
const T_COLS = [18, 26, 58, 46, 26, 30, 34, 39];
const T_HEAD = ['Fecha', 'N° OC', 'Proveedor', 'Obra', 'Equipo', 'Responsable', 'Importe', 'Factura'];
const T_ALIGN = ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'left'];
const ROW_H = 5.6;

// ─── API ─────────────────────────────────────────────

/*  data = {
      rango:      'Semana del 01/09 al 07/09 de 2026',
      subrango:   '01/09/2026 – 07/09/2026',
      moneda:     'ARS' | 'USD',
      notas:      ['...'],                        // pie del documento
      kpis:       [{ lbl, val, sub }],            // hasta 5
      topObras:   [{ label, val, pct }],
      topProv:    [{ label, val, pct }],
      ocs:        [{ fecha, nroOC, proveedor, obra, equipo, responsable,
                     importe, factura, facturaEstado }],
      totalStr:   '$ 8.400.000',
      generado:   '01/09/2026 14:32'
    }  */
function buildResumenDoc(data) {
  let jsPDFClass = null;
  if (window.jspdf && window.jspdf.jsPDF)  jsPDFClass = window.jspdf.jsPDF;
  else if (window.jsPDF)                   jsPDFClass = window.jsPDF;
  else throw new Error('jsPDF no está disponible');

  const doc = new jsPDFClass({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  let y = drawResHeader(doc, data);
  y = drawKpis(doc, data, y + 4);
  y = drawTops(doc, data, y + 5);
  drawTabla(doc, data, y + 5);
  drawPies(doc, data);

  return doc;
}

function generateResumenBlob(data) {
  return buildResumenDoc(data).output('blob');
}

function resumenFileName(data) {
  const r = String(data.subrango || '').trim().replace(/\s+/g, '_').replace(/[/–]/g, '_');
  return `Resumen_compras_${r || 'periodo'}.pdf`;
}

// ─── Encabezado ──────────────────────────────────────
function drawResHeader(doc, data) {
  const x0 = RP.ml, y = RP.mt, H = 22;

  doc.setFillColor(...RC.azul);
  doc.rect(x0, y, RP.cw, H, 'F');

  // Logo sobre placa blanca (el PNG es de tinta oscura y sobre el azul se pierde).
  const logoSrc = typeof LOGO_BASE64 !== 'undefined' ? LOGO_BASE64 : null;
  if (logoSrc) {
    try {
      const fmt = logoSrc.startsWith('data:image/png') ? 'PNG' : 'JPEG';
      const LOGO_RATIO = 82 / 400;                 // relación real del archivo
      const lw = 46, lh = lw * LOGO_RATIO;
      doc.setFillColor(...RC.blanco);
      doc.rect(x0 + 3, y + 3, lw + 6, H - 6, 'F');
      doc.addImage(logoSrc, fmt, x0 + 6, y + (H - lh) / 2, lw, lh);
    } catch (_) {}
  }

  doc.setTextColor(...RC.blanco);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('RESUMEN DE COMPRAS', x0 + 62, y + 10);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text(String(data.rango || ''), x0 + 62, y + 16.5);

  // Total del período, alineado a la derecha de la franja.
  const xr = x0 + RP.cw - 4;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(200, 214, 230);
  doc.text('TOTAL DEL PERÍODO', xr, y + 8, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...RC.blanco);
  doc.text(String(data.totalStr || '—'), xr, y + 16.5, { align: 'right' });

  return y + H;
}

// ─── Franja de totales ───────────────────────────────
function drawKpis(doc, data, y) {
  const kpis = (data.kpis || []).slice(0, 5);
  if (!kpis.length) return y;

  const gap = 3;
  const w   = (RP.cw - gap * (kpis.length - 1)) / kpis.length;
  const H   = 17;

  kpis.forEach((k, i) => {
    const x = RP.ml + i * (w + gap);
    doc.setFillColor(...RC.gris);
    doc.rect(x, y, w, H, 'F');
    // Filete de color a la izquierda: azul salvo que el KPI pida otro.
    doc.setFillColor(...(k.color || RC.azulMed));
    doc.rect(x, y, 1.4, H, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(110, 118, 128);
    doc.text(String(k.lbl || '').toUpperCase(), x + 4, y + 5);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...(k.color || RC.azul));
    doc.text(fit(doc, String(k.val ?? '—'), w - 6), x + 4, y + 11.5);

    if (k.sub) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(110, 118, 128);
      doc.text(fit(doc, String(k.sub), w - 6), x + 4, y + 15.4);
    }
  });

  return y + H;
}

// ─── Top obras / top proveedores ─────────────────────
function drawTops(doc, data, y) {
  const cols = [
    { titulo: 'Obras del período',      rows: data.topObras || [] },
    { titulo: 'Proveedores del período', rows: data.topProv  || [] }
  ].filter(c => c.rows.length);
  if (!cols.length) return y;

  const gap = 5;
  const w   = (RP.cw - gap * (cols.length - 1)) / cols.length;
  const filas = Math.max(...cols.map(c => c.rows.length));
  const H = 6 + filas * 5 + 1.5;

  cols.forEach((col, i) => {
    const x = RP.ml + i * (w + gap);

    doc.setDrawColor(...RC.borde);
    doc.setLineWidth(0.3);
    doc.rect(x, y, w, H, 'S');

    doc.setFillColor(...RC.azul);
    doc.rect(x, y, w, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...RC.blanco);
    doc.text(col.titulo.toUpperCase(), x + 3, y + 4.1);

    col.rows.forEach((r, j) => {
      const ry = y + 6 + j * 5;
      if (j % 2) { doc.setFillColor(248, 249, 251); doc.rect(x + 0.4, ry, w - 0.8, 5, 'F'); }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...RC.negro);
      doc.text(fit(doc, r.label, w - 58), x + 3, ry + 3.6);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...RC.azul);
      doc.text(String(r.val), x + w - 18, ry + 3.6, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120, 128, 138);
      doc.text(String(r.pct), x + w - 3, ry + 3.6, { align: 'right' });
    });
  });

  return y + H;
}

// ─── Listado de OC ───────────────────────────────────
function drawTabla(doc, data, y) {
  const xs = buildResXs(RP.ml, T_COLS);
  const ocs = data.ocs || [];

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...RC.azul);
  doc.text(`Órdenes de compra emitidas (${ocs.length})`, RP.ml, y);
  y += 3;

  if (!ocs.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(120, 128, 138);
    doc.text('No hay órdenes de compra emitidas en el período.', RP.ml, y + 5);
    return;
  }

  y = drawTablaHead(doc, xs, y);

  ocs.forEach((oc, i) => {
    if (y + ROW_H > RP.maxY) {
      doc.addPage();
      y = drawTablaHead(doc, xs, RP.mt);
    }

    if (i % 2) {
      doc.setFillColor(248, 249, 251);
      doc.rect(RP.ml, y, RP.cw, ROW_H, 'F');
    }

    const vals = [oc.fecha, oc.nroOC, oc.proveedor, oc.obra, oc.equipo,
                  oc.responsable, oc.importe, oc.factura];
    vals.forEach((v, c) => {
      // La columna Factura lleva el color del estado; el resto va en negro.
      if (c === 7) { doc.setTextColor(...(F_COL[oc.facturaEstado] || RC.negro)); doc.setFont('helvetica', 'bold'); }
      else if (c === 6) { doc.setTextColor(...RC.negro); doc.setFont('helvetica', 'bold'); }
      else if (c === 1) { doc.setTextColor(...RC.azulMed); doc.setFont('helvetica', 'bold'); }
      else { doc.setTextColor(...RC.negro); doc.setFont('helvetica', 'normal'); }
      doc.setFontSize(7.5);
      const txt = fit(doc, String(v ?? ''), T_COLS[c] - 3);
      doc.text(txt, resTextX(xs[c], T_COLS[c], T_ALIGN[c]), y + 3.8,
        T_ALIGN[c] === 'right' ? { align: 'right' } : undefined);
    });

    doc.setDrawColor(225, 229, 234);
    doc.setLineWidth(0.2);
    doc.line(RP.ml, y + ROW_H, RP.ml + RP.cw, y + ROW_H);
    y += ROW_H;
  });

  // Cierre: total del listado repetido al pie de la tabla.
  if (y + 7 > RP.maxY) { doc.addPage(); y = RP.mt; }
  doc.setFillColor(...RC.azul);
  doc.rect(RP.ml, y, RP.cw, 7, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...RC.blanco);
  doc.text(`TOTAL · ${data.ocs.length} OC`, RP.ml + 3, y + 4.7);
  doc.setFontSize(10);
  doc.text(String(data.totalStr || ''), RP.ml + RP.cw - 3, y + 4.8, { align: 'right' });
}

function drawTablaHead(doc, xs, y) {
  doc.setFillColor(...RC.azulMed);
  doc.rect(RP.ml, y, RP.cw, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...RC.blanco);
  T_HEAD.forEach((h, c) => {
    doc.text(h.toUpperCase(), resTextX(xs[c], T_COLS[c], T_ALIGN[c]), y + 4,
      T_ALIGN[c] === 'right' ? { align: 'right' } : undefined);
  });
  return y + 6;
}

// ─── Pie de todas las páginas ────────────────────────
// Va al final para poder escribir "página N de M".
function drawPies(doc, data) {
  const total = doc.getNumberOfPages();
  const notas = (data.notas || []).join('  ·  ');
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    const y = RP.h - 8;
    doc.setDrawColor(...RC.borde);
    doc.setLineWidth(0.3);
    doc.line(RP.ml, y - 3, RP.ml + RP.cw, y - 3);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 128, 138);
    doc.text(fit(doc, `VIMECO S.A. · CUIT ${RV.cuit} · generado el ${data.generado}`, 150), RP.ml, y);
    if (notas) doc.text(fit(doc, notas, 180), RP.ml, y + 3.2);
    doc.text(`Página ${p} de ${total}`, RP.ml + RP.cw, y, { align: 'right' });
  }
}

// ─── Utilidades ──────────────────────────────────────

// Recorta el texto al ancho de la columna. splitTextToSize parte por palabras:
// si sobra más de una línea, se muestra la primera con puntos suspensivos.
function fit(doc, txt, w) {
  const s = String(txt ?? '');
  if (!s) return '';
  if (doc.getTextWidth(s) <= w) return s;
  const lines = doc.splitTextToSize(s, w);
  let out = lines[0] || s;
  // Una sola palabra larga puede seguir excediendo: se corta a mano.
  while (out.length > 1 && doc.getTextWidth(out + '…') > w) out = out.slice(0, -1);
  return out + '…';
}

function buildResXs(startX, cols) {
  const xs = [startX];
  cols.slice(1).forEach((_, i) => xs.push(xs[i] + cols[i]));
  return xs;
}

function resTextX(colX, colW, align) {
  if (align === 'right')  return colX + colW - 1.5;
  if (align === 'center') return colX + colW / 2;
  return colX + 1.5;
}

window.generateResumenBlob = generateResumenBlob;
window.resumenFileName     = resumenFileName;
