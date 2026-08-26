/* global DRIVE_CONFIG, FIREBASE_CONFIG */
(function () {
  'use strict';

  if (!window.DRIVE_CONFIG || !window.DRIVE_CONFIG.clientId) {
    const noDrive = async function () { throw new Error('Drive no configurado'); };
    window.uploadToDrive       = noDrive;
    window.uploadSourceToDrive = noDrive;
    window.uploadPdfToDrive    = noDrive;
    window.uploadPdfToFolders  = noDrive;
    window.uploadOCIfMissing   = noDrive;
    window.findOCUpload        = noDrive;
    window.deleteDriveFile     = async function () {};   // no-op sin Drive
    return;
  }

  const TOKEN_URL = 'https://oauth2.googleapis.com/token';

  // Ningún fetch contra Drive tenía tope de tiempo. Si la respuesta no llegaba
  // nunca —la pestaña suspendida al bloquear el celular, una red que se cae sin
  // cerrar el socket— el await quedaba pendiente para siempre: sin error, sin
  // catch y sin log. Así la OC 0000-00000323 quedó con el botón "Autorizando…"
  // puesto y el estado sin cambiar. Con el tope, un cuelgue se vuelve un error
  // normal y quien llama ya sabe qué hacer con eso.
  //
  // Este `fetch` tapa al global dentro del módulo: vale para todas las llamadas
  // del archivo. Las subidas llevan más margen que las consultas (un PDF por
  // datos móviles tarda), y abortar una no duplica nada porque uploadFile mira
  // si el archivo ya llegó antes de reintentar.
  const _FETCH_TIMEOUT    = 30000;
  const _FETCH_TIMEOUT_UP = 120000;
  const _nativeFetch      = window.fetch.bind(window);

  function fetch(url, opts) {
    const ms   = String(url).includes('/upload/') ? _FETCH_TIMEOUT_UP : _FETCH_TIMEOUT;
    const ctrl = new AbortController();
    const to   = setTimeout(() => ctrl.abort(), ms);
    return _nativeFetch(url, { ...(opts || {}), signal: ctrl.signal })
      .catch(err => {
        if (err && err.name === 'AbortError')
          throw new Error(`Sin respuesta tras ${Math.round(ms / 1000)}s`);
        throw err;
      })
      .finally(() => clearTimeout(to));
  }

  async function getAccessToken() {
    const cached = sessionStorage.getItem('_dtok');
    const expiry = parseInt(sessionStorage.getItem('_dexp') || '0', 10);
    if (cached && Date.now() < expiry) return cached;

    // Leer refresh token desde Firebase
    const fbResp = await fetch(
      FIREBASE_CONFIG.databaseURL + '/drive_refresh_token.json'
    );
    if (!fbResp.ok) throw new Error(`Firebase RT (${fbResp.status})`);
    const refreshToken = await fbResp.json();
    if (!refreshToken) throw new Error('No hay refresh token en Firebase');

    const resp = await fetch(TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     DRIVE_CONFIG.clientId,
        client_secret: DRIVE_CONFIG.clientSecret
      })
    });
    if (!resp.ok) throw new Error(`Token (${resp.status}): ${await resp.text()}`);
    const { access_token, expires_in } = await resp.json();

    sessionStorage.setItem('_dtok', access_token);
    sessionStorage.setItem('_dexp', String(Date.now() + (expires_in - 60) * 1000));
    return access_token;
  }

  // Drive archiva en la raíz de "Mi unidad" —sin dar error— cuando `parents`
  // llega nulo: JSON.stringify({parents:[undefined]}) produce {"parents":[null]}.
  // Así se filtraron OC sueltas en Mi unidad durante junio/julio 2026. Cualquier
  // id de carpeta vacío tiene que reventar acá, nunca llegar a la API.
  function _requireFolderId(id, contexto) {
    if (!id) throw new Error(`Drive: carpeta destino desconocida (${contexto})`);
    return id;
  }

  async function getOrCreateFolder(token, name, parentId) {
    _requireFolderId(parentId, `padre de "${name}"`);
    const safe = _safeName(name || 'Sin nombre');
    const q    = `name=${JSON.stringify(safe)} and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
    const s    = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!s.ok) throw new Error(`Drive search (${s.status})`);
    const { files } = await s.json();
    if (files && files.length) return _requireFolderId(files[0].id, `búsqueda de "${safe}"`);

    const c = await fetch('https://www.googleapis.com/drive/v3/files', {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        name:     safe,
        mimeType: 'application/vnd.google-apps.folder',
        parents:  [parentId]
      })
    });
    if (!c.ok) throw new Error(`Drive mkdir (${c.status})`);
    return _requireFolderId((await c.json()).id, `creación de "${safe}"`);
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Nombre con el que un archivo o carpeta vive en Drive. Lo comparten quien
  // sube y quien busca: si divergen, buscar no encuentra lo que se subió y todo
  // lo que dependa de esa búsqueda (no duplicar, reemplazar la planilla) falla
  // en silencio.
  function _safeName(name) {
    return String(name == null ? '' : name).replace(/[/\\]/g, '-').trim().substring(0, 120);
  }

  // Reubica un archivo que Drive archivó fuera de su carpeta. Devuelve true si
  // quedó en su lugar.
  async function _moveToFolder(token, fileId, folderId, fromParents) {
    const qs = `?addParents=${folderId}` +
               (fromParents && fromParents.length ? `&removeParents=${fromParents.join(',')}` : '') +
               '&fields=id';
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}${qs}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${token}` }
    });
    return r.ok;
  }

  // ¿Una subida que el cliente vio fallar llegó igual a Drive? Busca en la
  // carpeta un archivo con el mismo nombre Y el mismo tamaño creado desde que
  // arrancó esta subida. Los tres filtros juntos hacen que sólo pueda encontrar
  // lo que acabamos de mandar nosotros.
  // Sin `desdeISO` la ventana temporal no se aplica: sirve para preguntar "¿este
  // archivo exacto ya está en esta carpeta?" sin importar cuándo llegó.
  async function _findUploaded(token, name, folderId, size, desdeISO) {
    const q = `name=${JSON.stringify(name)} and '${folderId}' in parents and trashed=false` +
              (desdeISO ? ` and createdTime > '${desdeISO}'` : '');
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,size)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const { files } = await r.json();
    const hit = (files || []).find(f => String(f.size) === String(size));
    return hit ? hit.id : null;
  }

  async function uploadFile(token, blob, name, mimeType, folderId) {
    _requireFolderId(folderId, `subida de "${name}"`);
    name = _safeName(name);
    const boundary = 'vimeco_' + Date.now();
    const meta     = JSON.stringify({ name, parents: [folderId], mimeType });
    const enc      = new TextEncoder();
    const pre      = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const post    = enc.encode(`\r\n--${boundary}--`);
    const content = new Uint8Array(await blob.arrayBuffer());

    const body = new Uint8Array(pre.length + content.length + post.length);
    body.set(pre, 0);
    body.set(content, pre.length);
    body.set(post, pre.length + content.length);

    const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,parents';
    // Reintentos con backoff: en móvil la subida falla a veces por cortes de red
    // transitorios ("Load failed") o respuestas 5xx/429. Reintentar las absorbe.
    // Pero un fetch puede fallar DESPUÉS de que Drive creó el archivo (se corta
    // la red al leer la respuesta): ahí reintentar a ciegas deja una segunda
    // copia. Le pasó al presupuesto de la OC 0001-00000230, duplicado con 5
    // minutos de diferencia —lo que tardaba cada intento en subir el archivo— y
    // sin dejar ningún error registrado, porque el segundo intento salió bien.
    // El margen de 2 minutos hacia atrás absorbe el desfase entre el reloj del
    // dispositivo y el de Drive, que es quien pone createdTime.
    const desdeISO = new Date(Date.now() - 120000).toISOString();
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await _sleep(600 * attempt);   // 600, 1200, 1800 ms
        let yaSubido = null;
        try { yaSubido = await _findUploaded(token, name, folderId, blob.size, desdeISO); } catch (_) {}
        if (yaSubido) return yaSubido;
      }
      try {
        const resp = await fetch(url, {
          method:  'POST',
          headers: {
            Authorization:  `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`
          },
          body
        });
        if (resp.ok) {
          let info;
          try { info = await resp.json(); } catch (_) { return null; }
          // Confirmar que cayó donde pedimos: un 200 no alcanza como garantía.
          // Si quedó en otro lado (p. ej. la raíz de Mi unidad), reubicarlo.
          if (info.parents && !info.parents.includes(folderId)) {
            const movido = await _moveToFolder(token, info.id, folderId, info.parents);
            // No reintentar la subida: el archivo ya está en Drive y otro intento
            // sólo dejaría una copia más suelta.
            if (!movido) { lastErr = new Error(`Upload: "${name}" quedó fuera de su carpeta`); break; }
          }
          return info.id;
        }
        lastErr = new Error(`Upload (${resp.status})`);
        if (resp.status < 500 && resp.status !== 429) break;  // 4xx no transitorio → no reintentar
      } catch (e) {
        lastErr = e;   // error de red ("Load failed") → reintentar
      }
    }
    throw lastErr;
  }

  // Sube un archivo o, si ya existe uno con ese nombre en la carpeta, reemplaza
  // su contenido. Es lo que necesita cualquier planilla que se regenera (la de
  // caja, las de entregas): con uploadFile a secas, cada sincronización dejaría
  // una copia más en la carpeta.
  // El nombre se sanitiza igual que en _findChild para que buscar y crear no
  // apunten a nombres distintos (una obra con "/" en el nombre los separaría).
  async function _upsertFile(token, blob, name, mimeType, folderId) {
    _requireFolderId(folderId, `subida de "${name}"`);
    const safe = _safeName(name);

    let existingId = null;
    try { existingId = await _findChild(token, safe, folderId, false); } catch (_) {}
    if (!existingId) return uploadFile(token, blob, safe, mimeType, folderId);

    const boundary = 'vimeco_' + Date.now();
    const meta     = JSON.stringify({ name: safe, mimeType });
    const enc      = new TextEncoder();
    const pre      = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const post    = enc.encode(`\r\n--${boundary}--`);
    const content = new Uint8Array(await blob.arrayBuffer());
    const body    = new Uint8Array(pre.length + content.length + post.length);
    body.set(pre, 0);
    body.set(content, pre.length);
    body.set(post, pre.length + content.length);

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await _sleep(600 * attempt);
      try {
        const resp = await fetch(
          `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id`,
          { method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body }
        );
        if (resp.ok) return existingId;
        lastErr = new Error(`Update "${safe}" (${resp.status})`);
        if (resp.status < 500 && resp.status !== 429) break;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  // Versión pública: resuelve el token por su cuenta.
  window.uploadOrUpdateFile = async function (blob, name, mimeType, folderId) {
    const token = await getAccessToken();
    return _upsertFile(token, blob, name, mimeType, folderId);
  };

  // Carpeta de una obra dentro de OBRAS (la crea si falta). Es el nivel de
  // arriba de las subcarpetas "{fecha} | {proveedor}": ahí va la planilla de
  // control de entregas de la obra.
  window.getObraFolderId = async function (obra) {
    const token = await getAccessToken();
    const root  = await getObrasRootId(token);
    return getOrCreateFolder(token, obra || 'Sin obra', root);
  };

  // Borra un archivo de Drive por su ID. 404 (ya no existe) se trata como éxito.
  window.deleteDriveFile = async function (fileId) {
    if (!fileId) return;
    const token = await getAccessToken();
    const resp = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId), {
      method:  'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok && resp.status !== 404) throw new Error('Drive delete (' + resp.status + ')');
  };

  async function logDriveError(nroOC, error) {
    try {
      const key = (nroOC || 'unknown').replace(/[^a-z0-9]/gi, '');
      await fetch(`${FIREBASE_CONFIG.databaseURL}/drive_errors/${key}.json`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          nroOC,
          error:     error.message || String(error),
          timestamp: Date.now()
        })
      });
    } catch (_) {}
  }

  // Cache en memoria de los IDs de las carpetas raíz OBRAS y PROVEEDORES
  let _obrasId, _proveedoresId;

  async function getObrasRootId(token) {
    if (_obrasId) return _obrasId;
    try {
      const r = await fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/obrasId.json');
      if (r.ok) { const v = await r.json(); if (v) { _obrasId = v; return v; } }
    } catch (_) {}
    _obrasId = await getOrCreateFolder(token, 'OBRAS', DRIVE_CONFIG.folderId);
    fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/obrasId.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_obrasId)
    }).catch(() => {});
    return _obrasId;
  }

  async function getProveedoresRootId(token) {
    if (_proveedoresId) return _proveedoresId;
    try {
      const r = await fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/proveedoresId.json');
      if (r.ok) { const v = await r.json(); if (v) { _proveedoresId = v; return v; } }
    } catch (_) {}
    _proveedoresId = await getOrCreateFolder(token, 'PROVEEDORES', DRIVE_CONFIG.folderId);
    fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/proveedoresId.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_proveedoresId)
    }).catch(() => {});
    return _proveedoresId;
  }

  // Nombre de la subcarpeta de una OC, igual en OBRAS y en PROVEEDORES.
  function _subName({ fecha, proveedor }) {
    return `${fecha} | ${(proveedor || 'Sin proveedor').substring(0, 80)}`;
  }

  // Crea (o reutiliza) las dos carpetas destino de una OC y devuelve sus IDs.
  //   COMPRAS/OBRAS/{Obra}/{YYYY-MM-DD | Proveedor}/
  //   COMPRAS/PROVEEDORES/{Proveedor}/{YYYY-MM-DD | Proveedor}/
  async function _ensureOCFolders(token, { obra, fecha, proveedor }) {
    const subName = _subName({ fecha, proveedor });
    const [obrasRootId, proveedoresRootId] = await Promise.all([
      getObrasRootId(token),
      getProveedoresRootId(token)
    ]);
    const [obraParentId, provParentId] = await Promise.all([
      getOrCreateFolder(token, obra || 'Sin obra',           obrasRootId),
      getOrCreateFolder(token, proveedor || 'Sin proveedor', proveedoresRootId)
    ]);
    const [obrasFolderId, proveedoresFolderId] = await Promise.all([
      getOrCreateFolder(token, subName, obraParentId),
      getOrCreateFolder(token, subName, provParentId)
    ]);
    return { obrasFolderId, proveedoresFolderId };
  }

  // Sube el PDF a ambas carpetas; deja un marcador de error si alguna falla.
  // Lanza solo si fallan las dos.
  async function _pushPdf(token, pdfBlob, pdfName, obrasFolderId, proveedoresFolderId, nroOC) {
    // Un destino en null significa "esa copia ya está archivada": se saltea para
    // no dejar un duplicado del PDF en la carpeta.
    const destinos = [
      { fid: obrasFolderId,       label: 'OBRAS' },
      { fid: proveedoresFolderId, label: 'PROVEEDORES' }
    ].filter(d => d.fid);
    if (!destinos.length) throw new Error('Drive: sin carpeta destino para el PDF');

    const pdfResults = await Promise.allSettled(
      destinos.map(d => uploadFile(token, pdfBlob, pdfName, 'application/pdf', d.fid))
    );
    for (const [i, res] of pdfResults.entries()) {
      if (res.status === 'rejected') {
        const { label, fid } = destinos[i];
        await logDriveError(nroOC, new Error(`PDF ${label}: ${res.reason?.message}`));
        try {
          const marker = new Blob(
            [`Error al subir PDF\nOC: ${nroOC}\nFecha: ${new Date().toISOString()}\nError: ${res.reason?.message}`],
            { type: 'text/plain' }
          );
          await uploadFile(token, marker, '_ERROR_PDF.txt', 'text/plain', fid);
        } catch (_) {}
      }
    }
    if (pdfResults.every(r => r.status === 'rejected')) throw pdfResults[0].reason;
  }

  // Archiva el archivo fuente en las carpetas que se le pasen, salteando las que
  // ya lo tienen. El archivo fuente es el presupuesto del proveedor: se archiva
  // con el prefijo para distinguirlo de la OC, la factura y los remitos, que
  // conviven en la misma carpeta.
  //
  // Tres caminos archivan el mismo presupuesto en la misma carpeta —emitir la
  // OC, pedir autorización y reintentar desde la cola— y hasta ahora sólo el
  // último miraba antes de subir. Mirar siempre también cubre el caso de dos OC
  // del mismo proveedor el mismo día, que comparten carpeta.
  //
  // Nunca lanza: el respaldo de la OC no puede depender de esto. Devuelve
  // `{ ok, link }`; `ok` en false significa que alguna copia no quedó archivada,
  // y quien vacía la cola offline lo necesita para no borrar el único ejemplar
  // que existe del presupuesto.
  async function _archivarFuente(token, sourceFile, destinos, nroOC) {
    const name = nombreArchivoDrive('Presupuesto', sourceFile.name);
    const mime = sourceFile.type || 'application/octet-stream';
    const results = await Promise.allSettled(destinos.map(async ({ fid }) => {
      // Se compara nombre Y tamaño: dos OC del mismo proveedor y día comparten
      // carpeta, y sus presupuestos pueden llamarse igual sin serlo (dos fotos
      // "IMG_0042.jpg"). Con el nombre solo, el segundo no se archivaría nunca.
      // Si la búsqueda falla, subir igual: perder el presupuesto es peor que
      // duplicarlo.
      let ya = null;
      try { ya = await _findUploaded(token, name, fid, sourceFile.size, null); } catch (_) {}
      return ya || uploadFile(token, sourceFile, name, mime, fid);
    }));
    results.forEach((r, i) => {
      if (r.status === 'rejected')
        logDriveError(nroOC, new Error(`Fuente ${destinos[i].label}: ${r.reason?.message}`));
    });
    const ok = results.find(r => r.status === 'fulfilled' && r.value);
    return {
      ok:   results.every(r => r.status === 'fulfilled'),
      link: ok ? `https://drive.google.com/file/d/${ok.value}/view` : ''
    };
  }

  function _destinosFuente(obrasFid, proveedoresFid) {
    return [
      { fid: obrasFid,        label: 'OBRAS' },
      { fid: proveedoresFid,  label: 'PROVEEDORES' }
    ].filter(d => d.fid);
  }

  // Sube el archivo fuente a ambas carpetas. Devuelve un link de vista a la
  // primera copia archivada (o '' si no hay archivo / falló todo).
  async function _pushSource(token, sourceFile, obrasFolderId, proveedoresFolderId, nroOC) {
    if (!sourceFile) return '';
    const { link } = await _archivarFuente(
      token, sourceFile, _destinosFuente(obrasFolderId, proveedoresFolderId), nroOC);
    return link;
  }

  window.uploadToDrive = async function (pdfBlob, pdfName, meta, sourceFile) {
    const { nroOC } = meta;
    let token, obrasFolderId, proveedoresFolderId;
    try {
      token = await getAccessToken();
      ({ obrasFolderId, proveedoresFolderId } = await _ensureOCFolders(token, meta));
    } catch (err) {
      await logDriveError(nroOC, err);
      throw err;
    }

    await _pushPdf(token, pdfBlob, pdfName, obrasFolderId, proveedoresFolderId, nroOC);

    // Archivo fuente en background (best-effort)
    if (sourceFile) {
      _pushSource(token, sourceFile, obrasFolderId, proveedoresFolderId, nroOC).catch(() => {});
    }

    return { obrasFolderId, proveedoresFolderId };
  };

  // Busca una carpeta/archivo por nombre sin crear nada. Devuelve el id o null.
  async function _findChild(token, name, parentId, soloCarpetas) {
    if (!parentId || !name) return null;
    const safe = _safeName(name);
    const q = `name=${JSON.stringify(safe)} and '${parentId}' in parents and trashed=false` +
              (soloCarpetas ? " and mimeType='application/vnd.google-apps.folder'" : '');
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) throw new Error(`Drive search (${r.status})`);
    const { files } = await r.json();
    return files && files.length ? files[0].id : null;
  }

  // ¿El PDF de esta OC ya está archivado? Una subida puede llegar a Drive aunque
  // el cliente la vea fallar (se corta la red justo al leer la respuesta): la OC
  // queda sin carpetas en el historial —figurando "sin respaldo"— pero el
  // archivo existe. Mirar antes de resubir evita duplicar el PDF y permite
  // registrar la carpeta que ya tenía. No crea nada: si no está, devuelve nulls.
  window.findOCUpload = async function (meta, pdfName) {
    const token   = await getAccessToken();
    const subName = _subName(meta);
    const [obrasRootId, proveedoresRootId] = await Promise.all([
      getObrasRootId(token), getProveedoresRootId(token)
    ]);
    const [obraParentId, provParentId] = await Promise.all([
      _findChild(token, meta.obra      || 'Sin obra',      obrasRootId,       true),
      _findChild(token, meta.proveedor || 'Sin proveedor', proveedoresRootId, true)
    ]);
    const [obrasFolderId, proveedoresFolderId] = await Promise.all([
      _findChild(token, subName, obraParentId, true),
      _findChild(token, subName, provParentId, true)
    ]);
    const [pdfEnObras, pdfEnProveedores] = await Promise.all([
      _findChild(token, pdfName, obrasFolderId,       false),
      _findChild(token, pdfName, proveedoresFolderId, false)
    ]);
    return {
      obrasFolderId, proveedoresFolderId,
      pdfEnObras:       !!pdfEnObras,
      pdfEnProveedores: !!pdfEnProveedores
    };
  };

  // Sube el PDF a carpetas ya conocidas, salteando las que se pasen en null
  // (esa copia ya está archivada). A diferencia de uploadPdfToDrive, nunca crea
  // carpetas: se usa para completar una subida que quedó a medias.
  window.uploadPdfToFolders = async function (pdfBlob, pdfName, { obrasFolderId, proveedoresFolderId, nroOC }) {
    const token = await getAccessToken();
    await _pushPdf(token, pdfBlob, pdfName, obrasFolderId, proveedoresFolderId, nroOC);
  };

  // Archiva el presupuesto en las carpetas donde todavía no esté. Se usa cuando
  // el PDF ya estaba subido: sin esto, una OC que se resube nunca recupera el
  // presupuesto, porque _pushSource sólo corre en el camino de subida completa.
  // Comparte el fondo con _pushSource; se distingue en que resuelve el token por
  // su cuenta y en que **devuelve si quedó archivado**:
  // en una resubida el presupuesto puede venir de la cola offline, que es su
  // única copia, y quien la vacía necesita saber que llegó a Drive.
  async function _pushSourceIfMissing(obrasFid, provsFid, sourceFile, nroOC) {
    if (!sourceFile) return true;   // nada que archivar, nada que perder
    const token = await getAccessToken();
    const { ok } = await _archivarFuente(
      token, sourceFile, _destinosFuente(obrasFid, provsFid), nroOC);
    return ok;
  }

  // Subida idempotente: sube sólo las copias que falten. La usan los caminos de
  // reintento (cola offline, resubida desde Novedades), donde el PDF puede estar
  // archivado desde el intento anterior aunque el cliente lo haya visto fallar.
  // Devuelve `yaEstaba` para poder informarlo sin mentir, y
  // `presupuestoArchivado` para que quien vacía la cola no borre la única copia
  // del presupuesto sin que haya llegado a Drive.
  window.uploadOCIfMissing = async function (pdfBlob, pdfName, meta, sourceFile) {
    let hallazgo = null;
    try { hallazgo = await window.findOCUpload(meta, pdfName); } catch (_) {}

    if (hallazgo && hallazgo.pdfEnObras && hallazgo.pdfEnProveedores) {
      // El PDF ya está archivado; lo único que puede faltar es el presupuesto.
      const presupuestoArchivado = await _pushSourceIfMissing(
        hallazgo.obrasFolderId, hallazgo.proveedoresFolderId, sourceFile, meta.nroOC);
      return {
        obrasFolderId:       hallazgo.obrasFolderId,
        proveedoresFolderId: hallazgo.proveedoresFolderId,
        yaEstaba:            true,
        presupuestoArchivado
      };
    }
    if (hallazgo && (hallazgo.pdfEnObras || hallazgo.pdfEnProveedores)) {
      await window.uploadPdfToFolders(pdfBlob, pdfName, {
        obrasFolderId:       hallazgo.pdfEnObras       ? null : hallazgo.obrasFolderId,
        proveedoresFolderId: hallazgo.pdfEnProveedores ? null : hallazgo.proveedoresFolderId,
        nroOC: meta.nroOC
      });
      const presupuestoArchivado = await _pushSourceIfMissing(
        hallazgo.obrasFolderId, hallazgo.proveedoresFolderId, sourceFile, meta.nroOC);
      return {
        obrasFolderId:       hallazgo.obrasFolderId,
        proveedoresFolderId: hallazgo.proveedoresFolderId,
        yaEstaba:            false,
        presupuestoArchivado
      };
    }
    // Nada archivado todavía: subida completa. El presupuesto se archiva aparte
    // y esperando el resultado — uploadToDrive lo manda en background y ahí no
    // hay forma de saber si llegó.
    const ids = await window.uploadToDrive(pdfBlob, pdfName, meta, null);
    const presupuestoArchivado = await _pushSourceIfMissing(
      ids.obrasFolderId, ids.proveedoresFolderId, sourceFile, meta.nroOC);
    return { ...ids, yaEstaba: false, presupuestoArchivado };
  };

  // Al PEDIR autorización: crea las carpetas y sube solo el archivo fuente (si hay),
  // para que el autorizador pueda verlo. Devuelve IDs de carpeta + link al fuente.
  window.uploadSourceToDrive = async function (meta, sourceFile) {
    const { nroOC } = meta;
    let token, obrasFolderId, proveedoresFolderId;
    try {
      token = await getAccessToken();
      ({ obrasFolderId, proveedoresFolderId } = await _ensureOCFolders(token, meta));
    } catch (err) {
      await logDriveError(nroOC, err);
      throw err;
    }
    const sourceLink = await _pushSource(token, sourceFile, obrasFolderId, proveedoresFolderId, nroOC);
    return { obrasFolderId, proveedoresFolderId, sourceLink };
  };

  // Al AUTORIZAR: sube el PDF final a las carpetas ya creadas (o las recrea si no
  // se conocen los IDs, p. ej. si al pedir no había conexión con Drive).
  window.uploadPdfToDrive = async function (pdfBlob, pdfName, meta) {
    const { nroOC } = meta;
    let { obrasFolderId, proveedoresFolderId } = meta;
    let token;
    try {
      token = await getAccessToken();
      if (!obrasFolderId || !proveedoresFolderId) {
        ({ obrasFolderId, proveedoresFolderId } = await _ensureOCFolders(token, meta));
      }
    } catch (err) {
      await logDriveError(nroOC, err);
      throw err;
    }
    await _pushPdf(token, pdfBlob, pdfName, obrasFolderId, proveedoresFolderId, nroOC);
    return { obrasFolderId, proveedoresFolderId };
  };

  // Estructura Caja: Cajas → {userName} → {YYYY-MM} → Fotos|Archivos → archivo
  window.uploadToCajaDrive = async function (file, { userId, userName, fecha, tipo }) {
    const token = await getAccessToken();

    // Leer o crear carpeta raíz "Cajas" (id guardado en Firebase)
    let cajasId;
    try {
      const r = await fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/cajasId.json');
      if (r.ok) cajasId = await r.json();
    } catch (_) {}

    if (!cajasId) {
      // CAJAS vive como hermana de COMPRAS (no adentro), igual que PERSONAL.
      const parent = (await getComprasParentId(token)) || DRIVE_CONFIG.folderId;
      cajasId = await getOrCreateFolder(token, 'CAJAS', parent);
      fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/cajasId.json', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(cajasId)
      }).catch(() => {});
    } else {
      // Si ya existía (dentro de COMPRAS), moverla afuera una vez.
      _ensureOutsideCompras(token, cajasId, 'cajasMovedOut');
    }

    const mes        = fecha ? fecha.substring(0, 7) : new Date().toISOString().substring(0, 7);
    const userFolder = await getOrCreateFolder(token, userName || userId, cajasId);
    const mesFolder  = await getOrCreateFolder(token, mes, userFolder);
    // tipo 'planilla' → sube directo a la carpeta del mes; 'foto'/'archivo' → subcarpeta
    const typeFolder = (tipo === 'foto' || tipo === 'archivo')
      ? await getOrCreateFolder(token, tipo === 'foto' ? 'Fotos' : 'Archivos', mesFolder)
      : mesFolder;

    const mimeType = file.type || 'application/octet-stream';

    // La planilla del mes se regenera tras cada movimiento: pisa la que ya está
    // en vez de dejar una copia nueva.
    if (tipo === 'planilla')
      return { fileId: await _upsertFile(token, file, file.name, mimeType, typeFolder) };

    // Crear nuevo archivo
    _requireFolderId(typeFolder, `caja de ${userName || userId}`);
    const boundary = 'vimeco_' + Date.now();
    const meta     = JSON.stringify({ name: file.name, parents: [typeFolder], mimeType });
    const enc      = new TextEncoder();
    const pre      = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const post     = enc.encode(`\r\n--${boundary}--`);
    const content  = new Uint8Array(await file.arrayBuffer());
    const body     = new Uint8Array(pre.length + content.length + post.length);
    body.set(pre, 0); body.set(content, pre.length); body.set(post, pre.length + content.length);
    const resp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
    );
    if (!resp.ok) throw new Error(`Upload caja (${resp.status})`);
    return { fileId: (await resp.json()).id };
  };

  // Carpeta padre de COMPRAS (para colgar PERSONAL como hermana, no adentro)
  async function getComprasParentId(token) {
    try {
      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${DRIVE_CONFIG.folderId}?fields=parents&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) return null;
      const { parents } = await r.json();
      return (parents && parents[0]) || null;
    } catch (_) { return null; }
  }

  function _setMovedOutFlag(flagKey) {
    fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/' + flagKey + '.json', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'true'
    }).catch(() => {});
  }

  // Migración única: si una carpeta raíz quedó dentro de COMPRAS, la mueve al padre
  // de COMPRAS (para que quede como hermana). Best-effort y guardada por flag para
  // no chequear en cada subida.
  async function _ensureOutsideCompras(token, folderId, flagKey) {
    try {
      const f = await fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/' + flagKey + '.json');
      if (f.ok && (await f.json()) === true) return;

      const r = await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderId}?fields=parents&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) return;
      const parents = (await r.json()).parents || [];
      if (!parents.includes(DRIVE_CONFIG.folderId)) { _setMovedOutFlag(flagKey); return; }

      const target = await getComprasParentId(token);
      if (!target || target === DRIVE_CONFIG.folderId) return;
      const upd = await fetch(
        `https://www.googleapis.com/drive/v3/files/${folderId}?addParents=${target}&removeParents=${DRIVE_CONFIG.folderId}&supportsAllDrives=true&fields=id`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } }
      );
      if (upd.ok) _setMovedOutFlag(flagKey);
    } catch (_) {}
  }

  // Raíz PERSONAL (id cacheado en Firebase). Vive como hermana de COMPRAS.
  async function getPersonalRootId(token) {
    let id;
    try {
      const r = await fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/personalRootId.json');
      if (r.ok) id = await r.json();
    } catch (_) {}
    if (!id) {
      const parent = (await getComprasParentId(token)) || DRIVE_CONFIG.folderId;
      id = await getOrCreateFolder(token, 'PERSONAL', parent);
      fetch(FIREBASE_CONFIG.databaseURL + '/drive_config/personalRootId.json', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(id)
      }).catch(() => {});
      return id;
    }
    // Si ya existía (probablemente dentro de COMPRAS), moverla afuera una vez.
    _ensureOutsideCompras(token, id, 'personalMovedOut');
    return id;
  }

  // Sube un blob a una carpeta y devuelve { fileId, url }
  async function _uploadReturningId(token, file, name, folderId) {
    _requireFolderId(folderId, `subida de "${name}"`);
    const mimeType = file.type || 'application/octet-stream';
    const boundary = 'vimeco_' + Date.now();
    const meta     = JSON.stringify({ name, parents: [folderId], mimeType });
    const enc      = new TextEncoder();
    const pre      = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const post     = enc.encode(`\r\n--${boundary}--`);
    const content  = new Uint8Array(await file.arrayBuffer());
    const body     = new Uint8Array(pre.length + content.length + post.length);
    body.set(pre, 0); body.set(content, pre.length); body.set(post, pre.length + content.length);
    const resp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,parents',
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body }
    );
    if (!resp.ok) throw new Error(`Upload (${resp.status})`);
    const info = await resp.json();
    if (info.parents && !info.parents.includes(folderId))
      await _moveToFolder(token, info.id, folderId, info.parents);
    return { fileId: info.id, url: `https://drive.google.com/file/d/${info.id}/view` };
  }

  // Estructura Personal: PERSONAL → Padron → {label} → dni_{lado}.{ext}
  // label = "Apellido Nombre - DNI"; lado = 'frente' | 'dorso'.
  // Devuelve { fileId, url } (link de vista).
  window.uploadDniToDrive = async function (file, { label, lado }) {
    const token = await getAccessToken();
    const personalRootId = await getPersonalRootId(token);

    const padronId     = await getOrCreateFolder(token, 'Padron', personalRootId);
    const personFolder = await getOrCreateFolder(token, label || 'Sin nombre', padronId);

    const mimeType = file.type || 'application/octet-stream';
    const ext      = (file.name && file.name.includes('.')) ? file.name.split('.').pop().toLowerCase() : 'jpg';
    const base     = 'dni_' + (lado || 'frente');
    const fname    = base + '.' + ext;

    // Si ya hay un dni_{lado}.* en la carpeta, lo reemplazamos (PATCH) en vez de duplicar
    let existingId = null;
    try {
      const q = `'${personFolder}' in parents and name contains '${base}' and trashed=false`;
      const search = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (search.ok) {
        const { files } = await search.json();
        if (files?.length) existingId = files[0].id;
      }
    } catch (_) {}

    if (!existingId) _requireFolderId(personFolder, `DNI de ${label}`);
    const boundary = 'vimeco_' + Date.now();
    const meta     = JSON.stringify(existingId
      ? { name: fname, mimeType }
      : { name: fname, parents: [personFolder], mimeType });
    const enc     = new TextEncoder();
    const pre     = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const post    = enc.encode(`\r\n--${boundary}--`);
    const content = new Uint8Array(await file.arrayBuffer());
    const body    = new Uint8Array(pre.length + content.length + post.length);
    body.set(pre, 0); body.set(content, pre.length); body.set(post, pre.length + content.length);

    const upUrl = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
    const resp = await fetch(upUrl, {
      method:  existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    if (!resp.ok) throw new Error(`Upload DNI (${resp.status})`);
    const fileId = (await resp.json()).id;
    return {
      fileId,
      url:       `https://drive.google.com/file/d/${fileId}/view`,
      folderId:  personFolder,
      folderUrl: `https://drive.google.com/drive/folders/${personFolder}`
    };
  };

  // Reporte de quincena para RRHH (Excel).
  // Estructura: PERSONAL → Reportes → {Obra} → archivo. Si ya existe (mismo nombre), lo actualiza.
  // Devuelve { fileId, url }.
  window.uploadReporteQuincena = async function (file, { obra }) {
    const token   = await getAccessToken();
    const rootId  = await getPersonalRootId(token);
    const repId   = await getOrCreateFolder(token, 'Reportes', rootId);
    const obraId  = await getOrCreateFolder(token, obra || 'Sin obra', repId);
    const mimeType = file.type || 'application/octet-stream';

    // Buscar archivo existente con el mismo nombre → PATCH (actualizar contenido)
    let existingId = null;
    try {
      const q = `name=${JSON.stringify(file.name)} and '${obraId}' in parents and trashed=false`;
      const s = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (s.ok) { const { files } = await s.json(); if (files?.length) existingId = files[0].id; }
    } catch (_) {}

    if (!existingId) _requireFolderId(obraId, `parte de ${obra}`);
    const boundary = 'vimeco_' + Date.now();
    const meta     = JSON.stringify(existingId
      ? { name: file.name, mimeType }
      : { name: file.name, parents: [obraId], mimeType });
    const enc     = new TextEncoder();
    const pre     = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const post    = enc.encode(`\r\n--${boundary}--`);
    const content = new Uint8Array(await file.arrayBuffer());
    const body    = new Uint8Array(pre.length + content.length + post.length);
    body.set(pre, 0); body.set(content, pre.length); body.set(post, pre.length + content.length);

    const upUrl = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
    const resp = await fetch(upUrl, {
      method:  existingId ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    if (!resp.ok) throw new Error(`Upload reporte (${resp.status})`);
    const fileId = (await resp.json()).id;
    return { fileId, url: `https://drive.google.com/file/d/${fileId}/view` };
  };

  // Comprobantes del parte (certificados médicos, pasajes, etc.)
  // Estructura: PERSONAL → Comprobantes → {Obra} → {YYYY-MM-DD} → {Apellido Nombre} → archivo
  // Devuelve { fileId, url, name }.
  window.uploadComprobantePersonal = async function (file, { obra, fecha, persona }) {
    const token   = await getAccessToken();
    const rootId  = await getPersonalRootId(token);
    const compId  = await getOrCreateFolder(token, 'Comprobantes', rootId);
    const obraId  = await getOrCreateFolder(token, obra || 'Sin obra', compId);
    const fechaId = await getOrCreateFolder(token, fecha || 'sin-fecha', obraId);
    const persId  = await getOrCreateFolder(token, (persona || 'Sin nombre').substring(0, 100), fechaId);

    const name = file.name || ('comprobante_' + Date.now());
    const { fileId, url } = await _uploadReturningId(token, file, name, persId);
    return { fileId, url, name };
  };

  // Adjuntar un archivo a las carpetas Drive de una OC existente.
  // `soloSiFalta` lo usan los reintentos: una subida puede llegar a Drive
  // aunque el cliente la vea fallar (se corta la red al leer la respuesta), y
  // reintentar a ciegas dejaba una segunda copia del archivo en la carpeta.
  async function _attachToOC(file, meta, soloSiFalta) {
    const { drive_folder_obras_id, drive_folder_proveedores_id, drive_folder_id,
            obra, fecha, proveedor, nroOC } = meta;
    try {
      const token   = await getAccessToken();
      const mime    = file.type || 'application/octet-stream';
      const subName = `${fecha} | ${(proveedor || 'Sin proveedor').substring(0, 80)}`;

      // Sube salvo que ya haya un archivo con ese nombre en la carpeta.
      // _findChild sanitiza el nombre igual que uploadFile lo usa: los nombres
      // vienen de un input de archivo, sin "/" ni más de 120 caracteres.
      const subir = async fid => {
        if (soloSiFalta) {
          const ya = await _findChild(token, file.name, fid, false);
          if (ya) return ya;
        }
        return uploadFile(token, file, file.name, mime, fid);
      };

      // OC pre-reorganización: tiene solo drive_folder_id apuntando a COMPRAS/{obra}/...
      if (!drive_folder_obras_id && !drive_folder_proveedores_id && drive_folder_id) {
        await subir(drive_folder_id);
        return { folderId: drive_folder_id };
      }

      // Resolver IDs: usar los guardados o reconstruir bajo OBRAS/PROVEEDORES
      let obrasFid = drive_folder_obras_id;
      let provsFid = drive_folder_proveedores_id;

      if (!obrasFid || !provsFid) {
        const [obrasRoot, provsRoot] = await Promise.all([
          getObrasRootId(token),
          getProveedoresRootId(token)
        ]);
        if (!obrasFid) {
          const parent = await getOrCreateFolder(token, obra || 'Sin obra', obrasRoot);
          obrasFid = await getOrCreateFolder(token, subName, parent);
        }
        if (!provsFid) {
          const parent = await getOrCreateFolder(token, proveedor || 'Sin proveedor', provsRoot);
          provsFid = await getOrCreateFolder(token, subName, parent);
        }
      }

      await Promise.all([subir(obrasFid), subir(provsFid)]);
      return { folderId: obrasFid || provsFid };
    } catch (err) {
      await logDriveError(nroOC, new Error(`Adjunto: ${err.message}`));
      throw err;
    }
  }

  window.attachToDriveOC          = (file, meta) => _attachToOC(file, meta, false);
  window.attachToDriveOCIfMissing = (file, meta) => _attachToOC(file, meta, true);
})();
