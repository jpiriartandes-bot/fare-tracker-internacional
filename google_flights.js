// google_flights.js
// Dos relevamientos sobre las mismas búsquedas de Google Flights:
//
//   A. FRECUENCIAS FUTURAS (Parte 2 del brief de frecuencias): cuántos
//      vuelos hay programados por día en EZE<->CCS, de TODAS las aerolíneas
//      juntas -> pestaña "Frecuencias_Futuras" (overwrite completo).
//
//   B. TARIFAS DE AEROLÍNEAS BLOQUEADAS EN SU PROPIO SITIO (2026-09-29):
//      Copa (DataDome), American y LATAM (Akamai) -> pestaña "Historico",
//      con fuente = "google_flights". Solo el precio que vende la PROPIA
//      aerolínea, nunca el de una agencia (ver "Opciones de reserva" abajo).
//
// ESTRATEGIA: Google Flights no expone una API JSON plana — usa RPCs
// internas ofuscadas tipo protobuf ("batchexecute"). En vez de pelear con
// eso, se aprovecha que la URL de resultados (`/travel/flights/search?tfs=
// <base64>`) es un protobuf simple donde el origen/destino/fecha están en
// texto plano dentro de los bytes. Se armó UNA plantilla por ruta (vía la
// UI real, una sola vez) y de ahí en adelante:
//   1. Se reemplaza la fecha (10 caracteres "YYYY-MM-DD", largo fijo) en el
//      string base64 decodificado — no hace falta recalcular ningún largo
//      de protobuf porque la fecha siempre mide lo mismo.
//   2. Se navega directo a la URL resultante — sin tocar el formulario,
//      sin calendario, sin clicks.
// Confirmado con headless:true real — a diferencia de Avianca/Gol, Google
// Flights NO bloquea headless, así que este scraper no necesita xvfb-run.
//
// MONEDA: `&curr=USD` en la URL fuerza dólares (probado 2026-09-29: el
// aria-label pasa a "A partir de N dólares estadounidenses"). Antes los
// precios venían en ARS por geolocalización.
//
// OPCIONES DE RESERVA (tarifas, parte B): el precio de la lista de vuelos
// es el más barato entre TODOS los vendedores (agencias incluidas, o una
// aerolínea socia: en BUE->MIA se vio un vuelo LATAM listado a 595 US$ que
// era el precio de Delta; LATAM mismo lo vendía a 674 US$). Por eso, para
// cada aerolínea se abren las páginas de reserva (/travel/flights/booking)
// de sus 2 vuelos más baratos de la lista y se lee SOLO la fila
// "Reservar con <aerolínea>" marcada "Compañía aérea". Se guarda el menor
// de esos precios directos. Si la aerolínea no aparece como vendedora, la
// fila va con precio null (ok:true) y una nota — nunca el precio de la
// lista ni el de una agencia.
//
// OJO metodología: Google Flights muestra precios FINALES, con impuestos y
// tasas incluidos — no son comparables 1:1 con las tarifas "sin impuestos"
// de los scrapers propios (metodología v2). La columna "fuente" los separa.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { google } = require("googleapis");
const { ensureHeader, appendToSheet } = require("./sheets");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SPREADSHEET_ID = "1JZOm3HFYzDAcCQ4GMV3sF77ZOq-GzpB_OPrtVBhxfbE";
const SHEET_NAME = "Frecuencias_Futuras";
const CREDS_FILE = path.join(__dirname, "credenciales-google.json");
const OUTPUT_DIR = path.join(__dirname, "output");

// --prueba: no escribe en Google Sheets (ni Frecuencias_Futuras ni
// Historico) y guarda el JSON en output/prueba/.
// --ventanas=1,15,60: releva solo esas anticipaciones (para pruebas).
// --rutas=BUE-MIA,MIA-BUE: releva solo esas rutas (lo usa cada job de la
// matrix del workflow, y sirve para pruebas).
// --csv=historico_gf_BUE_MIA.csv: nombre del CSV de tarifas de este job
// (va en output/, u output/prueba/ con --prueba).
// --sin-frecuencias / --sin-tarifas: saltea una de las dos partes.
const PRUEBA = process.argv.includes("--prueba");
const RUTAS_ARG = process.argv.find((a) => a.startsWith("--rutas="))?.slice(8).split(",");
const CSV_ARG = process.argv.find((a) => a.startsWith("--csv="))?.slice(6);
const SIN_FRECUENCIAS = process.argv.includes("--sin-frecuencias");
const SIN_TARIFAS = process.argv.includes("--sin-tarifas");
const VENTANAS_ARG = process.argv.find((a) => a.startsWith("--ventanas="))?.slice(11).split(",").map(Number);

// Plantillas capturadas vía la UI real (ver nota arriba). La fecha dentro
// de cada una es el placeholder que se reemplaza (se detecta sola, así que
// no importa que plantillas capturadas en días distintos tengan fechas
// distintas).
//   EZE-CCS / CCS-EZE (2026-09-26): aeropuerto EZE, Caracas como ciudad.
//   CCS-MIA / MIA-CCS (2026-09-29): aeropuertos CCS y MIA.
//   BUE-MIA / MIA-BUE (2026-09-29): Buenos Aires como CIUDAD (/m/01ly5m,
//     incluye EZE y AEP), Miami como AEROPUERTO — con "Miami" ciudad Google
//     mete Fort Lauderdale (FLL) en los resultados.
const TEMPLATES = {
  "EZE-CCS": "CBwQAhojEgoyMDI2LTA5LTI2agcIARIDRVpFcgwIAxIIL20vMGZjeWpAAUgBcAGCAQsI____________AZgBAg",
  "CCS-EZE": "CBwQAhojEgoyMDI2LTA5LTI2agwIAxIIL20vMGZjeWpyBwgBEgNFWkVAAUgBcAGCAQsI____________AZgBAg",
  "CCS-MIA": "CBwQAhoeEgoyMDI2LTEwLTE1agcIARIDQ0NTcgcIARIDTUlBQAFIAXABggELCP___________wGYAQI",
  "MIA-CCS": "CBwQAhoeEgoyMDI2LTEwLTE1agcIARIDTUlBcgcIARIDQ0NTQAFIAXABggELCP___________wGYAQI",
  "BUE-MIA": "CBwQAhokEgoyMDI2LTEwLTE1ag0IAhIJL20vMDFseTVtcgcIARIDTUlBQAFIAXABggELCP___________wGYAQI",
  "MIA-BUE": "CBwQAhokEgoyMDI2LTEwLTE1agcIARIDTUlBcg0IAhIJL20vMDFseTVtQAFIAXABggELCP___________wGYAQI",
};

// Parte A: solo EZE<->CCS, como siempre.
const RUTAS_FRECUENCIAS = ["EZE-CCS", "CCS-EZE"];

// Parte B: aerolíneas por ruta. `enLista` matchea el nombre que Google
// Flights pone en la lista ("Vuelo con 1 escala de COPA.") — exacto, así
// un itinerario mixto ("de LATAM y Delta") no cuenta. `vendedor` matchea
// la fila "Reservar con …" de la página de opciones de reserva.
const AEROLINEAS = {
  copa: { nombre: "Copa", enLista: /^copa$/i, vendedor: /^copa( airlines)?$/i },
  american: { nombre: "American", enLista: /^american$/i, vendedor: /^american( airlines)?$/i },
  latam: { nombre: "LATAM", enLista: /^latam$/i, vendedor: /^latam( airlines)?$/i },
};
const RUTAS_TARIFAS = {
  "EZE-CCS": { aerolineas: ["copa"] },
  "CCS-EZE": { aerolineas: ["copa"] },
  "CCS-MIA": { aerolineas: ["american", "copa"] },
  "MIA-CCS": { aerolineas: ["american", "copa"] },
  // Solo itinerarios con 1 escala (Copa vía PTY, LATAM vía LIM/GRU).
  "BUE-MIA": { aerolineas: ["copa", "latam"], escalas: 1 },
  "MIA-BUE": { aerolineas: ["copa", "latam"], escalas: 1 },
};
const CANDIDATOS_POR_AEROLINEA = 2;

// Ventanas de anticipación: mismas 31 fechas que el scraper de tarifas.
const VENTANAS = VENTANAS_ARG ?? [...Array.from({ length: 30 }, (_, i) => i + 1), 60];

// Pausa entre páginas (búsqueda, reserva, vuelta a la búsqueda).
const PAUSA_MIN_MS = 5_000;
const PAUSA_MAX_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pausa = () => sleep(PAUSA_MIN_MS + Math.random() * (PAUSA_MAX_MS - PAUSA_MIN_MS));

// Tiempos medidos, para el resumen final.
const tiempos = { busqueda: [], reserva: [] };

function b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function b64urlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function urlParaFecha(ruta, fechaISO) {
  const buf = b64urlDecode(TEMPLATES[ruta]);
  const idx = buf.toString("latin1").search(/\d{4}-\d{2}-\d{2}/);
  if (idx === -1) throw new Error(`No se encontró la fecha placeholder en la plantilla de ${ruta}`);
  const nuevoBuf = Buffer.from(buf);
  nuevoBuf.write(fechaISO, idx, "latin1");
  const tfs = b64urlEncode(nuevoBuf);
  return `https://www.google.com/travel/flights/search?tfs=${tfs}&hl=es&curr=USD`;
}

function fechaDesdeHoy(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// "1.026" / "1,026" / "638" -> número (Google Flights redondea USD a enteros).
const aNumero = (s) => parseInt(s.replace(/[.,]/g, ""), 10);

async function extraerVuelos(page) {
  const raw = await page.$$eval("li.pIav2d", (els) =>
    els
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const horaSalida = el.querySelector(".wtdjmc")?.textContent?.trim() || null;
        const horaLlegadaEl = el.querySelector(".XWcVob");
        const horaLlegada = horaLlegadaEl ? horaLlegadaEl.childNodes[0]?.textContent?.trim() : null;
        const escalasTexto = el.querySelector(".VG3hNb")?.textContent?.trim() || "";
        // .JMc5Xc es el primer div de la fila y siempre tiene un aria-label
        // completo (aerolínea, horarios, escalas, precio o "no disponible").
        // Usarlo como fuente única evita perder la aerolínea cuando el
        // precio no está disponible (ver nota en extraerVuelos).
        const masterLabel = el.querySelector(".JMc5Xc")?.getAttribute("aria-label") || "";
        return { horaSalida, horaLlegada, escalasTexto, masterLabel };
      })
  );

  return raw.map((r) => {
    // "Precio total no disponible" es un caso real (sin fare bookeable para
    // esa combinación) — precio_gf queda null a propósito, no es una falla
    // de extracción. La aerolínea sí está siempre presente en el patrón
    // "Vuelo directo de X." / "Vuelo con N escala(s) de X." independientemente
    // del precio.
    const precioMatch = r.masterLabel.match(/A partir de ([\d.,]+) dólares estadounidenses/);
    const precio_gf = precioMatch ? aNumero(precioMatch[1]) : null;
    const aerolineaMatch = r.masterLabel.match(/Vuelo (?:directo|con [^.]*?)\s+de\s+([^.]+)\./);
    const aerolinea = aerolineaMatch ? aerolineaMatch[1].trim() : null;
    const operador = r.masterLabel.match(/Operado por ([^.]+)\./)?.[1].trim() ?? null;
    const escalas = /directo|sin escalas/i.test(r.escalasTexto) ? 0 : parseInt(r.escalasTexto, 10) || 0;

    return {
      aerolinea,
      hora_salida: r.horaSalida,
      hora_llegada: r.horaLlegada,
      escalas,
      precio_gf,
      operador,
      masterLabel: r.masterLabel,
    };
  });
}

async function irABusqueda(page, url) {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6_000); // la lista se completa de a poco
  tiempos.busqueda.push(Date.now() - t0);
}

// La lista muestra ~12 vuelos y esconde el resto detrás de "Ver más
// vuelos" (2026-09-29: BUE->MIA +60d, 12 visibles de 23). Para las
// tarifas hace falta la lista completa: si no, una aerolínea cuyos vuelos
// quedaron en la parte colapsada figura como "sin vuelos".
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

// Desde la página de reserva: "atrás" restaura la misma lista de vuelos
// (recargar la URL a veces trae una lista distinta — 9 vs 19 vuelos en la
// misma búsqueda — y el candidato no aparece). Si no vuelve, recarga.
async function volverABusqueda(page, url) {
  const t0 = Date.now();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => null);
  const ok = page.url().includes("/travel/flights/search") &&
    (await page.locator("li.pIav2d").first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
  if (!ok) return irABusqueda(page, url);
  await page.waitForTimeout(2_000);
  tiempos.busqueda.push(Date.now() - t0);
}

// Identifica un vuelo de la lista por su aria-label SIN la frase del
// precio: al recargar la búsqueda el precio de la lista puede cambiar
// (visto en la prueba del 2026-09-29), pero aerolínea/horarios/escalas no.
const claveVuelo = (label) =>
  label.replace(/^(A partir de [^.]*|Precio total no disponible)\.\s*/, "");

async function buscarEnLista(page, masterLabel) {
  const clave = claveVuelo(masterLabel);
  const filas = page.locator("li.pIav2d .JMc5Xc").filter({ visible: true });
  const labels = await filas.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") || ""));
  const i = labels.findIndex((l) => claveVuelo(l) === clave);
  return i === -1 ? null : filas.nth(i);
}

// Abre la página de opciones de reserva del vuelo (identificado por su
// aria-label sin precio, no por posición) y devuelve los vendedores:
// [{ nombre, esAerolinea, precio }].
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
  // .JMc5Xc (jsaction click), así que se dispara directo sobre el elemento.
  await fila.evaluate((e) => e.click());
  await page.waitForURL(/\/travel\/flights\/booking\?/, { timeout: 30_000 });
  const hayVendedores = await page
    .getByText(/^Reservar con /)
    .first()
    .waitFor({ timeout: 20_000 })
    .then(() => true, () => false);
  if (hayVendedores) await page.waitForTimeout(2_000); // pueden seguir llegando filas
  tiempos.reserva.push(Date.now() - t0);
  if (!hayVendedores) return [];

  const texto = await page.evaluate(() => document.body.innerText);
  const ini = texto.indexOf("Opciones de reserva");
  let seccion = ini === -1 ? texto : texto.slice(ini);
  const fin = seccion.search(/El precio incluye|Información sobre precios/);
  if (fin !== -1) seccion = seccion.slice(0, fin);

  // Cada bloque: "Reservar con COPACompañía aérea\n469 US$\n714.996 ARS\n…"
  // (o "desde 638 US$" cuando hay varias clases tarifarias, que es el mínimo).
  return seccion
    .split(/Reservar con /)
    .slice(1)
    .map((bloque) => {
      const primeraLinea = bloque.split("\n")[0];
      const esAerolinea = primeraLinea.includes("Compañía aérea");
      const nombre = primeraLinea.replace("Compañía aérea", "").trim();
      const m = bloque.match(/([\d.,]+)\s*US\$/);
      return { nombre, esAerolinea, precio: m ? aNumero(m[1]) : null };
    });
}

function filaTarifa(ruta, aerolineaId, fechaVuelo, dias) {
  return {
    timestamp: new Date().toISOString(),
    tramo: ruta.replace("-", "_"),
    aerolinea: aerolineaId,
    fecha: fechaVuelo,
    dias_anticipacion: dias,
    tarifa: null,
    moneda: "USD",
    hora_salida: null,
    ok: true,
    operador: null,
    fuente: "google_flights",
    nota: null,
  };
}

// Parte B para una aerolínea en una ruta/fecha: devuelve la fila para
// "Historico" (mismo formato que los scrapers propios + fuente/nota).
async function tarifaDirecta(page, url, vuelos, { ruta, aerolineaId, escalas, fechaVuelo, dias }) {
  const cfg = AEROLINEAS[aerolineaId];
  const fila = filaTarifa(ruta, aerolineaId, fechaVuelo, dias);

  const candidatos = vuelos
    .filter((v) => cfg.enLista.test(v.aerolinea ?? "") && (escalas == null || v.escalas === escalas))
    .filter((v) => v.precio_gf != null)
    .sort((a, b) => a.precio_gf - b.precio_gf)
    .slice(0, CANDIDATOS_POR_AEROLINEA);

  if (candidatos.length === 0) {
    fila.nota =
      `${cfg.nombre} no tiene vuelos con precio en la lista de Google Flights` +
      (escalas != null ? ` (con ${escalas} escala)` : "");
    return fila;
  }

  const errores = [];
  const otrosVendedores = new Set();
  let mejor = null;
  for (const c of candidatos) {
    try {
      if (!page.url().includes("/travel/flights/search")) {
        await pausa();
        await volverABusqueda(page, url);
      }
      await pausa();
      const vendedores = await leerOpcionesDeReserva(page, c.masterLabel);
      const propia = vendedores.find((v) => v.esAerolinea && cfg.vendedor.test(v.nombre) && v.precio != null);
      vendedores.filter((v) => v !== propia).forEach((v) => otrosVendedores.add(v.nombre));
      if (propia && (mejor == null || propia.precio < mejor.precio)) {
        mejor = { precio: propia.precio, vuelo: c };
      }
    } catch (err) {
      errores.push(err.message.split("\n")[0]);
    }
  }

  if (mejor) {
    fila.tarifa = mejor.precio;
    fila.hora_salida = mejor.vuelo.hora_salida;
    fila.operador = mejor.vuelo.operador;
    if (errores.length) fila.nota = `${errores.length} de ${candidatos.length} página(s) de reserva fallaron: ${errores[0]}`;
  } else if (errores.length === candidatos.length) {
    fila.ok = false;
    fila.error = `no cargó ninguna página de reserva: ${errores[0]}`;
  } else {
    fila.nota =
      `${cfg.nombre} no aparece como vendedor en sus ${candidatos.length} vuelo(s) más barato(s)` +
      (otrosVendedores.size ? ` (vendían: ${[...otrosVendedores].join(", ")})` : "");
  }
  return fila;
}

async function relevarRutaFecha(browser, ruta, fechaVuelo, dias, fechaBusqueda) {
  const url = urlParaFecha(ruta, fechaVuelo);
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const aerolineasRuta = (!SIN_TARIFAS && RUTAS_TARIFAS[ruta]?.aerolineas) || [];
  const res = { frecuencias: [], tarifas: [], errorBusqueda: null };
  try {
    await irABusqueda(page, url);

    // Frecuencias: la lista tal como carga, sin expandir (mismo criterio
    // que antes de sumar las tarifas).
    if (!SIN_FRECUENCIAS && RUTAS_FRECUENCIAS.includes(ruta)) {
      const vuelosVisibles = await extraerVuelos(page);
      res.frecuencias = vuelosVisibles.map((v) => ({
        fecha_busqueda: fechaBusqueda,
        ruta,
        fecha_vuelo: fechaVuelo,
        aerolinea: v.aerolinea,
        hora_salida: v.hora_salida,
        hora_llegada: v.hora_llegada,
        escalas: v.escalas,
        precio_gf: v.precio_gf,
        moneda: "USD",
        fuente: "Google Flights",
      }));
      console.log(`  Frecuencias: ${res.frecuencias.length} vuelo(s) visibles.`);
    }

    if (aerolineasRuta.length === 0) return res;
    await expandirLista(page);
    const vuelos = await extraerVuelos(page);
    console.log(`  ${vuelos.length} vuelo(s) en la lista completa.`);

    for (const aerolineaId of aerolineasRuta) {
      const fila = await tarifaDirecta(page, url, vuelos, {
        ruta, aerolineaId, escalas: RUTAS_TARIFAS[ruta].escalas, fechaVuelo, dias,
      });
      console.log(
        `  ${aerolineaId}: ` +
          (fila.ok ? (fila.tarifa != null ? `${fila.tarifa} USD (${fila.hora_salida})` : "sin precio directo") : "FALLÓ") +
          (fila.nota || fila.error ? ` — ${fila.nota ?? fila.error}` : "")
      );
      res.tarifas.push(fila);
    }
  } catch (err) {
    res.errorBusqueda = err.message.split("\n")[0];
    // Una búsqueda caída deja sin dato a las aerolíneas de la ruta que
    // faltaban: fila ok:false para cada una, así queda registrado en Historico.
    for (const aerolineaId of aerolineasRuta) {
      if (res.tarifas.some((f) => f.aerolinea === aerolineaId)) continue;
      res.tarifas.push({ ...filaTarifa(ruta, aerolineaId, fechaVuelo, dias), ok: false, error: res.errorBusqueda });
    }
  } finally {
    await page.close();
  }
  return res;
}

async function uploadToSheets(rows) {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const tabExists = meta.data.sheets.some((s) => s.properties.title === SHEET_NAME);
  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_NAME } } }] },
    });
    console.log(`Pestaña "${SHEET_NAME}" creada.`);
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });

  const header = ["fecha_busqueda", "ruta", "fecha_vuelo", "aerolinea", "hora_salida", "hora_llegada", "escalas", "precio_gf", "moneda", "fuente"];
  const values = [
    header,
    ...rows.map((r) => [
      r.fecha_busqueda,
      r.ruta,
      r.fecha_vuelo,
      r.aerolinea ?? "",
      r.hora_salida ?? "",
      r.hora_llegada ?? "",
      r.escalas,
      r.precio_gf ?? "",
      r.moneda,
      r.fuente,
    ]),
  ];

  const updateRes = await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });

  console.log(`Sheets API confirmó: ${updateRes.data.updatedCells} celdas escritas (${updateRes.data.updatedRows} filas).`);
  return rows.length;
}

function resumenTiempos(nombre, ms) {
  if (!ms.length) return `${nombre}: —`;
  const prom = ms.reduce((a, b) => a + b, 0) / ms.length;
  return `${nombre}: ${ms.length} página(s), promedio ${(prom / 1000).toFixed(1)}s, máx ${(Math.max(...ms) / 1000).toFixed(1)}s (sin contar pausas)`;
}

// ── Escritura incremental de tarifas ───────────────────────────────────────
//
// Las filas de tarifas se escriben después de CADA ruta/fecha (CSV propio
// + pestaña "Historico"), no todo al final: si el job se corta (timeout,
// runner caído) no se pierde el día entero. El CSV es propio de cada job
// de la matrix (--csv=) — NO historico.csv, que lo escribe el workflow de
// tarifas — así los jobs en paralelo no chocan en git.

const CSV_HEADER =
  "fecha_busqueda,ruta,aerolinea,fecha_vuelo,dias_anticipacion,precio,moneda,hora_salida,ok,error,operador,fuente,nota\n";
const csvCampo = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function appendCsv(csvPath, filas) {
  if (!filas.length) return;
  const existe = fs.existsSync(csvPath);
  const lineas = filas
    .map((r) =>
      [r.timestamp, r.tramo, r.aerolinea, r.fecha, r.dias_anticipacion, r.tarifa, r.moneda, r.hora_salida,
        r.ok, r.error, r.operador, r.fuente, r.nota].map(csvCampo).join(",")
    )
    .join("\n");
  fs.appendFileSync(csvPath, (existe ? "" : CSV_HEADER) + lineas + "\n");
}

// Sube a "Historico" las filas pendientes; si Sheets falla, quedan en
// `pendientes` y se reintentan con la próxima ruta/fecha (y al final).
async function subirPendientes(pendientes) {
  if (!pendientes.length) return;
  try {
    const n = await appendToSheet(pendientes);
    console.log(`  Sheets "Historico": ${n} fila(s) agregadas.`);
    pendientes.length = 0;
  } catch (err) {
    console.error(`  Sheets "Historico": error — ${err.message} (${pendientes.length} fila(s) quedan pendientes)`);
  }
}

async function main() {
  const t0 = Date.now();
  const fechaBusqueda = new Date().toISOString().slice(0, 10);
  const frecuencias = [];
  const tarifas = [];
  const pendientesSheets = [];
  const duraciones = [];
  let fallas = 0;

  const rutas = Object.keys(TEMPLATES).filter(
    (r) =>
      (!RUTAS_ARG || RUTAS_ARG.includes(r)) &&
      ((!SIN_FRECUENCIAS && RUTAS_FRECUENCIAS.includes(r)) || (!SIN_TARIFAS && RUTAS_TARIFAS[r]))
  );
  // Frecuencias_Futuras se reescribe ENTERA: solo la toca el job que
  // releva EZE<->CCS. Los otros jobs de la matrix no la tocan (si no, la
  // vaciarían con una lista vacía).
  const escribeFrecuencias = !SIN_FRECUENCIAS && rutas.some((r) => RUTAS_FRECUENCIAS.includes(r));

  const outDir = PRUEBA ? path.join(OUTPUT_DIR, "prueba") : OUTPUT_DIR;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, path.basename(CSV_ARG ?? "historico_gf.csv"));
  console.log(`Rutas: ${rutas.join(", ")}. CSV de tarifas: ${csvPath}` + (PRUEBA ? " (--prueba: sin Sheets)" : ""));

  if (!PRUEBA && !SIN_TARIFAS) await ensureHeader();

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  try {
    let primera = true;
    for (const ruta of rutas) {
      for (const dias of VENTANAS) {
        if (!primera) await pausa();
        primera = false;
        const fechaVuelo = fechaDesdeHoy(dias);
        console.log(`Relevando ${ruta} — ${fechaVuelo} (+${dias}d)...`);
        const tRuta = Date.now();
        const res = await relevarRutaFecha(browser, ruta, fechaVuelo, dias, fechaBusqueda);
        duraciones.push(Date.now() - tRuta);
        console.log(`  (${((Date.now() - tRuta) / 1000).toFixed(0)}s con pausas)`);
        if (res.errorBusqueda) {
          fallas++;
          console.log(`  FALLÓ la búsqueda: ${res.errorBusqueda}`);
        }
        frecuencias.push(...res.frecuencias);
        tarifas.push(...res.tarifas);

        appendCsv(csvPath, res.tarifas);
        if (!PRUEBA) {
          pendientesSheets.push(...res.tarifas);
          await subirPendientes(pendientesSheets);
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (pendientesSheets.length) {
    console.log(`\nReintentando ${pendientesSheets.length} fila(s) pendientes de "Historico"...`);
    await subirPendientes(pendientesSheets);
  }

  const conPrecio = tarifas.filter((t) => t.tarifa != null).length;
  const sinVendedor = tarifas.filter((t) => t.ok && t.tarifa == null).length;
  const tarifasFallidas = tarifas.filter((t) => !t.ok).length;
  console.log(
    `\nFrecuencias: ${frecuencias.length} vuelo(s). Tarifas: ${tarifas.length} fila(s) — ` +
      `${conPrecio} con precio directo, ${sinVendedor} sin la aerolínea como vendedora, ${tarifasFallidas} fallidas. ` +
      `Búsquedas fallidas: ${fallas}.`
  );
  console.log(resumenTiempos("Búsquedas", tiempos.busqueda));
  console.log(resumenTiempos("Opciones de reserva", tiempos.reserva));
  if (duraciones.length) {
    const prom = duraciones.reduce((a, b) => a + b, 0) / duraciones.length;
    console.log(`Por ruta/fecha (con pausas): promedio ${(prom / 1000).toFixed(0)}s. Total: ${((Date.now() - t0) / 60_000).toFixed(1)} min.`);
  }

  const jsonPath = path.join(outDir, `google_flights_${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ frecuencias, tarifas }, null, 2));
  console.log(`JSON local: ${jsonPath}`);

  if (PRUEBA) {
    console.log("--prueba: no se sube a Google Sheets.");
    return;
  }

  // Frecuencias_Futuras va al final y de una sola vez: es un overwrite
  // completo, así que escribirla por partes dejaría la pestaña a medias si
  // el job se corta. Con 0 vuelos (todas las búsquedas caídas) no se toca,
  // para no borrar la foto anterior.
  if (escribeFrecuencias && frecuencias.length) {
    console.log(`\nSubiendo a Google Sheets (pestaña "${SHEET_NAME}")...`);
    const subidas = await uploadToSheets(frecuencias);
    console.log(`EXITO: ${subidas} fila(s) escritas en "${SHEET_NAME}".`);
  } else if (escribeFrecuencias) {
    console.warn(`\n${SHEET_NAME}: 0 vuelos relevados — no se reescribe la pestaña.`);
  }

  if (pendientesSheets.length) {
    // Quedaron en el CSV del job; que el workflow lo marque en rojo.
    throw new Error(`${pendientesSheets.length} fila(s) de tarifas no se pudieron subir a "Historico" (están en ${csvPath})`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
