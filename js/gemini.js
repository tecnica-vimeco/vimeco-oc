/* global GEMINI_API_KEY */

/*
 * Motor de llamadas a Gemini: una sola función para las 5 lecturas de la app.
 *
 * El tier gratuito da cupo POR MODELO y por día (los Flash grandes dan 20; los
 * Flash-Lite 3.x, 500), así que un único modelo titular deja la app sin IA a
 * media tarde. `callGemini` recorre una cadena de modelos y salta al siguiente
 * cuando el de arriba está sin cupo (429), caído (5xx) o tarda de más. Los 400
 * NO saltan: si el pedido está mal armado, en otro modelo va a estar igual.
 *
 * El modelo agotado se recuerda en localStorage para no gastar un viaje de red
 * en cada lectura por el resto del día. OJO: la cuota se resetea a MEDIANOCHE
 * DEL PACÍFICO, no local — por eso la marca guarda el día en esa zona horaria.
 */
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// `cfg` se mergea sobre el generationConfig de cada pedido:
// - mediaResolution HIGH en los lite: sin eso pierden dígitos en fotos de celular.
// - thinkingLevel minimal en 3.6: por defecto piensa de más y tarda ~25s.
const G_LITE_35  = { id: 'gemini-3.5-flash-lite', cfg: { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } };
const G_LITE_31  = { id: 'gemini-3.1-flash-lite', cfg: { mediaResolution: 'MEDIA_RESOLUTION_HIGH' } };
const G_FLASH_36 = { id: 'gemini-3.6-flash',      cfg: { thinkingConfig: { thinkingLevel: 'minimal' } } };
const G_FLASH_25 = { id: 'gemini-2.5-flash',      cfg: {} };

// Documentos impresos (presupuesto, factura, ticket): en el banco de pruebas del
// 04/08 los lite leyeron los 55 precios igual que los grandes y 4x más rápido.
const CADENA_DOC = [G_LITE_35, G_LITE_31, G_FLASH_36, G_FLASH_25];

// Remitos: manuscritos y fotos torcidas, sin banco de pruebas propio todavía.
// Arranca por el modelo grande y deja los lite como red para cuando se agote.
const CADENA_REMITO = [G_FLASH_36, G_LITE_35, G_LITE_31, G_FLASH_25];

// Audio: sólo los modelos con los que ya se probó el dictado.
const CADENA_AUDIO = [G_FLASH_25, G_FLASH_36];

const GEMINI_AGOTADOS_KEY = 'vimeco_gemini_agotados';
const modelosSinNombre    = new Set();   // 404: nombre que esta API todavía no sirve

// La cuota diaria de Gemini corta a medianoche del Pacífico.
function diaPacifico() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function agotadosHoy() {
  try {
    const guardado = JSON.parse(localStorage.getItem(GEMINI_AGOTADOS_KEY) || '{}');
    const hoy = diaPacifico();
    return Object.fromEntries(Object.entries(guardado).filter(([, dia]) => dia === hoy));
  } catch {
    return {};
  }
}

function marcarAgotado(modeloId) {
  try {
    const actual = agotadosHoy();
    actual[modeloId] = diaPacifico();
    localStorage.setItem(GEMINI_AGOTADOS_KEY, JSON.stringify(actual));
  } catch { /* sin localStorage la cascada sigue funcionando, sólo reintenta */ }
}

function geminiApiKey() {
  const key = typeof GEMINI_API_KEY !== 'undefined' ? GEMINI_API_KEY : null;
  if (!key || key === 'AQUI_VA_LA_KEY' || key.includes('%%')) {
    throw new Error('No hay API Key configurada. Editá js/config.js con tu clave de Gemini.');
  }
  return key;
}

async function callGemini(cadena, body, opts = {}) {
  const apiKey   = geminiApiKey();
  const timeout  = opts.timeout || 60000;
  const agotados = agotadosHoy();
  const saltar   = m => agotados[m.id] || modelosSinNombre.has(m.id);

  // Los descartados van al final en vez de excluirse: si la cadena entera está
  // marcada, más vale intentar igual que fallar sin haber pedido nada.
  const orden = [...cadena.filter(m => !saltar(m)), ...cadena.filter(saltar)];

  let ultimoError = null;

  for (const modelo of orden) {
    const payload = {
      ...body,
      generationConfig: { ...(body.generationConfig || {}), ...modelo.cfg }
    };

    let response;
    try {
      response = await fetch(`${GEMINI_BASE}/${modelo.id}:generateContent?key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(timeout)
      });
    } catch (err) {
      // Timeout o red: probamos el siguiente, que suele ser más rápido.
      ultimoError = (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? new Error(opts.msgTimeout || 'La solicitud a Gemini tardó demasiado.')
        : err;
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      if (data.candidates?.length) {
        // Queda a mano para diagnosticar desde la consola con qué modelo se leyó.
        try { window.__geminiUltimoModelo = modelo.id; } catch { /* sin window, da igual */ }
        return { data, modelo: modelo.id };
      }
      ultimoError = new Error(opts.msgVacio || 'Gemini no devolvió una respuesta utilizable.');
      continue;
    }

    const errData = await response.json().catch(() => ({}));
    ultimoError = new Error(`Error de API Gemini: ${errData?.error?.message || `HTTP ${response.status}`}`);

    if (response.status === 429) { marcarAgotado(modelo.id);      continue; }
    if (response.status === 404) { modelosSinNombre.add(modelo.id); continue; }
    if (response.status >= 500)  { continue; }

    throw ultimoError;   // 400/403: el pedido o la key están mal para todos por igual
  }

  throw ultimoError || new Error('No se pudo contactar a Gemini.');
}

function textoGemini(data) {
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Los modelos a veces envuelven el JSON en ```json o le cuelgan una frase.
function jsonDeTexto(texto, msgError) {
  const limpio = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const ini = limpio.indexOf('{'), fin = limpio.lastIndexOf('}');
  if (ini === -1 || fin === -1) throw new Error(msgError || 'Respuesta inesperada de Gemini.');
  try {
    return JSON.parse(limpio.slice(ini, fin + 1));
  } catch {
    throw new Error('La respuesta de Gemini no es JSON válido.');
  }
}

const EXTRACT_PROMPT = `Sos un asistente especializado en lectura de documentos comerciales argentinos (facturas, presupuestos, cotizaciones, remitos, órdenes de compra).

El documento puede ser una foto tomada con celular, posiblemente con perspectiva, sombras, reflejos o leve distorsión. Hacé tu mejor esfuerzo para leer el contenido aunque la imagen no sea perfecta.

PASO 1 — Antes de extraer datos, analizá la estructura del documento:
Identificá qué columnas de precio tiene la tabla de ítems y decidí qué valor usar como precio unitario. Escribí este análisis en "estructura_precios".

Devolvé ÚNICAMENTE un JSON válido, sin bloques de código markdown, sin texto adicional.

Estructura JSON requerida:
{
  "estructura_precios": "descripción de las columnas de precio encontradas y criterio aplicado (ej: 'Tabla tiene P.Lista + %Desc + P.Neto → se usa P.Neto directamente', 'Solo tiene Precio Unit. → se usa ese valor', 'Precios incluyen IVA según encabezado')",
  "precios_incluyen_iva": null,
  "proveedor": "nombre completo o razón social del proveedor",
  "cuit_proveedor": "CUIT del proveedor en formato XX-XXXXXXXX-X si está disponible, sino null",
  "domicilio_proveedor": "domicilio o dirección del proveedor si está disponible, sino null",
  "telefonos_proveedor": "teléfonos del proveedor si están disponibles, sino null",
  "condicion_iva_proveedor": "condición frente al IVA del proveedor (ej: Responsable Inscripto, Monotributista, etc.), sino null",
  "ref_presupuesto": "número de presupuesto o referencia si está disponible, sino null",
  "condicion_pago": "condición de pago indicada (ej: contado, 30 días, 60 días, etc.), sino null",
  "items": [
    {
      "desc": "descripción detallada del producto o servicio",
      "unidad": "unidad de medida exacta del documento (m², m³, ml, kg, gl, tn, u, etc.)",
      "cant": número_decimal,
      "unitario": número_decimal_sin_moneda_ni_separadores,
      "total": número_decimal_sin_moneda_ni_separadores
    }
  ],
  "subtotal_documento": número_o_null,
  "total_documento": número_o_null,
  "descuento": { "porcentaje": número_o_null, "monto": número_positivo_o_cero },
  "noGravado": { "monto": número_positivo_o_cero },
  "impuestos": [
    {
      "nombre": "nombre del impuesto tal como aparece (ej: 'I.V.A. 21%', 'Perc. IIBB Córdoba')",
      "porcentaje": número_o_null,
      "monto": número_decimal_sin_moneda_ni_separadores
    }
  ]
}

FORMATO DE NÚMEROS — CRÍTICO:
En documentos argentinos: PUNTO = separador de miles, COMA = decimal.
Convertir SIEMPRE a número con punto decimal y sin separadores de miles.

Ejemplos (memorizar estas conversiones):
- "5.718.571,59" → 5718571.59  (NO escribir 5718.571 ni 5718571)
- "1.200.900,03" → 1200900.03
- "627.774,12"  → 627774.12
- "52.314,51"   → 52314.51
- "10.777,00"   → 10777.0
- "10.000"      → 10000  (diez mil, no diez)
- "72,674"      → 72.674 (setenta y dos con decimales)
Esta regla aplica a TODOS los campos numéricos: unitario, total, subtotal_documento, total_documento, montos de impuestos, etc.

PRECIO UNITARIO — ORDEN DE PRIORIDAD (respetar este orden sin excepciones):
1. Si existe columna "P.Neto", "Precio Neto", "Neto", "P. c/Desc." o similar → usar ese valor directamente, sin modificar
2. Si existe "P.Lista" + "%Desc." pero NO hay columna de precio neto → calcular: P.Lista × (1 - %Desc / 100)
3. Solo si no hay ningún precio unitario explícito en el renglón → derivar de total_linea ÷ cantidad
NUNCA usar P.Lista si en el mismo renglón existe una columna de precio neto.

DETECCIÓN DE IVA EN PRECIOS:
- "precios_incluyen_iva": true → si los precios unitarios ya incluyen IVA (el documento lo indica explícitamente o se infiere claramente)
- "precios_incluyen_iva": false → si el IVA está discriminado por separado al final del documento
- "precios_incluyen_iva": null → si no es posible determinarlo

Reglas generales:
- cant, unitario, total, porcentaje, monto, subtotal_documento, total_documento son siempre numbers (no strings)
- Si no encontrás un campo opcional, usá null (no string vacío)
- Incluí TODOS los ítems del documento, sin excepción
- El campo "total" de cada ítem es el importe de esa línea tal como figura en el documento
- Si una descripción está parcialmente ilegible, extraé lo que puedas y agregá "..." al final
- "descuento": monto POSITIVO si hay descuento global. Si tiene porcentaje explícito, completar "porcentaje". Si no hay descuento, devolver null
- "noGravado": si hay ítems no gravados, extraer su monto total. Si no hay, devolver null
- "impuestos": incluir SOLO impuestos reales (IVA, percepciones). NO incluir Subtotal, Neto gravado ni TOTAL
- Si el documento es completamente ilegible, devolvé items: [] e impuestos: []`;

function cargarImagen(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo cargar la imagen para comprimir.')); };
    img.src = url;
  });
}

/*
 * Las fotos de celular llegan de 6-12 MP: en base64 crecen otro 33% y el viaje
 * a Gemini se va a decenas de segundos sin que el modelo lea nada mejor. Se
 * bajan a 1800px de lado mayor, el mismo tamaño con el que ya entran las de
 * Caja y Remitos por el escáner. Los PDF no se tocan.
 */
async function compressImageIfNeeded(file) {
  const LIMIT    = 4 * 1024 * 1024;   // techo de lo que conviene mandar en inline_data
  const MAX_DIM  = 1800;
  const MIN_SIZE = 600 * 1024;        // más abajo de esto no hay nada que ganar

  // Un archivo de cámara puede llegar sin `type`: la extensión decide, igual que al enviarlo.
  if (!normalizeMimeType(file.type, file.name).startsWith('image/')) return file;
  if (file.size <= MIN_SIZE) return file;

  let img;
  try {
    img = await cargarImagen(file);
  } catch (err) {
    if (file.size > LIMIT) throw err;   // sin comprimir no entra: ahí sí es error
    return file;                        // entra igual: seguimos con la original
  }

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  let scale    = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));

  for (let intento = 0; intento < 5; intento++) {
    canvas.width  = Math.max(1, Math.round(img.naturalWidth  * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
    if (!blob) break;
    if (blob.size > LIMIT) { scale *= 0.7; continue; }
    // Una JPEG ya optimizada puede salir más pesada al re-comprimirla.
    return blob.size < file.size
      ? new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })
      : file;
  }
  return file;
}

async function extractFromFile(file) {
  file = await compressImageIfNeeded(file);

  const base64   = await fileToBase64(file);
  const mimeType = normalizeMimeType(file.type, file.name);

  const { data } = await callGemini(CADENA_DOC, {
    contents: [{
      parts: [
        { text: EXTRACT_PROMPT },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 8192 }
  }, {
    timeout:    60000,
    msgTimeout: 'La solicitud a Gemini tardó demasiado. Intentá con una imagen más pequeña.',
    msgVacio:   'Gemini no devolvió candidatos. Intentá con otra imagen o PDF.'
  });

  return parseGeminiResponse(textoGemini(data));
}

function parseGeminiResponse(text) {
  let clean = text.trim();
  // Strip markdown code fences
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('No se encontró JSON en la respuesta de Gemini.');
  }

  let parsed;
  try {
    parsed = JSON.parse(clean.slice(start, end + 1));
  } catch {
    throw new Error('La respuesta de Gemini no es JSON válido. Intentá con otra imagen.');
  }

  return {
    proveedor:              trimOrNull(parsed.proveedor),
    cuit_proveedor:         trimOrNull(parsed.cuit_proveedor),
    domicilio_proveedor:    trimOrNull(parsed.domicilio_proveedor),
    telefonos_proveedor:    trimOrNull(parsed.telefonos_proveedor),
    condicion_iva_proveedor: trimOrNull(parsed.condicion_iva_proveedor),
    ref_presupuesto:        trimOrNull(parsed.ref_presupuesto),
    condicion_pago:         trimOrNull(parsed.condicion_pago),
    estructura_precios:  trimOrNull(parsed.estructura_precios),
    precios_incluyen_iva: parsed.precios_incluyen_iva === true ? true : parsed.precios_incluyen_iva === false ? false : null,
    items: (parsed.items || []).map(it => ({
      descripcion:     String(it.desc || it.descripcion || '').trim(),
      unidad:          String(it.unidad || 'u').trim(),
      cantidad:        parseFloatSafe(it.cant  ?? it.cantidad),
      precio_unitario: parseFloatSafe(it.unitario ?? it.precio_unitario),
      total_documento: parseFloatSafe(it.total)
    })),
    subtotal_documento: parseFloatSafe(parsed.subtotal_documento) || null,
    total_documento:    parseFloatSafe(parsed.total_documento)    || null,
    descuento: parsed.descuento ? {
      porcentaje: parseFloatSafe(parsed.descuento.porcentaje) || null,
      monto:      parseFloatSafe(parsed.descuento.monto)
    } : null,
    noGravado: parsed.noGravado ? {
      monto: parseFloatSafe(parsed.noGravado.monto)
    } : null,
    impuestos: (parsed.impuestos || []).map(imp => ({
      nombre:     String(imp.nombre || '').trim(),
      porcentaje: parseFloatSafe(imp.porcentaje) || null,
      monto:      parseFloatSafe(imp.monto)
    })).filter(imp => imp.nombre !== '' && imp.monto > 0)
  };
}

function trimOrNull(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === '' || s === 'null' ? null : s;
}

function parseFloatSafe(val) {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (typeof val === 'string') {
    // Handle Argentine format "1.500,50" → 1500.50
    const n = parseFloat(val.replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function normalizeMimeType(type, filename) {
  if (type && type !== 'application/octet-stream') return type;
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png',  webp: 'image/webp',
    pdf: 'application/pdf'
  };
  return map[ext] || 'image/jpeg';
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

// ---- Extracción básica (proveedor + total) para matching de OC ----

async function extractBasicFromFile(file) {
  file = await compressImageIfNeeded(file);
  const base64   = await fileToBase64(file);
  const mimeType = normalizeMimeType(file.type, file.name);

  const prompt = `Analizá este documento comercial (factura, remito, presupuesto, etc.) y devolvé ÚNICAMENTE este JSON sin texto adicional ni markdown:
{
  "proveedor": "nombre o razón social del proveedor",
  "total": número_decimal_sin_signos_ni_separadores_de_miles
}
Regla para números: en documentos argentinos el punto es separador de miles y la coma es decimal.
Ejemplos: "1.250.000,50" → 1250000.5 · "52.314,51" → 52314.51
Si no podés determinar un campo, usá null.`;

  const { data } = await callGemini(CADENA_DOC, {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 256 }
  }, {
    timeout:    30000,
    msgTimeout: 'Gemini tardó demasiado. Intentá con Asignar manualmente.'
  });

  const parsed = jsonDeTexto(textoGemini(data));
  return {
    proveedor:       trimOrNull(parsed.proveedor),
    total_documento: parseFloatSafe(parsed.total) || null
  };
}

// ---- Ticket / expense extraction (caja chica) ----

const TICKET_PROMPT = `Analizás un ticket, factura o comprobante de gasto de Argentina. Extraé los datos clave.
Devolvé ÚNICAMENTE un JSON válido, sin markdown ni texto adicional:

{
  "proveedor": "nombre del comercio o vendedor, o null",
  "descripcion": "descripción breve de qué se compró o pagó, o null",
  "fecha": "fecha en formato YYYY-MM-DD, o null",
  "monto_total": número_total_del_comprobante,
  "categoria_sugerida": "una de: Viaticos, Peajes, Combustibles, Repuestos, Oficina, Herramientas, Pasajes, Inspección, Equipos, Otras"
}

FORMATO NUMÉRICO: en documentos argentinos el punto es separador de miles y la coma es decimal.
Ejemplos: "1.250,50" → 1250.5 · "52.314,51" → 52314.51
Si no podés determinar un campo, usá null. monto_total debe ser el importe final total.`;

async function extractFromTicket(file) {
  file = await compressImageIfNeeded(file);
  const base64   = await fileToBase64(file);
  const mimeType = normalizeMimeType(file.type, file.name);

  const { data } = await callGemini(CADENA_DOC, {
    contents: [{ parts: [{ text: TICKET_PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 512 }
  }, {
    timeout:    30000,
    msgTimeout: 'Gemini tardó demasiado. Intentá de nuevo.'
  });

  const parsed = jsonDeTexto(textoGemini(data));
  return {
    proveedor:          trimOrNull(parsed.proveedor),
    descripcion:        trimOrNull(parsed.descripcion),
    fecha:              trimOrNull(parsed.fecha),
    monto_total:        parseFloatSafe(parsed.monto_total) || null,
    categoria_sugerida: trimOrNull(parsed.categoria_sugerida)
  };
}

// ---- Remito: lectura contra los ítems de una OC ----

// El remito se lee siempre CONTRA una OC ya cargada: en vez de pedir una lista
// libre de ítems (que después habría que matchear a mano y con errores), se le
// pasan los renglones de la OC numerados y sólo puede devolver cantidades
// contra esos índices. Lo que figura en el papel y no está en la OC vuelve por
// separado en "sin_match": es un aviso para el usuario, no algo para cargar.
function remitoPrompt(ocItems) {
  const lista = ocItems.length
    ? ocItems.map((it, i) =>
        `${i}. ${it.desc || '(sin descripción)'} | unidad: ${it.unidad || 'u'} | pendiente de entregar: ${it.pendiente}`
      ).join('\n')
    : '(la orden de compra no tiene ítems cargados)';

  return `Analizás la foto de un REMITO de entrega de materiales de Argentina. Puede estar torcida, con sombras o escrita a mano.

Estos son los renglones de la orden de compra contra la que se está recibiendo la mercadería:
${lista}

Tu tarea:
1. Leer el número de remito y la fecha del documento.
2. Para cada renglón del remito, decidir a qué número de la lista de arriba corresponde (por descripción y unidad; las palabras no van a coincidir exactamente) y cuánto se entregó.

Devolvé ÚNICAMENTE un JSON válido, sin markdown ni texto adicional:

{
  "nro": "número de remito tal como figura (ej: 0001-00012345), o null",
  "fecha": "fecha del remito en formato YYYY-MM-DD, o null",
  "observaciones": "nota breve SOLO si el remito indica algo relevante sobre la entrega (bulto dañado, faltante, entrega parcial), sino null",
  "items": [
    { "idx": número_de_la_lista, "cantidad": número_decimal_entregado }
  ],
  "sin_match": ["descripción de los renglones del remito que no corresponden a ningún número de la lista"]
}

Reglas:
- "idx" debe ser uno de los números de la lista de arriba. Nunca inventes índices.
- Un renglón de la lista puede aparecer como máximo una vez en "items".
- Si un renglón del remito no se corresponde con ninguno de la lista, va en "sin_match", NO en "items".
- Si el remito no aclara la cantidad de un renglón que sí figura entregado, usá la cantidad pendiente de ese número.
- Si no podés leer un dato, devolvé null (no inventes un número de remito ni una fecha).
- FORMATO NUMÉRICO: en documentos argentinos el punto es separador de miles y la coma es decimal.
  Ejemplos: "1.250,50" → 1250.5 · "12,5" → 12.5 · "1.000" → 1000`;
}

async function extractFromRemito(file, ocItems) {
  const items = Array.isArray(ocItems) ? ocItems : [];

  file = await compressImageIfNeeded(file);
  const base64   = await fileToBase64(file);
  const mimeType = normalizeMimeType(file.type, file.name);

  const { data } = await callGemini(CADENA_REMITO, {
    contents: [{ parts: [{ text: remitoPrompt(items) }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 8192 }
  }, {
    timeout:    60000,
    msgTimeout: 'Gemini tardó demasiado. Cargá el remito a mano.'
  });

  const parsed = jsonDeTexto(textoGemini(data));

  // Un índice inventado escribiría una cantidad en el renglón equivocado, y un
  // índice repetido pisaría el anterior: se descartan los dos casos.
  const vistos = new Set();
  const leidos = (parsed.items || []).reduce((acc, it) => {
    const idx  = Number(it.idx);
    const cant = parseFloatSafe(it.cantidad);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) return acc;
    if (vistos.has(idx) || cant <= 0) return acc;
    vistos.add(idx);
    acc.push({ idx, cantidad: cant });
    return acc;
  }, []);

  const fecha = trimOrNull(parsed.fecha);

  return {
    nro:           trimOrNull(parsed.nro),
    fecha:         /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : null,
    observaciones: trimOrNull(parsed.observaciones),
    items:         leidos,
    sinMatch:      (parsed.sin_match || []).map(t => String(t || '').trim()).filter(Boolean)
  };
}

// ---- Voice extraction ----

const VOICE_PROMPT = `Sos un asistente especializado en registrar órdenes de compra para la empresa VIMECO S.A.

El usuario va a dictar por voz los datos de una orden de compra. Puede mencionar proveedor, ítems, cantidades, precios, condiciones, obra, etc.

Extraé toda la información y devolvé ÚNICAMENTE un JSON válido, sin bloques de código markdown, sin texto adicional.

Estructura JSON requerida:
{
  "proveedor": "nombre del proveedor o null",
  "cuit_proveedor": "CUIT en formato XX-XXXXXXXX-X o null",
  "domicilio_proveedor": "domicilio o null",
  "telefonos_proveedor": "teléfonos o null",
  "condicion_iva_proveedor": "condición IVA o null",
  "ref_presupuesto": "número de presupuesto o null",
  "condicion_pago": "condición de pago o null",
  "ubicacion": "nombre de la obra o proyecto o null",
  "plazo_entrega": "plazo de entrega o null",
  "lugar_entrega": "lugar de entrega o null",
  "items": [
    {
      "desc": "descripción del ítem",
      "unidad": "unidad de medida (m², m³, kg, u, gl, etc.)",
      "cant": número_decimal,
      "unitario": número_decimal
    }
  ]
}

Reglas:
- Los números son siempre numbers, no strings
- Si un campo no fue mencionado, usá null
- Si no hay ítems claros, devolvé items como []`;

async function extractFromAudio(base64, mimeType) {
  const { data } = await callGemini(CADENA_AUDIO, {
    contents: [{
      parts: [
        { text: VOICE_PROMPT },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: { temperature: 0.05, maxOutputTokens: 2048 }
  }, {
    timeout:    60000,
    msgTimeout: 'Gemini tardó demasiado con el audio. Intentá de nuevo.',
    msgVacio:   'Gemini no pudo procesar el audio. Intentá de nuevo.'
  });

  return parseVoiceResponse(textoGemini(data));
}

function parseVoiceResponse(text) {
  let clean = text.trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No se encontró JSON en la respuesta de voz.');

  let parsed;
  try {
    parsed = JSON.parse(clean.slice(start, end + 1));
  } catch {
    throw new Error('La respuesta de voz no es JSON válido.');
  }

  return {
    proveedor:               trimOrNull(parsed.proveedor),
    cuit_proveedor:          trimOrNull(parsed.cuit_proveedor),
    domicilio_proveedor:     trimOrNull(parsed.domicilio_proveedor),
    telefonos_proveedor:     trimOrNull(parsed.telefonos_proveedor),
    condicion_iva_proveedor: trimOrNull(parsed.condicion_iva_proveedor),
    ref_presupuesto:         trimOrNull(parsed.ref_presupuesto),
    condicion_pago:          trimOrNull(parsed.condicion_pago),
    ubicacion:               trimOrNull(parsed.ubicacion),
    plazo_entrega:           trimOrNull(parsed.plazo_entrega),
    lugar_entrega:           trimOrNull(parsed.lugar_entrega),
    items: (parsed.items || []).map(it => ({
      descripcion:     String(it.desc || it.descripcion || '').trim(),
      unidad:          String(it.unidad || 'u').trim(),
      cantidad:        parseFloatSafe(it.cant  ?? it.cantidad),
      precio_unitario: parseFloatSafe(it.unitario ?? it.precio_unitario)
    })),
    descuento: null,
    noGravado: null,
    impuestos: []
  };
}
