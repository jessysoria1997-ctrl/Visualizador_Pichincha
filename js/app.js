/* ============================================================================
   app.js — ORQUESTADOR
   Estado de filtros, KPIs, panel territorial, tabla, exportaciones y
   sincronización entre mapa, gráficos e interfaz.
   ========================================================================== */

const ESTADO = {
  dignidad: CONFIG.dignidadPorDefecto,
  provK: '',
  cantK: '',
  parrK: '',                      // solo en dignidades de análisis parroquial
  vistaTabla: 'territorios',      // 'territorios' | 'preinscritos'
  busqueda: '',
  orden: { col: 'valor', dir: -1 },
  pagina: 1
};

/* Cache del cálculo del render actual */
const VISTA = { agregado: null, registros: [], filasTabla: [] };


/* ============================================================================
   ARRANQUE
   ========================================================================== */

document.addEventListener('DOMContentLoaded', arrancar);

/* Si el navegador ya disparó DOMContentLoaded antes de leer este archivo
   (extensiones, inyección de scripts, recargas parciales), el listener no
   llegaría a ejecutarse nunca. */
if (document.readyState !== 'loading') arrancar();

let arrancado = false;

async function arrancar() {
  /* Una segunda ejecución volvería a llamar a L.map() sobre el mismo
     contenedor y Leaflet abortaría con "Map container is already
     initialized", dejando el tablero a medio construir. */
  if (arrancado) return;
  arrancado = true;

  aplicarMarca();
  cablearInterfaz();
  aplicarTemaChartJS();

  try {
    /* Nada se carga hasta que haya sesión. */
    if (typeof iniciarAcceso === 'function') await iniciarAcceso();

    mostrarCarga(true, 'Cargando capas geográficas y base de preinscritos…');
    await inicializarDatos();

    /* Base de resultados: pequeña y opcional. Si falta, el tablero funciona
       igual y el bloque simplemente no se muestra. */
    await cargarResultados();
    await cargarElectores();

    /* Se recortan las bases al territorio del usuario ANTES de construir el
       mapa: así ni la cartografía llega a tener los otros territorios. */
    if (typeof podarPorAlcance === 'function') {
      podarPorAlcance();
      aplicarAlcanceEstado();
    }

    inicializarMapa();
    MAPA.onSeleccion = manejarSeleccionMapa;

    construirSelectorDignidad();
    poblarProvincias();
    render({ encuadrar: true, animar: false });

    mostrarCarga(false);
    document.body.classList.add('listo');
    avisosIniciales();

    /* La capa parroquial se trae después de mostrar el tablero: así el
       primer pintado no espera por el archivo más pesado del proyecto. */
    activarNivelParroquial();
  } catch (e) {
    mostrarCarga(false);
    mostrarError(e.message, e);
  }
}

/** Incorpora el cuarto nivel geográfico cuando la capa termina de llegar. */
async function activarNivelParroquial() {
  try {
    if (await cargarParroquias()) {
      if (typeof podarPorAlcance === 'function') podarPorAlcance();
      render({ silencioso: true });
    }
  } catch (e) {
    /* Un fallo aquí no debe afectar al resto del tablero. */
    console.warn('Capa parroquial no disponible:', e);
  }
}

/** Vuelca los textos de marca configurados en el encabezado. */
function aplicarMarca() {
  const m = CONFIG.marca;
  /* Tolerante a que falte algún elemento: si alguien edita index.html y
     quita un hueco, no debe caerse el arranque entero por eso. */
  const poner = (sel, texto) => { const e = q(sel); if (e) e.textContent = texto; };

  document.title = `${m.titulo} · ${m.empresa}`;
  poner('#marca-titulo', m.titulo);
  poner('#marca-subtitulo', m.subtitulo);
  poner('#marca-empresa', m.empresa);
  poner('#marca-ciclo', m.ciclo);

  const logo = q('#marca-logo');
  if (logo) {
    logo.src = m.logo;
    logo.onerror = () => { logo.style.display = 'none'; };
  }

  /* Sello de versión: si aquí no aparece la versión esperada, el navegador
     está sirviendo una copia antigua desde su caché. */
  poner('#marca-version', 'v' + CONFIG.version);
  console.info(
    `%c Análisis Electoral Territorial  v${CONFIG.version} `,
    'background:#0A111E;color:#F5B44A;padding:3px 6px;border-radius:3px'
  );
}

/** Avisos de calidad de datos tras la carga inicial. */
function avisosIniciales() {
  q('#etiqueta-demo').hidden = !DATOS.modoDemo;

  /* El aviso de registros sin geometría vivía en el panel lateral, que ya no
     lo incluye. Se deja en la consola para no perder el dato. */
  if (DATOS.sinGeometria.length) {
    const n = DATOS.registros.filter(r => !r.conGeometria).length;
    console.info(`[Dashboard] ${n} registro(s) sin geometría: ` +
                 DATOS.sinGeometria.join(' · '));
  }
}


/* ============================================================================
   INTERFAZ: CABLEADO DE EVENTOS
   ========================================================================== */

const q  = (s) => document.querySelector(s);
const qa = (s) => [...document.querySelectorAll(s)];

function cablearInterfaz() {
  q('#sel-provincia').addEventListener('change', (e) => {
    ESTADO.provK = e.target.value;
    ESTADO.cantK = '';
    ESTADO.parrK = '';
    ESTADO.pagina = 1;
    poblarCantones();
    poblarParroquias();
    render({ encuadrar: true });
  });

  q('#sel-canton').addEventListener('change', (e) => {
    ESTADO.cantK = e.target.value;
    ESTADO.parrK = '';
    ESTADO.pagina = 1;
    poblarParroquias();
    render({ encuadrar: true });
  });

  q('#sel-parroquia').addEventListener('change', (e) => {
    ESTADO.parrK = e.target.value;
    ESTADO.pagina = 1;
    render({ encuadrar: true });
  });

  q('#btn-limpiar').addEventListener('click', limpiarFiltros);

  /* Tabla */
  q('#tabla-busqueda').addEventListener('input', debounce((e) => {
    ESTADO.busqueda = e.target.value.trim();
    ESTADO.pagina = 1;
    actualizarTabla();
  }, 220));

  qa('[data-vista]').forEach(b => b.addEventListener('click', () => {
    ESTADO.vistaTabla = b.dataset.vista;
    ESTADO.pagina = 1;
    ESTADO.orden = b.dataset.vista === 'territorios'
      ? { col: 'valor', dir: -1 } : { col: 'provincia', dir: 1 };
    qa('[data-vista]').forEach(x => x.classList.toggle('activo', x === b));
    actualizarTabla();
  }));

  q('#tabla-filas').addEventListener('change', (e) => {
    CONFIG.tabla.filasPorPagina = parseInt(e.target.value, 10);
    ESTADO.pagina = 1;
    actualizarTabla();
  });

  /* Panel lateral en pantallas pequeñas */
  q('#btn-panel').addEventListener('click', () => {
    document.body.classList.toggle('panel-abierto');
  });
  q('#velo-panel').addEventListener('click', () => {
    document.body.classList.remove('panel-abierto');
  });

  /* Ruta de niveles geográficos */
  qa('[data-nivel]').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.nivel;
    if (n === 'pais')      { ESTADO.provK = ''; ESTADO.cantK = ''; ESTADO.parrK = ''; }
    if (n === 'provincia') { ESTADO.cantK = ''; ESTADO.parrK = ''; }
    if (n === 'canton')    { ESTADO.parrK = ''; }
    sincronizarSelectores();
    render({ encuadrar: true });
  }));

  q('#error-cerrar').addEventListener('click', () => { q('#capa-error').hidden = true; });

  window.addEventListener('resize', debounce(() => {
    MAPA.map && MAPA.map.invalidateSize();
  }, 200));
}

/** Grupo de una dignidad (CONCEJALES para urbanos y rurales), o null. */
const grupoDe = (id) => (CONFIG.dignidades.find(d => d.id === id) || {}).grupo || null;

/* Última dignidad elegida de cada grupo: al volver al grupo se retoma. */
const ULTIMA_DEL_GRUPO = {};

/**
 * Botones grandes de dignidad, generados desde CONFIG. Las dignidades de un
 * mismo 'grupo' comparten un botón que, al elegirlo, despliega debajo uno
 * pequeño por cada una (Concejales → Urbanos · Rurales).
 */
function construirSelectorDignidad() {
  const cont = q('#sel-dignidad');
  const grupos = new Set();
  cont.innerHTML = CONFIG.dignidades.map(d => {
    if (!d.grupo) {
      return `
    <button type="button" class="dig-btn" data-dig="${d.id}" style="--dig-color:${CONFIG.paleta[d.id].acento}">
      <span class="dig-nombre">${d.etiqueta.toUpperCase()}</span>
      <span class="dig-nivel">${d.descripcion}</span>
    </button>`;
    }
    if (grupos.has(d.grupo)) return '';
    grupos.add(d.grupo);
    const g = CONFIG.gruposDignidad[d.grupo];
    const miembros = CONFIG.dignidades.filter(x => x.grupo === d.grupo);
    return `
    <div class="dig-conjunto" data-grupo="${d.grupo}" style="--dig-color:${CONFIG.paleta[d.grupo].acento}">
      <button type="button" class="dig-btn" data-grupo-btn="${d.grupo}" aria-expanded="false">
        <span class="dig-nombre">${g.etiqueta.toUpperCase()}</span>
        <span class="dig-nivel">${g.descripcion}</span>
      </button>
      <div class="dig-sub">
        <div class="dig-sub-in" role="group" aria-label="${g.etiqueta}">${miembros.map(m => `
          <button type="button" class="dig-sub-btn" data-dig="${m.id}">${m.boton}</button>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');

  cont.querySelectorAll('[data-dig]').forEach(b => {
    b.addEventListener('click', () => elegirDignidad(b.dataset.dig));
  });
  cont.querySelectorAll('[data-grupo-btn]').forEach(b => {
    b.addEventListener('click', () => {
      const grupo = b.dataset.grupoBtn;
      if (grupoDe(ESTADO.dignidad) === grupo) return;
      elegirDignidad(ULTIMA_DEL_GRUPO[grupo] ||
                     CONFIG.dignidades.find(d => d.grupo === grupo).id);
    });
  });

  /* Réplica del selector en el encabezado: un solo nombre por grupo. */
  const vistos = new Set();
  q('#dig-encabezado').innerHTML = CONFIG.dignidades
    .map(d => d.grupo ? { id: d.grupo, etiqueta: CONFIG.gruposDignidad[d.grupo].etiqueta } : d)
    .filter(d => !vistos.has(d.id) && vistos.add(d.id))
    .map(d => `<span data-dig-h="${d.id}">${d.etiqueta.toUpperCase()}</span>`)
    .join('<i>|</i>');

  marcarDignidad();
}

function elegirDignidad(id) {
  if (ESTADO.dignidad === id) return;
  ESTADO.dignidad = id;
  ESTADO.pagina = 1;
  marcarDignidad();
  /* El selector de parroquia solo acompaña a las dignidades que se eligen por
     parroquia: cambia con la dignidad, igual que el nivel del análisis. */
  poblarParroquias();
  /* Al pasar a Prefectos el cantón deja de ser el nivel de análisis. */
  render({ encuadrar: true });
}

/** Refleja la dignidad activa en los botones y despliega su grupo. */
function marcarDignidad() {
  const grupo = grupoDe(ESTADO.dignidad);
  if (grupo) ULTIMA_DEL_GRUPO[grupo] = ESTADO.dignidad;
  qa('#sel-dignidad [data-dig]').forEach(b =>
    b.classList.toggle('activo', b.dataset.dig === ESTADO.dignidad));
  qa('#sel-dignidad [data-grupo]').forEach(c => {
    const abierto = c.dataset.grupo === grupo;
    c.classList.toggle('abierto', abierto);
    const b = c.querySelector('[data-grupo-btn]');
    b.classList.toggle('activo', abierto);
    b.setAttribute('aria-expanded', String(abierto));
  });
}


/* ============================================================================
   SELECTORES DE TERRITORIO
   ========================================================================== */

function poblarProvincias() {
  const sel = q('#sel-provincia');
  const provs = provinciasSeleccionables();
  sel.innerHTML = '<option value="">Todas las provincias</option>' +
    provs.map(p => `<option value="${p.key}">${tituloCase(p.nombre)}</option>`).join('');
  sel.value = ESTADO.provK;
  poblarCantones();
}

function poblarCantones() {
  const sel = q('#sel-canton');
  if (!ESTADO.provK) {
    sel.innerHTML = '<option value="">Seleccione un cantón</option>';
    sel.disabled = true;
    sel.parentElement.classList.add('deshabilitado');
    return;
  }
  const p = TERRITORIO.porProvK.get(ESTADO.provK);
  const cantones = p ? p.cantones : [];
  sel.innerHTML = '<option value="">Todos los cantones</option>' +
    cantones.map(c => `<option value="${c.key}">${tituloCase(c.nombre)}</option>`).join('');
  sel.disabled = false;
  sel.parentElement.classList.remove('deshabilitado');
  sel.value = ESTADO.cantK;
}

/**
 * Parroquias del cantón enfocado. El campo solo existe para las dignidades
 * que se eligen por parroquia (vocales); en las demás queda oculto.
 */
function poblarParroquias() {
  const campo = q('#campo-parroquia');
  const sel = q('#sel-parroquia');
  if (!campo || !sel) return;
  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);
  campo.hidden = dig.nivel !== 'parroquia';

  const parrs = (ESTADO.provK && ESTADO.cantK)
    ? (TERRITORIO.parroquiasPorCant.get(ESTADO.provK + '|' + ESTADO.cantK) || []) : [];
  sel.innerHTML = '<option value="">Todas las parroquias</option>' +
    parrs.map(x => `<option value="${x.__key}">${tituloCase(x.__nombre)}</option>`).join('');
  sel.disabled = !parrs.length;
  campo.classList.toggle('deshabilitado', !parrs.length);
  if (ESTADO.parrK && !parrs.some(x => x.__key === ESTADO.parrK)) ESTADO.parrK = '';
  sel.value = ESTADO.parrK;
}

function sincronizarSelectores() {
  q('#sel-provincia').value = ESTADO.provK;
  poblarCantones();
  q('#sel-canton').value = ESTADO.cantK;
  poblarParroquias();
}

function limpiarFiltros() {
  ESTADO.dignidad = CONFIG.dignidadPorDefecto;
  ESTADO.provK = ''; ESTADO.cantK = ''; ESTADO.parrK = '';
  ESTADO.busqueda = ''; ESTADO.pagina = 1;
  ESTADO.vistaTabla = 'territorios';
  ESTADO.orden = { col: 'valor', dir: -1 };
  q('#tabla-busqueda').value = '';
  qa('[data-vista]').forEach(x => x.classList.toggle('activo', x.dataset.vista === 'territorios'));
  marcarDignidad();
  /* Un usuario con alcance limitado vuelve a su territorio, no al país. */
  if (typeof aplicarAlcanceEstado === 'function') aplicarAlcanceEstado();
  sincronizarSelectores();
  render({ encuadrar: true });
  avisar('Filtros restablecidos');
}

/** Clic sobre el mapa o sobre los botones de navegación cartográfica. */
function manejarSeleccionMapa(sel) {
  if (sel.nivel === 'pais')             { ESTADO.provK = ''; ESTADO.cantK = ''; ESTADO.parrK = ''; }
  else if (sel.nivel === 'volverProvincia') { ESTADO.cantK = ''; ESTADO.parrK = ''; }
  else if (sel.nivel === 'provincia')   { ESTADO.provK = sel.provK; ESTADO.cantK = ''; ESTADO.parrK = ''; }
  else if (sel.nivel === 'canton') {
    /* Un clic sobre el mismo cantón lo deselecciona. */
    if (ESTADO.cantK === sel.cantK && ESTADO.provK === sel.provK) { ESTADO.cantK = ''; ESTADO.parrK = ''; }
    else { ESTADO.provK = sel.provK; ESTADO.cantK = sel.cantK; ESTADO.parrK = ''; }
  }
  else if (sel.nivel === 'parroquia') {
    /* Un clic sobre la misma parroquia la deselecciona. */
    if (ESTADO.parrK === sel.parrK && ESTADO.cantK === sel.cantK) ESTADO.parrK = '';
    else { ESTADO.provK = sel.provK; ESTADO.cantK = sel.cantK; ESTADO.parrK = sel.parrK; }
  }
  ESTADO.pagina = 1;
  sincronizarSelectores();
  render({ encuadrar: true });
}


/* ============================================================================
   RENDER PRINCIPAL
   ========================================================================== */

function render(opts = {}) {
  /* Indicador ligero: el velo a pantalla completa se reserva para la carga
     inicial y la importación de archivos, que sí bloquean la vista.
     Las actualizaciones de fondo (capas diferidas) se repintan en silencio. */
  if (!opts.silencioso) mostrarProgreso(true);
  /* Se cede un frame al navegador para que el indicador alcance a pintarse. */
  requestAnimationFrame(() => setTimeout(() => {
    try {
      aplicarTemaDignidad();

      const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);

      /* El agregado del mapa siempre es nacional: así el ranking y el color
         de contexto conservan sentido comparativo aunque se filtre. */
      VISTA.agregado = agregar(ESTADO.dignidad, dig.nivel);
      VISTA.registros = filtrarRegistros();

      pintarMapa(ESTADO, VISTA.agregado);
      if (opts.encuadrar) encuadrar(ESTADO, opts.animar !== false);

      actualizarKPIs();
      actualizarPanelTerritorial();
      actualizarRuta();
      actualizarTabla();
      actualizarResultados();
      actualizarGraficos(ESTADO, VISTA.agregado, VISTA.registros);
      /* Bloque de grupo etario, añadido al final de esta página. Vive en
         js/secciones.js y se salta si ese archivo no está cargado. */
      if (typeof actualizarEtario === 'function') actualizarEtario();
      /* Bloque de juntas y recintos del territorio (js/recintos.js), si existe. */
      if (typeof actualizarRecintos === 'function') actualizarRecintos();
    } catch (e) {
      mostrarError(e.message, e);
    } finally {
      if (!opts.silencioso) mostrarProgreso(false);
    }
  }, 0));
}

/** Tiñe la interfaz con el acento de la dignidad activa. */
function aplicarTemaDignidad() {
  const p = CONFIG.paleta[ESTADO.dignidad];
  const r = document.documentElement.style;
  r.setProperty('--acento', p.acento);
  p.rampa.forEach((c, i) => r.setProperty(`--rampa-${i + 1}`, c));
  document.body.dataset.dignidad = ESTADO.dignidad;
  const grupo = grupoDe(ESTADO.dignidad);
  qa('[data-dig-h]').forEach(s =>
    s.classList.toggle('activo', s.dataset.digH === ESTADO.dignidad || s.dataset.digH === grupo));
}

/** Registros que cumplen los filtros activos (base de tabla y exportación). */
function filtrarRegistros() {
  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);
  return DATOS.registros.filter(r => {
    if (r.dignidad !== ESTADO.dignidad) return false;
    if (ESTADO.provK && r.provK !== ESTADO.provK) return false;
    /* Los registros de prefectos no tienen cantón: filtrar por él los
       eliminaría todos al conservar la selección entre dignidades. */
    if (dig.nivel !== 'provincia' && ESTADO.cantK && r.cantK !== ESTADO.cantK) return false;
    if (dig.nivel === 'parroquia' && ESTADO.parrK && r.parrKeyGeo !== ESTADO.parrK) return false;
    return true;
  });
}


/* ============================================================================
   TARJETAS DE INDICADORES
   ========================================================================== */

function actualizarKPIs() {
  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);
  const regs = VISTA.registros;
  const total = regs.reduce((a, r) => a + r.peso, 0);

  const provs = new Set(regs.map(r => r.provK));
  const cants = new Set(regs.filter(r => r.cantK).map(r => r.provK + '|' + r.cantK));
  const orgs  = new Set(regs.map(r => r.partido).filter(Boolean));

  q('#kpi-total').textContent = fmtNum(total);
  q('#kpi-total-sub').textContent = `${dig.etiqueta} · ${fmtNum(regs.length)} registros`;

  q('#kpi-provincias').textContent = fmtNum(provs.size);
  q('#kpi-provincias-sub').textContent =
    `de ${fmtNum(provinciasSeleccionables().length)} provincias`;

  /* Cantones del mapa, más los que la base trae sin polígono (Sevilla Don
     Bosco, posterior a la cartografía): así el «de N» nunca queda por debajo
     de los cantones contados. */
  const cantonesGeo = ESTADO.provK
    ? ((TERRITORIO.porProvK.get(ESTADO.provK) || {}).cantones || [])
    : TERRITORIO.cantones;
  const totalCantonesGeo = new Set(cantonesGeo.map(c => c.provK + '|' + c.key)
    .concat([...cants])).size;
  /* Los prefectos se eligen por provincia y no tienen cantón; el resto de
     dignidades sí, se analicen por cantón o por parroquia. */
  const porCanton = dig.nivel !== 'provincia';
  q('#kpi-cantones').textContent = porCanton ? fmtNum(cants.size) : '—';
  q('#kpi-cantones-sub').textContent = porCanton
    ? `de ${fmtNum(totalCantonesGeo)} cantones`
    : 'no aplica en análisis provincial';

  q('#kpi-organizaciones').textContent = fmtNum(orgs.size);
  q('#kpi-organizaciones-sub').textContent = orgs.size
    ? 'con al menos un preinscrito' : 'sin columna de organización';

  q('#kpi-territorio').textContent = etiquetaTerritorio(true);
  q('#kpi-territorio-sub').textContent = parroquiaEnFoco() ? 'Parroquia seleccionada'
    : ESTADO.cantK ? 'Cantón seleccionado'
    : ESTADO.provK ? 'Provincia seleccionada' : 'Cobertura nacional';
}

/** Parroquia enfocada, solo si la dignidad se analiza por parroquia. */
function parroquiaEnFoco() {
  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);
  if (!dig || dig.nivel !== 'parroquia' || !ESTADO.parrK) return null;
  return TERRITORIO.porParrK.get(ESTADO.provK + '|' + ESTADO.cantK + '|' + ESTADO.parrK) || null;
}

function etiquetaTerritorio(corto = false) {
  const parr = parroquiaEnFoco();
  if (parr) return tituloCase(parr.nombre);
  if (ESTADO.cantK) {
    const c = TERRITORIO.porCantK.get(ESTADO.provK + '|' + ESTADO.cantK);
    return c ? tituloCase(c.nombre) : '—';
  }
  if (ESTADO.provK) {
    const p = TERRITORIO.porProvK.get(ESTADO.provK);
    return p ? tituloCase(p.nombre) : '—';
  }
  return corto ? 'Ecuador' : 'Todo el país';
}


/* ============================================================================
   PANEL DE ANÁLISIS TERRITORIAL
   ========================================================================== */

/** Suma las filas del agregado que cumplen una condición, como un territorio. */
function resumenAgregado(cumple, geo) {
  const sub = VISTA.agregado.filas.filter(cumple);
  const v = sub.reduce((a, f) => a + f.valor, 0);
  const total = VISTA.agregado.total;
  return { nombre: geo.nombre, valor: v, pct: total ? v * 100 / total : 0,
           ranking: null, agrupado: sub.length,
           poblacion: geo.poblacion || 0, electores: geo.electores || 0 };
}

function actualizarPanelTerritorial() {
  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);
  const total = VISTA.agregado.total;

  let fila = null;
  if (dig.nivel === 'provincia' && ESTADO.provK) {
    fila = VISTA.agregado.indice.get(ESTADO.provK);
  } else if (dig.nivel === 'parroquia' && ESTADO.parrK) {
    fila = VISTA.agregado.indice.get(ESTADO.provK + '|' + ESTADO.cantK + '|' + ESTADO.parrK);
  } else if (dig.nivel !== 'provincia' && ESTADO.cantK) {
    /* Con una dignidad parroquial y solo el cantón elegido, el panel resume
       sus parroquias, igual que la provincia resume sus cantones. */
    fila = dig.nivel === 'canton'
      ? VISTA.agregado.indice.get(ESTADO.provK + '|' + ESTADO.cantK)
      : resumenAgregado(f => f.provK === ESTADO.provK && f.cantK === ESTADO.cantK,
                        TERRITORIO.porCantK.get(ESTADO.provK + '|' + ESTADO.cantK) || {});
  } else if (dig.nivel !== 'provincia' && ESTADO.provK) {
    /* Resumen agregado de la provincia sobre el total nacional. */
    fila = resumenAgregado(f => f.provK === ESTADO.provK,
                           TERRITORIO.porProvK.get(ESTADO.provK) || {});
  }

  const p = ESTADO.provK ? tituloCase((TERRITORIO.porProvK.get(ESTADO.provK) || {}).nombre) : '—';
  const c = ESTADO.cantK ? tituloCase((TERRITORIO.porCantK.get(ESTADO.provK + '|' + ESTADO.cantK) || {}).nombre) : '—';
  const parr = parroquiaEnFoco();

  q('#pt-provincia').textContent = p;
  q('#pt-canton').textContent = dig.nivel === 'provincia' ? (ESTADO.cantK ? c : '—') : c;
  /* La fila de parroquia solo aparece con una dignidad parroquial. */
  const filaParr = q('#pt-fila-parroquia');
  if (filaParr) {
    filaParr.hidden = dig.nivel !== 'parroquia';
    q('#pt-parroquia').textContent = parr ? tituloCase(parr.nombre) : '—';
  }
  q('#pt-dignidad').textContent = dig.etiqueta;
  q('#pt-nivel').textContent = dig.nivel === 'provincia' ? 'Provincial'
    : dig.nivel === 'parroquia' ? 'Parroquial' : 'Cantonal';

  if (fila) {
    q('#pt-preinscritos').textContent = fmtNum(fila.valor);
    q('#pt-barra').style.width = Math.min(100, fila.pct * 3.2).toFixed(1) + '%';
    q('#panel-territorial').classList.remove('vacio');
  } else {
    q('#pt-preinscritos').textContent = fmtNum(total);
    q('#pt-barra').style.width = '100%';
    q('#panel-territorial').classList.add('vacio');
  }

  /* Electores del territorio filtrado. Sin filtro se usa el total nacional
     del distributivo, que incluye los cantones sin geometría en el mapa. */
  let padron;
  if (fila) padron = fila.electores || 0;
  /* Con una parroquia enfocada el padrón es el suyo, aunque no tenga
     candidaturas: el total del ámbito más amplio diría otra cosa. */
  else if (parr) padron = 0;
  else if (ELECTORES.disponible) padron = ELECTORES.total;
  else padron = VISTA.agregado.filas.reduce((a, f) => a + (f.electores || 0), 0);
  /* El padrón por parroquia no está en electores.json (va por cantón): sale
     del distributivo de recintos, que ya carga el bloque de electores. */
  if (!padron && parr && typeof electoresDeParroquia === 'function') {
    padron = electoresDeParroquia(parr.provK, parr.cantK, parr.key);
  }

  const valorRef = fila ? fila.valor : total;
  const fd = q('#pt-fila-densidad');
  if (padron > 0) {
    fd.hidden = false;
    q('#pt-poblacion').textContent = fmtNum(Math.round(padron));
    q('#pt-densidad').textContent = (valorRef * 100000 / padron)
      .toLocaleString('es-EC', { maximumFractionDigits: 1 });
  } else {
    fd.hidden = true;
  }
}

/** Ruta de niveles geográficos (Ecuador › Provincia › Cantón › Parroquia). */
function actualizarRuta() {
  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);
  const hayParr = TERRITORIO.parroquiasPorCant.size > 0;

  const nParr = ESTADO.cantK
    ? (TERRITORIO.parroquiasPorCant.get(ESTADO.provK + '|' + ESTADO.cantK) || []).length : 0;

  const estados = {
    pais:      { activo: !ESTADO.provK, disponible: true,
                 etiqueta: 'Ecuador' },
    provincia: { activo: !!ESTADO.provK && !ESTADO.cantK, disponible: !!ESTADO.provK,
                 etiqueta: ESTADO.provK ? tituloCase((TERRITORIO.porProvK.get(ESTADO.provK) || {}).nombre) : 'Provincia' },
    /* Solo el nivel más profundo queda marcado: con una parroquia elegida, el
       cantón es el camino, no el foco. */
    canton:    { activo: !!ESTADO.cantK && !parroquiaEnFoco(), disponible: !!ESTADO.cantK,
                 etiqueta: ESTADO.cantK ? tituloCase((TERRITORIO.porCantK.get(ESTADO.provK + '|' + ESTADO.cantK) || {}).nombre) : 'Cantón' },
    parroquia: { activo: !!parroquiaEnFoco(), disponible: hayParr && nParr > 0,
                 etiqueta: parroquiaEnFoco() ? tituloCase(parroquiaEnFoco().nombre)
                         : nParr ? `${nParr} parroquias` : 'Parroquia' }
  };

  qa('[data-nivel]').forEach(b => {
    const s = estados[b.dataset.nivel];
    b.classList.toggle('activo', s.activo);
    b.classList.toggle('inactivo', !s.disponible);
    b.disabled = !s.disponible;
    b.querySelector('.rt-etq').textContent = s.etiqueta;
  });

  q('#ruta-nivel-base').textContent = 'Nivel base: ' +
    (dig.nivel === 'provincia' ? 'provincial'
     : dig.nivel === 'parroquia' ? 'parroquial' : 'cantonal');
}


/* ============================================================================
   TABLA DE DATOS
   ========================================================================== */

const COLUMNAS_TABLA = {
  territorios: [
    { id: 'provincia', etq: 'Provincia',   tipo: 'texto' },
    { id: 'canton',    etq: 'Cantón',      tipo: 'texto' },
    { id: 'parroquia', etq: 'Parroquia',   tipo: 'texto' },
    { id: 'dignidad',  etq: 'Dignidad',    tipo: 'texto' },
    { id: 'valor',     etq: 'Preinscritos',tipo: 'num' },
    { id: 'pct',       etq: 'Porcentaje',  tipo: 'num' },
    { id: 'ranking',   etq: 'Ranking',     tipo: 'num' }
  ],
  preinscritos: [
    { id: 'provincia', etq: 'Provincia', tipo: 'texto' },
    { id: 'canton',    etq: 'Cantón',    tipo: 'texto' },
    /* Solo con una dignidad parroquial: ver columnasVista(). */
    { id: 'parroquia', etq: 'Parroquia', tipo: 'texto', soloParroquial: true },
    { id: 'lista',     etq: 'Lista',     tipo: 'num' },
    { id: 'partido',   etq: 'Organización política', tipo: 'texto' },
    { id: 'nombre',    etq: 'Preinscrito', tipo: 'texto' },
    { id: 'dignidad',  etq: 'Dignidad',  tipo: 'texto' }
  ]
};

/** Construye las filas planas de la vista de tabla activa. */
function construirFilasTabla() {
  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);

  if (ESTADO.vistaTabla === 'preinscritos') {
    return VISTA.registros.map(r => ({
      provincia: tituloCase(r.provincia),
      canton: r.canton ? tituloCase(r.canton) : '—',
      parroquia: r.parroquia ? tituloCase(r.parrNombreGeo || r.parroquia) : '—',
      lista: r.lista || '—',
      partido: r.partido ? tituloCase(r.partido) : '—',
      nombre: tituloCase(r.nombre) || '—',
      dignidad: dig.subtipos ? subtipoDignidad(r, dig) : dig.etiqueta
    }));
  }

  /* Vista de territorios: se agrega al nivel de la dignidad y se filtra. */
  const agg = agregar(ESTADO.dignidad, dig.nivel, {
    provK: ESTADO.provK,
    cantK: dig.nivel === 'provincia' ? '' : ESTADO.cantK,
    parrK: dig.nivel === 'parroquia' ? ESTADO.parrK : ''
  });
  const totalFiltrado = agg.total;

  return agg.filas.map(f => {
    /* El ranking se conserva respecto del universo nacional del nivel. */
    const global = VISTA.agregado.indice.get(
      dig.nivel === 'provincia' ? f.provK
      : dig.nivel === 'parroquia' ? f.provK + '|' + f.cantK + '|' + f.key
      : f.provK + '|' + f.key);
    return {
      provincia: tituloCase(f.provincia),
      canton: dig.nivel === 'canton' ? tituloCase(f.nombre)
            : dig.nivel === 'parroquia' ? tituloCase(f.canton) : '—',
      parroquia: dig.nivel === 'parroquia' ? tituloCase(f.nombre) : '—',
      dignidad: dig.etiqueta,
      valor: f.valor,
      pct: totalFiltrado ? f.valor * 100 / totalFiltrado : 0,
      ranking: global ? global.ranking : f.ranking
    };
  });
}

/**
 * Rótulo de una fila de concejales: urbanos, rurales o urbanos por
 * circunscripción (y cuál), según el texto original de la base.
 */
function subtipoDignidad(r, dig) {
  const t = normalizarTexto(r.dignidadTexto);
  const s = dig.subtipos.find(([clave]) => t.includes(normalizarTexto(clave)));
  const circ = normalizarTexto(r.circunscripcion).replace(/^CIRCUNSCRIPCION\s*/, '').toLowerCase();
  return (s ? s[1] : dig.etiqueta) + (circ ? ` (${circ})` : '');
}

/** Columnas de la vista activa: la de parroquia solo en dignidades parroquiales. */
function columnasVista() {
  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);
  return COLUMNAS_TABLA[ESTADO.vistaTabla]
    .filter(c => !c.soloParroquial || dig.nivel === 'parroquia');
}

function actualizarTabla() {
  const cols = columnasVista();
  let filas = construirFilasTabla();

  /* Búsqueda libre sobre todas las columnas de texto */
  if (ESTADO.busqueda) {
    const b = normalizarTexto(ESTADO.busqueda);
    filas = filas.filter(f => cols.some(c =>
      normalizarTexto(f[c.id]).includes(b)));
  }

  /* Ordenamiento */
  const oc = ESTADO.orden.col, od = ESTADO.orden.dir;
  const colDef = cols.find(c => c.id === oc);
  if (colDef) {
    filas.sort((a, b) => {
      if (colDef.tipo === 'num') {
        const x = parseFloat(a[oc]) || 0, y = parseFloat(b[oc]) || 0;
        return (x - y) * od;
      }
      return String(a[oc]).localeCompare(String(b[oc]), 'es') * od;
    });
  }

  VISTA.filasTabla = filas;

  /* Paginación */
  const porPag = CONFIG.tabla.filasPorPagina;
  const totalPag = Math.max(1, Math.ceil(filas.length / porPag));
  ESTADO.pagina = Math.min(ESTADO.pagina, totalPag);
  const desde = (ESTADO.pagina - 1) * porPag;
  const pagina = filas.slice(desde, desde + porPag);

  /* Encabezado */
  q('#tabla-cabecera').innerHTML = '<tr>' + cols.map(c => `
    <th data-col="${c.id}" class="${c.tipo === 'num' ? 'num' : ''} ${oc === c.id ? 'ord ' + (od > 0 ? 'asc' : 'desc') : ''}">
      <button type="button">${c.etq}<i></i></button></th>`).join('') + '</tr>';

  q('#tabla-cabecera').querySelectorAll('th').forEach(th => {
    th.querySelector('button').onclick = () => {
      const col = th.dataset.col;
      if (ESTADO.orden.col === col) ESTADO.orden.dir *= -1;
      else ESTADO.orden = { col, dir: cols.find(c => c.id === col).tipo === 'num' ? -1 : 1 };
      actualizarTabla();
    };
  });

  /* Cuerpo */
  if (!pagina.length) {
    q('#tabla-cuerpo').innerHTML =
      `<tr><td colspan="${cols.length}" class="td-vacio">
         No hay registros que coincidan con los filtros aplicados.
       </td></tr>`;
  } else {
    q('#tabla-cuerpo').innerHTML = pagina.map(f => '<tr>' + cols.map(c => {
      let v = f[c.id];
      if (c.id === 'pct') v = fmtPct(v);
      else if (c.id === 'valor') v = fmtNum(v);
      else if (c.id === 'ranking') v = '#' + v;
      const clase = c.tipo === 'num' ? 'num' : '';
      const fuerte = (c.id === 'valor') ? ' fuerte' : '';
      return `<td class="${clase}${fuerte}">${v}</td>`;
    }).join('') + '</tr>').join('');
  }

  /* Pie */
  const hasta = Math.min(desde + porPag, filas.length);
  q('#tabla-conteo').innerHTML = filas.length
    ? `Mostrando <b>${fmtNum(desde + 1)}–${fmtNum(hasta)}</b> de <b>${fmtNum(filas.length)}</b> registros`
    : 'Sin registros';

  q('#tabla-paginas').innerHTML = construirPaginacion(ESTADO.pagina, totalPag);
  q('#tabla-paginas').querySelectorAll('button[data-p]').forEach(b => {
    b.onclick = () => { ESTADO.pagina = parseInt(b.dataset.p, 10); actualizarTabla(); };
  });
}

function construirPaginacion(actual, total) {
  if (total <= 1) return '';
  const btn = (p, txt, extra = '') =>
    `<button type="button" data-p="${p}" ${extra}>${txt}</button>`;
  let h = btn(Math.max(1, actual - 1), '‹', actual === 1 ? 'disabled' : '');
  const paginas = new Set([1, total, actual, actual - 1, actual + 1]);
  const lista = [...paginas].filter(p => p >= 1 && p <= total).sort((a, b) => a - b);
  let prev = 0;
  lista.forEach(p => {
    if (p - prev > 1) h += '<span class="pg-sep">…</span>';
    h += `<button type="button" data-p="${p}" class="${p === actual ? 'activo' : ''}">${p}</button>`;
    prev = p;
  });
  h += btn(Math.min(total, actual + 1), '›', actual === total ? 'disabled' : '');
  return h;
}


/* ============================================================================
   EXPORTACIONES — respetan los filtros y la vista activa

   Los botones Excel, CSV y Descargar mapa se retiraron del panel lateral.
   Las funciones se conservan intactas: para recuperarlos basta con volver a
   añadir los botones en index.html y sus tres addEventListener en
   cablearInterfaz().
   ========================================================================== */

function nombreArchivo(ext) {
  const p = ESTADO.provK ? '_' + normalizarTexto(etiquetaTerritorio()).replace(/ /g, '-') : '';
  return `preinscritos_${ESTADO.dignidad.toLowerCase()}${p}_${ESTADO.vistaTabla}.${ext}`.toLowerCase();
}

/** Datos exportables: exactamente lo que la tabla muestra (sin paginar). */
function datosExportables() {
  const cols = columnasVista();
  return VISTA.filasTabla.map(f => {
    const o = {};
    cols.forEach(c => {
      let v = f[c.id];
      if (c.id === 'pct') v = Math.round(v * 10) / 10;
      o[c.etq.toUpperCase()] = v;
    });
    return o;
  });
}

function exportarExcel() {
  const datos = datosExportables();
  if (!datos.length) return avisar('No hay registros para exportar', true);
  const ws = XLSX.utils.json_to_sheet(datos);
  ws['!cols'] = Object.keys(datos[0]).map(k => ({
    wch: Math.min(38, Math.max(k.length + 2,
      ...datos.slice(0, 200).map(d => String(d[k] ?? '').length + 2))) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PREINSCRITOS');
  XLSX.writeFile(wb, nombreArchivo('xlsx'));
  avisar(`${fmtNum(datos.length)} registros exportados a Excel`);
}

function exportarCSV() {
  const datos = datosExportables();
  if (!datos.length) return avisar('No hay registros para exportar', true);
  const cab = Object.keys(datos[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [cab.join(';')].concat(
    datos.map(d => cab.map(k => esc(d[k])).join(';'))).join('\r\n');
  /* BOM para que Excel en Windows respete los acentos. */
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombreArchivo('csv');
  a.click();
  URL.revokeObjectURL(a.href);
  avisar(`${fmtNum(datos.length)} registros exportados a CSV`);
}


/* ============================================================================
   CARGA MANUAL DE EXCEL

   La zona para arrastrar un Excel también salió del panel lateral. La función
   sigue disponible si se quiere reponer ese control más adelante.
   ========================================================================== */

function cargarExcelManual(e) {
  const file = e.target.files[0];
  if (!file) return;
  mostrarCarga(true, 'Leyendo la base de preinscritos…');
  const lector = new FileReader();
  lector.onload = (ev) => {
    try {
      const filas = leerLibro(new Uint8Array(ev.target.result));
      if (!filas.length) throw new Error('La primera hoja del archivo está vacía.');
      aplicarBase(filas, false);
      ESTADO.provK = ''; ESTADO.cantK = ''; ESTADO.pagina = 1;
      sincronizarSelectores();
      avisosIniciales();
      render({ encuadrar: true });
      avisar(`Base cargada: ${fmtNum(DATOS.registros.length)} registros`);
    } catch (err) {
      mostrarError(err.message, err);
    } finally {
      mostrarCarga(false);
      e.target.value = '';
    }
  };
  lector.onerror = () => { mostrarCarga(false); mostrarError('No se pudo leer el archivo.'); };
  lector.readAsArrayBuffer(file);
}


/* ============================================================================
   RESULTADOS ELECTORALES 2023
   Responde a los mismos filtros que el resto del tablero: dignidad,
   provincia y cantón.
   ========================================================================== */

function actualizarResultados() {
  const seccion = q('#bloque-resultados');
  if (!seccion) return;

  /* Los resultados 2023 son de prefectos y alcaldes: con otra dignidad
     (concejales) el bloque no se muestra. */
  if (!RESULTADOS.disponible || !(RESULTADOS.registros || {})[ESTADO.dignidad]) {
    seccion.hidden = true; return;
  }
  seccion.hidden = false;

  const dig = CONFIG.dignidades.find(d => d.id === ESTADO.dignidad);
  const etiquetaDig = RESULTADOS.etiquetas[ESTADO.dignidad] || dig.etiqueta;

  /* El cantón solo acota cuando el análisis es cantonal; en análisis
     provincial la carrera de prefecto abarca toda la provincia. */
  const agg = agregarResultados(ESTADO.dignidad, ESTADO.provK, ESTADO.cantK);

  q('#res-anio').textContent = RESULTADOS.anio;
  q('#res-dignidad').textContent = etiquetaDig;
  q('#res-sub').textContent = subtituloResultados(agg, etiquetaDig);

  /* Fuera de un ámbito de elección único, el primer puesto no es un ganador
     sino el más votado del conjunto: la etiqueta lo dice. */
  q('#res-titulo-ganador').textContent = agg.unica
    ? 'Candidato ganador' : 'Candidato más votado';
  q('#res-sello').textContent = agg.unica ? 'Elección ' + RESULTADOS.anio
                                          : 'Agregado ' + RESULTADOS.anio;

  const g = agg.ganador;
  q('#res-nombre').textContent = g ? tituloCase(g.candidato) : '—';
  q('#res-op').textContent = g ? tituloCase(g.op) : 'Sin resultados para este territorio';
  q('#res-votos').textContent = g ? fmtNum(g.votos) : '—';
  q('#res-pct').textContent = g ? fmtPct(g.pct) : '—';

  actualizarResultadosParroquiales();

  const cuerpo = q('#res-cuerpo-tabla');
  if (!agg.filas.length) {
    cuerpo.innerHTML =
      `<tr><td colspan="5" class="res-vacio">
         No hay resultados de ${RESULTADOS.anio} para el territorio seleccionado.
       </td></tr>`;
    q('#res-conteo').textContent = 'Sin candidaturas registradas';
    return;
  }

  cuerpo.innerHTML = agg.filas.map(f => `
    <tr class="${f.posicion === 1 ? 'res-primero' : ''}">
      <td class="num res-pos">${f.posicion}</td>
      <td class="fuerte">${escaparHTML(tituloCase(f.candidato))}</td>
      <td>${escaparHTML(tituloCase(f.op))}</td>
      <td class="num fuerte">${fmtNum(f.votos)}</td>
      <td class="num">${fmtPct(f.pct)}</td>
    </tr>`).join('');

  q('#res-conteo').innerHTML =
    `<b>${fmtNum(agg.filas.length)}</b> candidaturas · ` +
    `<b>${fmtNum(agg.total)}</b> votos válidos`;
}

/** Explica qué ámbito territorial se está sumando. */
function subtituloResultados(agg, etiquetaDig) {
  const territorio = etiquetaTerritorio();
  if (!agg.filas.length) return `${etiquetaDig} · ${territorio}`;

  if (agg.unica) {
    return `${etiquetaDig} · ${territorio} · ${agg.filas.length} candidaturas`;
  }
  const ambito = ESTADO.dignidad === 'ALCALDES'
    ? `${fmtNum(agg.elecciones)} elecciones cantonales`
    : `${fmtNum(agg.elecciones)} elecciones provinciales`;
  return `${etiquetaDig} · ${territorio} · votos sumados de ${ambito}`;
}


/* ============================================================================
   RESULTADOS 2023 POR PARROQUIA

   Pestaña plegable dentro del bloque de resultados: cerrada al empezar, se
   abre con el botón «Ver resultados por parroquia». Es un desglose del mismo
   dato que ya muestra el bloque —no lo sustituye— y sigue los filtros de
   provincia y cantón de Preinscritos:

     cantón    → cada parroquia con todas sus candidaturas
     provincia → cada parroquia con la más votada, agrupadas por cantón
     país      → cuántas parroquias y cuántos votos tiene cada provincia

   Los porcentajes se calculan sobre los votos válidos de cada parroquia.
   ========================================================================== */

/* Con más parroquias que estas, la lista abierta se desplaza dentro de su
   recuadro en vez de alargar la página. */
const RP_LISTA_LARGA = 12;

function actualizarResultadosParroquiales() {
  const cont = q('#res-parroquias');
  if (!cont) return;

  const parrs = (typeof resultadosPorParroquia === 'function')
    ? resultadosPorParroquia(ESTADO.dignidad, ESTADO.provK, ESTADO.cantK) : [];
  if (!parrs.length) { cont.hidden = true; cont.classList.remove('abierto'); return; }
  cont.hidden = false;

  const nivel = ESTADO.cantK ? 'canton' : ESTADO.provK ? 'provincia' : 'pais';
  const nom = (k) => tituloCase(k);
  const cuerpo = nivel === 'canton' ? rpPorParroquia(parrs)
               : nivel === 'provincia' ? rpPorCanton(parrs, nom)
               : rpPorProvincia(parrs, nom);

  const pie = { canton: 'Cada parroquia con todas sus candidaturas. El porcentaje es sobre los votos válidos de esa parroquia.',
                provincia: 'Se muestra la candidatura más votada de cada parroquia. Elige un cantón para ver todas las candidaturas de cada una.',
                pais: 'Elige una provincia y un cantón para ver los resultados de cada parroquia.' }[nivel];

  cont.innerHTML = `
    <header class="lm-col-cab lm-tab-cab">
      <h3 class="lm-col-tit">
        <button type="button" class="lm-tab" id="res-parr-tab"
                aria-expanded="${cont.classList.contains('abierto')}" aria-controls="res-parr-cuerpo"
                title="Mostrar u ocultar los resultados de cada parroquia">
          <span class="lm-tab-nombre">Ver resultados por parroquia (${RESULTADOS.anio})</span>
          <span class="lm-tab-der">
            <span class="lm-cuenta">${fmtNum(nivel === 'pais' ? new Set(parrs.map(p => p.provK)).size : parrs.length)}</span>
            <svg class="lm-tab-ico" width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </span>
        </button>
      </h3>
    </header>
    <div class="lm-plegable" id="res-parr-cuerpo" role="region" aria-labelledby="res-parr-tab">
      <div class="lm-plegable-in">
        ${cuerpo}
        <p class="lm-nota">${pie}</p>
      </div>
    </div>`;

  const tab = q('#res-parr-tab');
  if (tab) {
    tab.onclick = () => {
      const abierto = !cont.classList.contains('abierto');
      cont.classList.toggle('abierto', abierto);
      tab.setAttribute('aria-expanded', String(abierto));
    };
  }
}

/** Cantón: cada parroquia con su lista completa de candidaturas. */
function rpPorParroquia(parrs) {
  const html = parrs.map(p => `
        <section class="lm-grupo">
          <div class="lm-grupo-cab"><b>${escaparHTML(tituloCase(p.nombre))}</b>
            <span>${fmtNum(p.total)} votos válidos · ${fmtNum(p.filas.length)} candidaturas</span></div>
          <ol class="lm-lista">${p.filas.map(f => `
            <li><div class="lm-persona"><b>${f.posicion}. ${escaparHTML(tituloCase(f.candidato))}</b>
              <span>${escaparHTML(tituloCase(f.op))}</span></div>
              <em>${fmtNum(f.votos)} · ${fmtPct(f.pct)}</em></li>`).join('')}</ol>
        </section>`).join('');
  return parrs.length > RP_LISTA_LARGA ? `<div class="lm-scroll">${html}</div>` : html;
}

/** Provincia: sus parroquias, agrupadas por cantón, con la más votada. */
function rpPorCanton(parrs, nom) {
  const grupos = new Map();
  parrs.forEach(p => {
    if (!grupos.has(p.cantK)) grupos.set(p.cantK, []);
    grupos.get(p.cantK).push(p);
  });
  const html = [...grupos.entries()]
    .sort((a, b) => nom(a[0]).localeCompare(nom(b[0]), 'es'))
    .map(([cantK, ps]) => `
        <section class="lm-grupo">
          <div class="lm-grupo-cab"><b>${escaparHTML(nom(cantK))}</b>
            <span>${fmtNum(ps.length)} ${ps.length === 1 ? 'parroquia' : 'parroquias'}</span></div>
          <ol class="lm-lista">${ps.map(p => `
            <li><div class="lm-persona"><b>${escaparHTML(tituloCase(p.nombre))}</b>
              <span>${p.ganador ? escaparHTML(tituloCase(p.ganador.candidato)) + ' · ' +
                                   escaparHTML(tituloCase(p.ganador.op)) : 'Sin candidaturas'}</span></div>
              <em>${p.ganador ? fmtNum(p.ganador.votos) + ' · ' + fmtPct(p.ganador.pct) : '—'}</em></li>`).join('')}</ol>
        </section>`).join('');
  return `<div class="lm-scroll">${html}</div>`;
}

/** País: una línea por provincia, para no volcar 1.080 parroquias de golpe. */
function rpPorProvincia(parrs, nom) {
  const grupos = new Map();
  parrs.forEach(p => {
    if (!grupos.has(p.provK)) grupos.set(p.provK, { n: 0, votos: 0 });
    const g = grupos.get(p.provK);
    g.n++; g.votos += p.total;
  });
  const filas = [...grupos.entries()]
    .map(([provK, g]) => ({ nombre: nom(provK), ...g }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return `
        <section class="lm-grupo">
          <div class="lm-grupo-cab"><b>Por provincia</b>
            <span>${fmtNum(filas.length)} provincias</span></div>
          <ol class="lm-lista">${filas.map(f => `
            <li><div class="lm-persona"><b>${escaparHTML(f.nombre)}</b></div>
              <em>${fmtNum(f.n)} ${f.n === 1 ? 'parroquia' : 'parroquias'} · ${fmtNum(f.votos)} votos</em></li>`).join('')}</ol>
        </section>`;
}


/* ============================================================================
   ESTADOS DE INTERFAZ: CARGA, ERROR, AVISOS
   ========================================================================== */

let temporizadorCarga = null;
let temporizadorProgreso = null;

/** Barra fina bajo el encabezado: se usa al recalcular con nuevos filtros. */
function mostrarProgreso(activo) {
  const el = q('#barra-progreso');
  clearTimeout(temporizadorProgreso);
  if (activo) {
    el.hidden = false;
  } else {
    /* Un mínimo de permanencia evita el parpadeo en cálculos muy rápidos. */
    temporizadorProgreso = setTimeout(() => { el.hidden = true; }, 180);
  }
}

function mostrarCarga(activo, texto) {
  const el = q('#capa-carga');
  if (texto) el.querySelector('p').textContent = texto;
  clearTimeout(temporizadorCarga);
  if (activo) {
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('visible'));
  } else {
    el.classList.remove('visible');
    temporizadorCarga = setTimeout(() => { el.hidden = true; }, 220);
  }
}

/**
 * Muestra el panel de error.
 * @param {string} mensajeHTML  explicación para la persona (admite HTML)
 * @param {Error}  [error]      excepción original, para el detalle técnico
 *
 * Nunca debe quedar vacío: un panel que dice "algo falló" sin decir qué
 * es peor que no mostrar nada.
 */
function mostrarError(mensajeHTML, error) {
  const el = q('#capa-error');

  let html = (mensajeHTML || '').toString().trim();
  if (!html && error) html = escaparHTML(error.message || String(error));
  if (!html) html = 'Se produjo un error inesperado al preparar el tablero.';

  /* Detalle técnico plegado: no estorba en una demostración, pero está ahí
     cuando hace falta reportar el problema. */
  const tecnico = error && (error.stack || error.message)
    ? `<details class="error-tecnico">
         <summary>Ver detalle técnico</summary>
         <pre>${escaparHTML(String(error.stack || error.message))}</pre>
       </details>`
    : '';

  el.querySelector('#error-detalle').innerHTML = html + tecnico;
  el.hidden = false;

  /* La consola del navegador (F12) conserva la traza completa. */
  if (error) console.error('[Dashboard]', error);
}

function escaparHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function avisar(texto, esError = false) {
  const cont = q('#avisos');
  const el = document.createElement('div');
  el.className = 'aviso' + (esError ? ' error' : '');
  el.textContent = texto;
  cont.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, 2800);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
