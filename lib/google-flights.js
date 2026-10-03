// lib/google-flights.js
// Lectura de Google Flights para los estudios (tarifas de Copa/American/
// LATAM, y escalas/duraciones de todas las aerolíneas).
//
// ESTRATEGIA: la URL de resultados (`/travel/flights/search?tfs=<base64>`)
// es un protobuf simple donde origen/destino/fecha van en texto plano. Hay
// UNA plantilla por ruta (capturada vía la UI real) y de ahí en adelante
// solo se reemplaza la fecha (10 caracteres, largo fijo, no hace falta
// recalcular longitudes). Sin formulario, sin clicks. Funciona con
// headless:true (a diferencia de Avianca/Gol, no hace falta xvfb).
//
// MONEDA: `&curr=USD` fuerza dólares. Los precios de Google son FINALES
// (impuestos y tasas incluidos).
//
// LISTA DE VUELOS: el aria-label de cada vuelo (.JMc5Xc) trae todo: precio,
// aerolínea(s), horarios, "Duración total" y cada escala con su duración y
// aeropuerto ("Esta escala (1 de 2) es una escala de 3 h 5 min en
// Aeropuerto ..."). No hace falta abrir páginas extra para duraciones.
//
// VUELOS COMBINADOS: "Vuelo con 2 escalas de Avianca y COPA" es un
// itinerario mixto. Para el estudio de una aerolínea solo cuentan los
// vuelos de la propia aerolínea (el nombre exacto, sin "y" ni comas).
//
// OPCIONES DE RESERVA: el precio de la lista es el más barato entre TODOS
// los vendedores (agencias, o una aerolínea socia). Para el precio de la
// propia aerolínea se abre la página de reserva del vuelo (/travel/flights/
// booking) y se lee el bloque "Reservar con <aerolínea>" marcado "Compañía
// aérea". Si ese bloque desglosa familias (American: Basic Economy / Main
// Cabin / Main Plus / Business) se leen todas.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Plantillas capturadas vía la UI real. La fecha dentro de cada una es el
// placeholder que se reemplaza (se detecta sola).
//   EZE-CCS / CCS-EZE: aeropuerto EZE, Caracas como ciudad.
//   CCS-MIA / MIA-CCS: aeropuertos CCS y MIA.
//   BUE-MIA / MIA-BUE: Buenos Aires como CIUDAD (/m/01ly5m, incluye EZE y
//     AEP), Miami como AEROPUERTO — con "Miami" ciudad Google mete Fort
//     Lauderdale (FLL).
const TEMPLATES = {
  "EZE-CCS": "CBwQAhojEgoyMDI2LTA5LTI2agcIARIDRVpFcgwIAxIIL20vMGZjeWpAAUgBcAGCAQsI____________AZgBAg",
  "CCS-EZE": "CBwQAhojEgoyMDI2LTA5LTI2agwIAxIIL20vMGZjeWpyBwgBEgNFWkVAAUgBcAGCAQsI____________AZgBAg",
  "CCS-MIA": "CBwQAhoeEgoyMDI2LTEwLTE1agcIARIDQ0NTcgcIARIDTUlBQAFIAXABggELCP___________wGYAQI",
  "MIA-CCS": "CBwQAhoeEgoyMDI2LTEwLTE1agcIARIDTUlBcgcIARIDQ0NTQAFIAXABggELCP___________wGYAQI",
  "BUE-MIA": "CBwQAhokEgoyMDI2LTEwLTE1ag0IAhIJL20vMDFseTVtcgcIARIDTUlBQAFIAXABggELCP___________wGYAQI",
  "MIA-BUE": "CBwQAhokEgoyMDI2LTEwLTE1agcIARIDTUlBcg0IAhIJL20vMDFseTVtQAFIAXABggELCP___________wGYAQI",
};

// `enLista`: nombre EXACTO de la aerolínea en el aria-label (un itinerario
// mixto "de LATAM y Delta" no matchea). `vendedor`: fila "Reservar con …".
const AEROLINEAS = {
  copa: { nombre: "Copa", enLista: /^copa$/i, vendedor: /^copa( airlines)?$/i },
  american: { nombre: "American", enLista: /^american$/i, vendedor: /^american( airlines)?$/i },
  latam: { nombre: "LATAM", enLista: /^latam$/i, vendedor: /^latam( airlines)?$/i },
  avianca: { nombre: "Avianca", enLista: /^avianca$/i, vendedor: /^avianca$/i },
  gol: { nombre: "Gol", enLista: /^gol$/i, vendedor: /^gol( linhas a[eé]reas)?$/i },
};

// Nombre del aeropuerto (como lo escribe Google) -> código IATA. Los que no
// estén acá quedan con el nombre completo (y se avisa por consola).
const AEROPUERTOS = [
  [/Tocumen/i, "PTY"], [/Arturo Merino/i, "SCL"], [/El Dorado/i, "BOG"], [/Jorge Ch[aá]vez/i, "LIM"],
  [/Guarulhos/i, "GRU"], [/Gale[aã]o/i, "GIG"], [/Santos Dumont/i, "SDU"], [/Aeropuerto Internacional de Miami/i, "MIA"],
  [/Ciudad de M[eé]xico|Benito Ju[aá]rez/i, "MEX"], [/Olmedo/i, "GYE"], [/Mariscal Sucre/i, "UIO"],
  [/Ezeiza/i, "EZE"], [/Jorge Newbery|Aeroparque/i, "AEP"], [/Maiquet[ií]a/i, "CCS"],
  [/Ernesto Cortissoz/i, "BAQ"], [/Jos[eé] Mar[ií]a C[oó]rdova/i, "MDE"], [/Alfonso Bonilla|Cali/i, "CLO"],
  [/Rafael N[uú][ñn]ez|Cartagena/i, "CTG"], [/Fort Lauderdale/i, "FLL"], [/Orlando/i, "MCO"],
  [/John F|Kennedy|JFK/i, "JFK"], [/Newark/i, "EWR"], [/Hartsfield|Atlanta/i, "ATL"], [/George Bush|Houston/i, "IAH"],
  [/Dallas/i, "DFW"], [/Charlotte/i, "CLT"], [/Washington Dulles|Dulles/i, "IAD"], [/Las Am[eé]ricas|Santo Domingo/i, "SDQ"],
  [/Punta Cana/i, "PUJ"], [/Canc[uú]n/i, "CUN"], [/Juan Santamar[ií]a|San Jos[eé] de Costa Rica/i, "SJO"],
  [/El Salvador|Monse[ñn]or/i, "SAL"], [/Curazao|Hato/i, "CUR"], [/Aruba|Reina Beatriz/i, "AUA"],
  [/Carrasco|Montevideo/i, "MVD"], [/Silvio Pettirossi|Asunci[oó]n/i, "ASU"], [/Bras[ií]lia/i, "BSB"],
  [/Afonso Pena|Curitiba/i, "CWB"], [/Salgado Filho|Porto Alegre/i, "POA"], [/Florian[oó]polis|Herc[ií]lio Luz/i, "FLN"],
  [/Recife|Guararapes/i, "REC"], [/Salvador|Lu[ií]s Eduardo/i, "SSA"], [/Fortaleza|Pinto Martins/i, "FOR"],
  [/Viracopos|Campinas/i, "VCP"], [/Confins|Tancredo Neves|Belo Horizonte/i, "CNF"], [/Comodoro Arturo Merino/i, "SCL"],
  [/Pudahuel/i, "SCL"], [/Francisco de Miranda|La Carlota/i, "CCS"], [/Presidente Peron|Panam[aá]|Albrook/i, "PAC"],
];

const avisados = new Set();
function codigoAeropuerto(nombre) {
  const entreParentesis = nombre.match(/\(([A-Z]{3})\)/)?.[1]; // "… Viru Viru (VVI) de …"
  if (entreParentesis) return entreParentesis;
  for (const [re, cod] of AEROPUERTOS) if (re.test(nombre)) return cod;
  if (!avisados.has(nombre)) {
    avisados.add(nombre);
    console.warn(`  [aviso] aeropuerto de escala sin código IATA conocido (queda el nombre): "${nombre}"`);
  }
  return nombre;
}

// ── tiempos y pausas ───────────────────────────────────────────────────────

const PAUSA_MIN_MS = 5_000;
const PAUSA_MAX_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pausa = () => sleep(PAUSA_MIN_MS + Math.random() * (PAUSA_MAX_MS - PAUSA_MIN_MS));

// Tiempos medidos, para el resumen final.
const tiempos = { busqueda: [], reserva: [] };

// ── URL ────────────────────────────────────────────────────────────────────

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const b64urlEncode = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function urlParaFecha(ruta, fechaISO) {
  const buf = b64urlDecode(TEMPLATES[ruta]);
  const idx = buf.toString("latin1").search(/\d{4}-\d{2}-\d{2}/);
  if (idx === -1) throw new Error(`No se encontró la fecha placeholder en la plantilla de ${ruta}`);
  const nuevo = Buffer.from(buf);
  nuevo.write(fechaISO, idx, "latin1");
  return `https://www.google.com/travel/flights/search?tfs=${b64urlEncode(nuevo)}&hl=es&curr=USD`;
}

// "1.026" / "1,026" / "638" -> número (Google redondea USD a enteros).
const aNumero = (s) => parseInt(s.replace(/[.,]/g, ""), 10);

// "8 h 4 min" / "17 h" / "56 min" -> minutos.
function aMinutos(txt) {
  const h = txt.match(/(\d+)\s*h/);
  const m = txt.match(/(\d+)\s*min/);
  if (!h && !m) return null;
  return (h ? parseInt(h[1], 10) * 60 : 0) + (m ? parseInt(m[1], 10) : 0);
}

// ── lista de vuelos ────────────────────────────────────────────────────────

// Parsea el aria-label maestro de un vuelo. Devuelve también las escalas
// con duración y aeropuerto, y las duraciones derivadas.
function parsearVuelo(masterLabel) {
  const precio = masterLabel.match(/A partir de ([\d.,]+) dólares estadounidenses/);
  const aerolinea = masterLabel.match(/Vuelo (?:directo|con [^.]*?)\s+de\s+([^.]+)\./)?.[1].trim() ?? null;
  const operador = masterLabel.match(/Operado por ([^.]+)\./)?.[1].trim() ?? null;
  const escalasN = /Vuelo directo/i.test(masterLabel)
    ? 0
    : parseInt(masterLabel.match(/Vuelo con (\d+) escalas?/)?.[1] ?? "0", 10);
  const horaSalida = masterLabel.match(/Sale de .*? a las (\d{1,2}:\d{2})\./)?.[1] ?? null;
  const horaLlegada = masterLabel.match(/Llega a .*? a las (\d{1,2}:\d{2})\./)?.[1] ?? null;
  const duracion = masterLabel.match(/Duración total: ([^.]*)\./);
  const duracion_total_min = duracion ? aMinutos(duracion[1]) : null;

  const paradas = [...masterLabel.matchAll(/Esta escala \(\d+ de \d+\) es una escala[^.]*? de ([^.]*?) en (.+?)\.(?=\s|$)/g)].map(
    (m) => ({ min: aMinutos(m[1]), aeropuerto: m[2].trim() })
  );
  // Si Google dice N escalas y no se pudieron leer las N, no se inventa:
  // los campos derivados quedan vacíos.
  const escalasOk = paradas.length === escalasN && paradas.every((p) => p.min != null);
  const conexion_min = escalasN === 0 ? 0 : escalasOk ? paradas.reduce((s, p) => s + p.min, 0) : null;

  return {
    aerolinea,
    // "Avianca y COPA", "Avianca, COPA y X": itinerario mixto.
    combinado: aerolinea != null && /\sy\s|,/.test(aerolinea),
    operador,
    hora_salida: horaSalida,
    hora_llegada: horaLlegada,
    escalas: escalasN,
    aeropuertos_escala: escalasN === 0 ? "" : escalasOk ? paradas.map((p) => codigoAeropuerto(p.aeropuerto)).join("/") : null,
    duracion_total_min,
    conexion_min,
    horas_vuelo_min: duracion_total_min != null && conexion_min != null ? duracion_total_min - conexion_min : null,
    precio_gf: precio ? aNumero(precio[1]) : null,
    masterLabel,
  };
}

async function extraerVuelos(page) {
  const labels = await page.$$eval("li.pIav2d", (els) =>
    els.filter((el) => el.offsetParent !== null).map((el) => el.querySelector(".JMc5Xc")?.getAttribute("aria-label") || "")
  );
  return labels.filter(Boolean).map(parsearVuelo);
}

async function irABusqueda(page, url) {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6_000); // la lista se completa de a poco
  tiempos.busqueda.push(Date.now() - t0);
}

// La lista muestra ~12 vuelos y esconde el resto detrás de "Ver más
// vuelos". Para las tarifas hace falta la lista completa: si no, una
// aerolínea cuyos vuelos quedaron en la parte colapsada figura "sin vuelos".
async function expandirLista(page) {
  const boton = page.getByRole("button", { name: "Ver más vuelos" });
  if (!(await boton.isVisible().catch(() => false))) return;
  const antes = await page.locator("li.pIav2d").filter({ visible: true }).count();
  await boton.evaluate((e) => e.click());
  await page
    .waitForFunction(
      (n) => [...document.querySelectorAll("li.pIav2d")].filter((e) => e.offsetParent).length > n,
      antes,
      { timeout: 15_000 }
    )
    .catch(() => null);
  await page.waitForTimeout(1_500);
}

// Desde la página de reserva: "atrás" restaura la misma lista (recargar a
// veces trae una lista distinta y el candidato no aparece). Si no vuelve,
// recarga.
async function volverABusqueda(page, url) {
  const t0 = Date.now();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
  const ok =
    page.url().includes("/travel/flights/search") &&
    (await page.locator("li.pIav2d").first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
  if (!ok) return irABusqueda(page, url);
  await page.waitForTimeout(2_000);
  tiempos.busqueda.push(Date.now() - t0);
}

// Identifica un vuelo por su aria-label SIN la frase del precio (al volver
// a la búsqueda el precio de la lista puede cambiar; lo demás no).
const claveVuelo = (label) => label.replace(/^(A partir de [^.]*|Precio total no disponible)\.\s*/, "");

async function buscarEnLista(page, masterLabel) {
  const clave = claveVuelo(masterLabel);
  const filas = page.locator("li.pIav2d .JMc5Xc").filter({ visible: true });
  const labels = await filas.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || ""));
  const i = labels.findIndex((l) => claveVuelo(l) === clave);
  return i === -1 ? null : filas.nth(i);
}

// ── opciones de reserva ────────────────────────────────────────────────────

const LINEA_PRECIO = /^(desde\s+)?([\d.,]+)\s*US\$$/;

// Bloque de un vendedor: "COPACompañía aérea\n469 US$\n714.996 ARS\n…" o,
// con familias, "AmericanCompañía aérea\nOcultar opciones\nBasic Economy\n
// 638 US$\n…\nMain Cabin\n746 US$\n…". Devuelve { nombre, esAerolinea,
// precio, desde, familias:[{nombre, precio}] }.
function parsearVendedor(bloque) {
  const lineas = bloque.split("\n").map((l) => l.trim()).filter(Boolean);
  const nombre = lineas[0].replace("Compañía aérea", "").trim();
  const esAerolinea = lineas[0].includes("Compañía aérea");
  const cuerpo = lineas.slice(1);
  const familias = [];
  for (let i = 0; i < cuerpo.length - 1; i++) {
    if (LINEA_PRECIO.test(cuerpo[i])) continue;
    const m = cuerpo[i + 1].match(LINEA_PRECIO);
    if (m && !m[1]) familias.push({ nombre: cuerpo[i], precio: aNumero(m[2]) });
  }
  const primerPrecio = cuerpo.map((l) => l.match(LINEA_PRECIO)).find(Boolean);
  return {
    nombre,
    esAerolinea,
    precio: primerPrecio ? aNumero(primerPrecio[2]) : null,
    desde: !!primerPrecio?.[1],
    familias,
  };
}

// Abre la página de reserva del vuelo (identificado por su aria-label sin
// precio, no por posición). Devuelve { vendedores, sinOpciones }.
async function leerOpcionesDeReserva(page, masterLabel) {
  let fila = await buscarEnLista(page, masterLabel);
  if (!fila) {
    // Al volver a la búsqueda la lista puede estar colapsada otra vez.
    await expandirLista(page);
    fila = await buscarEnLista(page, masterLabel);
  }
  if (!fila) throw new Error("el vuelo ya no aparece en la lista al volver a la búsqueda");

  const t0 = Date.now();
  // Un click normal lo intercepta un overlay de la fila; el handler está en
  // .JMc5Xc, así que se dispara directo sobre el elemento.
  await fila.evaluate((e) => e.click());
  await page.waitForURL(/\/travel\/flights\/booking\?/, { timeout: 30_000 });
  const resultado = await Promise.race([
    page.getByText(/^Reservar con /).first().waitFor({ timeout: 20_000 }).then(() => "vendedores", () => null),
    page.getByText(/No encontramos opciones de reserva/).first().waitFor({ timeout: 20_000 }).then(() => "sin_opciones", () => null),
  ]);
  if (resultado === "vendedores") await page.waitForTimeout(2_000); // pueden seguir llegando filas
  tiempos.reserva.push(Date.now() - t0);
  if (resultado !== "vendedores") return { vendedores: [], sinOpciones: resultado === "sin_opciones" };

  const texto = await page.evaluate(() => document.body.innerText);
  const ini = texto.indexOf("Opciones de reserva");
  let seccion = ini === -1 ? texto : texto.slice(ini);
  const fin = seccion.search(/El precio incluye|Información sobre precios/);
  if (fin !== -1) seccion = seccion.slice(0, fin);

  const vendedores = seccion.split(/Reservar con /).slice(1).map(parsearVendedor);
  return { vendedores, sinOpciones: false };
}

// Vuelos de la propia aerolínea (sin combinados), con precio en la lista,
// del más barato al más caro. `escalas` filtra por cantidad de escalas.
function vuelosPropios(vuelos, aerolineaId, escalas = null) {
  const cfg = AEROLINEAS[aerolineaId];
  return vuelos
    .filter((v) => !v.combinado && cfg.enLista.test(v.aerolinea ?? "") && (escalas == null || v.escalas === escalas))
    .filter((v) => v.precio_gf != null)
    .sort((a, b) => a.precio_gf - b.precio_gf);
}

function resumenTiempos(nombre, ms) {
  if (!ms.length) return `${nombre}: —`;
  const prom = ms.reduce((a, b) => a + b, 0) / ms.length;
  return `${nombre}: ${ms.length} página(s), promedio ${(prom / 1000).toFixed(1)}s, máx ${(Math.max(...ms) / 1000).toFixed(1)}s (sin contar pausas)`;
}

module.exports = {
  UA, TEMPLATES, AEROLINEAS, tiempos, pausa, sleep, urlParaFecha, parsearVuelo, extraerVuelos,
  irABusqueda, expandirLista, volverABusqueda, leerOpcionesDeReserva, vuelosPropios, resumenTiempos,
};
