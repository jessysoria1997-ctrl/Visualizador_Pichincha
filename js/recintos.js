/* ============================================================================
   recintos.js — ELECTORES · JUNTAS Y RECINTOS (dentro de Preinscritos)

   Bloque bajo el mapa de Preinscritos para el territorio seleccionado: el
   país, una provincia o un cantón. Reúne, desde el distributivo de recintos
   electorales (data/distributivo.json, generado con preparar_distributivo.py):

     · juntas receptoras del voto: total, femeninas y masculinas
     · recintos electorales, en una pestaña plegable: cerrada al empezar; al
       abrirla muestra la lista y sus puntos en el mapa de Preinscritos, y al
       cerrarla retira las dos cosas. La lista se adapta al ámbito:
         cantón    → cada recinto, agrupado por parroquia
         provincia → recintos y juntas de cada cantón
         país      → recintos y juntas de cada provincia

   No cambia nada de lo que ya existía: ni el panel de análisis territorial
   (electores y electores por 100 mil), ni los filtros, ni el mapa, que solo
   gana una capa de puntos mientras la pestaña de recintos está abierta.
   ========================================================================== */

const RECINTOS = {
  archivo: 'data/distributivo.json',
  datos: null,          // { lista: [recintos], nombres: {clave: nombre} }
  carga: null,          // promesa de la descarga, para pedir el archivo una vez
  pintado: null,        // ámbito que muestra el bloque ahora mismo
  capa: null,           // puntos del ámbito pintado
  visibles: false,      // pestaña de recintos abierta (lista y puntos)
  porParroquia: null,   // electores por parroquia de la capa (se arma al pedirlo)
  avisado: false        // ya se repintó una vez tras la primera descarga
};

/** Descarga el distributivo una sola vez; null si el archivo no está. */
function cargarRecintos() {
  if (!RECINTOS.carga) {
    RECINTOS.carga = fetch(RECINTOS.archivo, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null)
      .then(j => { RECINTOS.datos = j ? leerDistributivo(j) : null; return RECINTOS.datos; });
  }
  return RECINTOS.carga;
}

/**
 * Expande las filas compactas del archivo. A un usuario limitado a un
 * territorio se le quedan solo los recintos de ese territorio, igual que al
 * resto de bases (podarPorAlcance, en js/acceso.js).
 */
function leerDistributivo(j) {
  const a = (typeof alcanceClaves === 'function') ? alcanceClaves() : null;
  const lista = [];
  (j.recintos || []).forEach(([c, p, codigo, nombre, direccion, jf, jm, electores, lat, lon]) => {
    const [provK, cantK] = String(j.cantones[c]).split('|');
    if (a && (provK !== a.provK || (a.cantK && cantK !== a.cantK))) return;
    lista.push({ provK, cantK, parrI: p, parroquia: j.parroquias[p], codigo, nombre, direccion,
                 juntasF: jf, juntasM: jm, juntas: jf + jm, electores, lat, lon });
  });
  return { lista, nombres: j.nombres || {} };
}

/**
 * Electores de una parroquia de la cartografía, sumando los recintos que le
 * corresponden. electores.json trae el padrón por cantón, no por parroquia;
 * el distributivo sí llega a ese nivel y ya está descargado para este bloque.
 *
 * Los nombres del distributivo son los del CNE, que desglosa las parroquias
 * urbanas una por una: resolverParroquia() —la misma de js/data.js— las lleva
 * a su polígono (la cabecera cantonal), así que varios recintos pueden caer
 * en la misma parroquia del mapa.
 *
 * Devuelve 0 si el archivo aún no está o si la parroquia no tiene recintos.
 */
function electoresDeParroquia(provK, cantK, parrKey) {
  if (!RECINTOS.datos || !provK || !cantK || !parrKey) return 0;
  /* Sin la capa parroquial indexada no se puede emparejar: se espera a que
     llegue en vez de guardar un índice vacío. */
  if (typeof TERRITORIO === 'undefined' || !TERRITORIO.parroquiasPorCant.size) return 0;
  if (!RECINTOS.porParroquia) {
    const m = new Map();
    const cache = new Map();   // parroquia del CNE → parroquia de la capa
    RECINTOS.datos.lista.forEach(r => {
      const cruda = normalizarTexto(r.parroquia);
      const ck = r.provK + '|' + r.cantK + '|' + cruda;
      if (!cache.has(ck)) {
        cache.set(ck, (typeof resolverParroquia === 'function')
          ? resolverParroquia(r.provK, r.cantK, cruda) : cruda);
      }
      const geo = cache.get(ck);
      if (!geo) return;
      const k = r.provK + '|' + r.cantK + '|' + geo;
      m.set(k, (m.get(k) || 0) + (r.electores || 0));
    });
    RECINTOS.porParroquia = m;
  }
  return RECINTOS.porParroquia.get(provK + '|' + cantK + '|' + parrKey) || 0;
}

/**
 * Territorio del bloque: el de los filtros de Preinscritos. Un usuario
 * limitado solo tiene datos de su territorio, así que en un ámbito más amplio
 * (por ejemplo «Ecuador» en la ruta del mapa) el bloque sigue nombrándolo a él.
 */
function ambitoRecintos() {
  if (typeof ESTADO === 'undefined') return null;
  let provK = ESTADO.provK || '';
  let cantK = provK ? (ESTADO.cantK || '') : '';
  const a = (typeof alcanceClaves === 'function') ? alcanceClaves() : null;
  if (a) {
    if (!provK) provK = a.provK;
    if (a.cantK && !cantK) cantK = a.cantK;
  }
  if (cantK) return { nivel: 'canton', provK, cantK, clave: provK + '|' + cantK };
  if (provK) return { nivel: 'provincia', provK, clave: provK };
  return { nivel: 'pais', clave: '' };
}

function recintosDelAmbito(amb) {
  const L = RECINTOS.datos ? RECINTOS.datos.lista : [];
  if (amb.nivel === 'canton') return L.filter(r => r.provK === amb.provK && r.cantK === amb.cantK);
  if (amb.nivel === 'provincia') return L.filter(r => r.provK === amb.provK);
  return L;
}

/** Nombre con tildes de una provincia ('PROV') o de un cantón ('PROV|CANT'). */
function nombreTerritorio(clave) {
  const n = RECINTOS.datos && RECINTOS.datos.nombres[clave];
  if (n) return n;
  if (typeof TERRITORIO === 'undefined') return clave;
  const t = clave.includes('|') ? TERRITORIO.porCantK.get(clave) : TERRITORIO.porProvK.get(clave);
  return t ? t.nombre : clave.split('|').pop();
}

/**
 * Se llama en cada repintado de Preinscritos (ver render() en app.js).
 * Repinta el bloque cuando cambia el territorio y lo retira —con sus
 * puntos— si ese territorio no tiene recintos en la base.
 */
function actualizarRecintos() {
  const bloque = document.getElementById('bloque-electores');
  if (!bloque) return;

  /* Cualquier fallo aquí se queda aquí: el bloque es un añadido y no debe
     interrumpir el repintado del resto de Preinscritos. */
  const aislado = (fn) => { try { fn(); } catch (e) {
    console.warn('[Dashboard] bloque de electores omitido:', e);
    bloque.hidden = true;
  } };

  cargarRecintos().then(d => aislado(() => {
    /* El panel territorial saca de aquí el padrón parroquial (no está en
       electores.json): si cuando se pintó el archivo aún no había llegado, se
       rehace una vez, ya con los datos en memoria. */
    if (d && !RECINTOS.avisado) {
      RECINTOS.avisado = true;
      if (typeof actualizarPanelTerritorial === 'function') actualizarPanelTerritorial();
    }

    const amb = ambitoRecintos();
    const lista = (d && amb) ? recintosDelAmbito(amb) : [];
    if (!lista.length) {
      bloque.hidden = true;
      RECINTOS.pintado = null;
      quitarCapaRecintos();
      return;
    }
    if (RECINTOS.pintado !== amb.clave) {
      pintarRecintos(amb, lista);
      const tab = document.getElementById('lm-recintos-tab');
      if (tab) tab.onclick = () => aislado(() => ponerRecintos(!RECINTOS.visibles));
      /* Los puntos del territorio anterior se retiran: la capa se rehace
         con los del nuevo al mostrarla. */
      quitarCapaRecintos();
      RECINTOS.pintado = amb.clave;
    }
    bloque.hidden = false;
    ponerRecintos(RECINTOS.visibles);
  }));
}


/* ============================================================================
   CONTENIDO DEL BLOQUE
   ========================================================================== */

const lmEsc = (s) => (typeof escaparHTML === 'function')
  ? escaparHTML(s)
  : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const lmNombreParroquia = (k) => tituloCase(k);
const lmPlural = (n, uno, varios) => `${fmtNum(n)} ${n === 1 ? uno : varios}`;

/* Con más recintos que estos, la lista abierta se desplaza dentro de su
   propio recuadro en vez de alargar la página. */
const LM_LISTA_LARGA = 40;

function pintarRecintos(amb, lista) {
  const suma = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  const j = { total: suma(lista, 'juntas'), femeninas: suma(lista, 'juntasF'),
              masculinas: suma(lista, 'juntasM') };
  const pct = (n) => j.total ? fmtPct(n * 100 / j.total) + ' de las juntas' : '—';

  /* Grupos de la lista según el ámbito: parroquias del cantón, cantones de
     la provincia o provincias del país. */
  const agrupar = (clave) => {
    const m = new Map();
    lista.forEach(r => {
      const k = clave(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return m;
  };
  const grupos = amb.nivel === 'canton' ? agrupar(r => r.parrI)
               : amb.nivel === 'provincia' ? agrupar(r => r.provK + '|' + r.cantK)
               : agrupar(r => r.provK);
  const unidad = { canton: ['parroquia', 'parroquias'], provincia: ['cantón', 'cantones'],
                   pais: ['provincia', 'provincias'] }[amb.nivel];
  const totalDe = { canton: 'Total del cantón', provincia: 'Total de la provincia',
                    pais: 'Total del país' }[amb.nivel];

  document.getElementById('el-titulo').textContent =
    'Electores · ' + (amb.nivel === 'pais' ? 'Ecuador' : tituloCase(nombreTerritorio(amb.clave)));

  /* — Resumen: mismas tarjetas que los indicadores de la sección — */
  document.getElementById('lm-kpis').innerHTML = `
    <article class="kpi destacado">
      <p class="kpi-etq">Juntas receptoras</p>
      <p class="kpi-val">${fmtNum(j.total)}</p>
      <p class="kpi-sub">${totalDe}</p>
    </article>
    <article class="kpi">
      <p class="kpi-etq">Juntas femeninas</p>
      <p class="kpi-val">${fmtNum(j.femeninas)}</p>
      <p class="kpi-sub">${pct(j.femeninas)}</p>
    </article>
    <article class="kpi">
      <p class="kpi-etq">Juntas masculinas</p>
      <p class="kpi-val">${fmtNum(j.masculinas)}</p>
      <p class="kpi-sub">${pct(j.masculinas)}</p>
    </article>
    <article class="kpi">
      <p class="kpi-etq">Recintos electorales</p>
      <p class="kpi-val">${fmtNum(lista.length)}</p>
      <p class="kpi-sub">En ${lmPlural(grupos.size, ...unidad)}</p>
    </article>`;

  /* — Contenido de la pestaña —
       Cantón: cada recinto, agrupado por parroquia (en el orden de la capa
       parroquial, que es el del archivo). Provincia y país: un renglón por
       cantón o por provincia, ordenados por nombre. */
  let cuerpo;
  if (amb.nivel === 'canton') {
    cuerpo = [...grupos.values()].map(rs => `
          <section class="lm-grupo">
            <div class="lm-grupo-cab"><b>${lmEsc(lmNombreParroquia(rs[0].parroquia))}</b>
              <span>${fmtNum(rs.length)} ${rs.length === 1 ? 'recinto' : 'recintos'}</span></div>
            <ol class="lm-lista lm-recintos">${rs.map(r => `
              <li><div class="lm-persona"><b>${lmEsc(r.nombre)}</b></div>
                <em title="Juntas receptoras">${fmtNum(r.juntas)} JRV</em></li>`).join('')}</ol>
          </section>`).join('');
    if (lista.length > LM_LISTA_LARGA) cuerpo = `<div class="lm-scroll">${cuerpo}</div>`;
  } else {
    const filas = [...grupos.entries()]
      .map(([k, rs]) => ({ nombre: nombreTerritorio(k), rs }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    cuerpo = `
          <section class="lm-grupo">
            <div class="lm-grupo-cab"><b>Por ${unidad[0]}</b>
              <span>${lmPlural(filas.length, ...unidad)}</span></div>
            <ol class="lm-lista lm-recintos">${filas.map(f => `
              <li><div class="lm-persona"><b>${lmEsc(f.nombre)}</b></div>
                <em>${lmPlural(f.rs.length, 'recinto', 'recintos')} · ${fmtNum(suma(f.rs, 'juntas'))} JRV</em></li>`).join('')}</ol>
          </section>`;
  }

  document.getElementById('lm-recintos').innerHTML = `
    <header class="lm-col-cab lm-tab-cab">
      <h3 class="lm-col-tit">
        <button type="button" class="lm-tab" id="lm-recintos-tab"
                aria-expanded="false" aria-controls="lm-recintos-cuerpo"
                title="Mostrar u ocultar los recintos en la lista y en el mapa">
          <span class="lm-tab-nombre">Recintos electorales</span>
          <span class="lm-tab-der">
            <span class="lm-cuenta">${fmtNum(lista.length)}</span>
            <svg class="lm-tab-ico" width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round"
                 stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
          </span>
        </button>
      </h3>
    </header>
    <div class="lm-plegable" id="lm-recintos-cuerpo" role="region" aria-labelledby="lm-recintos-tab">
      <div class="lm-plegable-in">
        ${cuerpo}
        <p class="lm-nota">Fuente: distributivo de recintos electorales 2027. JRV: juntas receptoras del voto.${
          amb.nivel === 'canton' ? '' : ' Elige un cantón para ver cada uno de sus recintos.'}</p>
      </div>
    </div>`;
}


/* ============================================================================
   PUNTOS DE LOS RECINTOS EN EL MAPA
   Solo mientras la pestaña de recintos está abierta. Puntos pequeños y
   suaves: señalan la ubicación sin tapar el color del territorio. Con el
   país o una provincia en pantalla son aún más pequeños, porque se juntan
   muchos; al acercarse recuperan el tamaño de la vista de un cantón.
   ========================================================================== */

function tamañoPunto(zoom) {
  if (zoom >= 9) return { radio: 3.5, borde: 1 };
  if (zoom >= 8) return { radio: 2.8, borde: 0.8 };
  if (zoom >= 7) return { radio: 2.2, borde: 0.6 };
  return { radio: 1.8, borde: 0.5 };
}

function capaRecintos() {
  if (RECINTOS.capa || !RECINTOS.datos || typeof MAPA === 'undefined' || !MAPA.map) return RECINTOS.capa;
  const amb = ambitoRecintos();
  if (!amb) return null;
  if (!MAPA.map.getPane('paneRecintos')) {
    /* Por encima de rellenos, divisiones y selección; debajo de las etiquetas. */
    MAPA.map.createPane('paneRecintos').style.zIndex = 445;
  }
  const t = tamañoPunto(MAPA.map.getZoom());
  /* Con el país o una provincia en pantalla, la parroquia va con su cantón
     (una sola vez si se llaman igual, como en las cabeceras cantonales). */
  const lugar = (r) => {
    const parr = lmNombreParroquia(r.parroquia);
    if (amb.nivel === 'canton') return parr;
    const cant = tituloCase(nombreTerritorio(r.provK + '|' + r.cantK));
    return normalizarTexto(parr) === normalizarTexto(cant) ? cant : parr + ', ' + cant;
  };

  const capa = L.layerGroup(recintosDelAmbito(amb).map(r =>
    L.circleMarker([r.lat, r.lon], {
      pane: 'paneRecintos', radius: t.radio, bubblingMouseEvents: false,
      fill: true, fillColor: CONFIG.paleta.seleccion, fillOpacity: 0.72,
      stroke: true, color: '#FFFFFF', weight: t.borde, opacity: 0.9
    }).bindTooltip(() => `
      <div class="tt"><div class="tt-titulo">${lmEsc(r.nombre)}</div>
        <div class="tt-sub">${lmEsc(lugar(r))}${r.direccion ? ' · ' + lmEsc(r.direccion) : ''}</div>
        <div class="tt-metricas">
          <div><span>Juntas receptoras</span><b>${fmtNum(r.juntas)}</b></div>
          <div><span>Femeninas · masculinas</span><b>${fmtNum(r.juntasF)} · ${fmtNum(r.juntasM)}</b></div>
          <div><span>Electores</span><b>${fmtNum(r.electores)}</b></div>
        </div></div>`,
      { sticky: true, direction: 'top', className: 'tt-wrap', opacity: 1 })
    .on('mouseover', e => e.target.setStyle({
      radius: tamañoPunto(MAPA.map.getZoom()).radio + 1.5, fillOpacity: 0.95 }))
    .on('mouseout', e => e.target.setStyle({
      radius: tamañoPunto(MAPA.map.getZoom()).radio, fillOpacity: 0.72 }))));

  /* El tamaño sigue al zoom mientras la capa está en el mapa. */
  capa.on('add', () => MAPA.map.on('zoomend', ajustarPuntos));
  capa.on('remove', () => MAPA.map.off('zoomend', ajustarPuntos));
  RECINTOS.capa = capa;
  return capa;
}

function ajustarPuntos() {
  if (!RECINTOS.capa || !MAPA.map) return;
  const t = tamañoPunto(MAPA.map.getZoom());
  RECINTOS.capa.eachLayer(m => {
    if (m.options.radius !== t.radio || m.options.weight !== t.borde) {
      m.setStyle({ radius: t.radio, weight: t.borde });
    }
  });
}

function quitarCapaRecintos() {
  if (RECINTOS.capa && typeof MAPA !== 'undefined' && MAPA.map && MAPA.map.hasLayer(RECINTOS.capa)) {
    MAPA.map.removeLayer(RECINTOS.capa);
  }
  RECINTOS.capa = null;
}

/** Abre o cierra la pestaña de recintos: lista y puntos van juntos. */
function ponerRecintos(ver) {
  RECINTOS.visibles = !!ver && !!RECINTOS.datos && RECINTOS.pintado !== null;

  const col = document.getElementById('lm-recintos');
  const tab = document.getElementById('lm-recintos-tab');
  if (col) col.classList.toggle('abierto', RECINTOS.visibles);
  if (tab) tab.setAttribute('aria-expanded', String(RECINTOS.visibles));

  if (typeof MAPA === 'undefined' || !MAPA.map) return;
  if (RECINTOS.visibles) {
    const capa = capaRecintos();
    if (capa && !MAPA.map.hasLayer(capa)) capa.addTo(MAPA.map);
  } else if (RECINTOS.capa && MAPA.map.hasLayer(RECINTOS.capa)) {
    MAPA.map.removeLayer(RECINTOS.capa);
  }
}
