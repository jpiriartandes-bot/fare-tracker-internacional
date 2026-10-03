// estudio.js
// Orquestador de los 3 estudios independientes. Cada uno corre todas sus
// fuentes y escribe SOLO su hoja del Sheet "Fare Tracker Internacional" y
// su propio CSV (output/estudio_<x>.csv):
//
//   node estudio.js --estudio=ccs-mia   -> hoja "CCS-MIA" (CCS<->MIA)
//   node estudio.js --estudio=eze-ccs   -> hoja "EZE-CCS" (EZE<->CCS) +
//                                          Frecuencias_Futuras
//   node estudio.js --estudio=bue-mia   -> hoja "BUE-MIA" (BUE<->MIA)
//
// Flags: --prueba (3 fechas por ruta, CSV en output/prueba/, SIN Sheets),
//        --ventanas=1,15,60 (anticipaciones a relevar).
//
// Se escribe a medida que avanza: después de CADA ruta/fecha va al CSV y a
// la hoja, así un corte a mitad de corrida no pierde el día entero.
// "Historico" está congelada: acá no se la lee ni se la escribe.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const gf = require("./lib/google-flights");
const { fila, appendCsv, prepararHoja, appendHoja, subirFrecuencias } = require("./lib/salida");
const { scrapeAvianca } = require("./scrapers/avianca");
const { scrapeGol } = require("./scrapers/gol");
const { scrapeLaser, FAMILIAS: FAMILIAS_LASER } = require("./scrapers/laser");

const ESTUDIOS = {
  "ccs-mia": {
    hoja: "CCS-MIA",
    csv: "estudio_ccs_mia.csv",
    rutas: ["CCS-MIA", "MIA-CCS"],
    // Orden de las filas dentro de cada ruta/fecha.
    fuentes: ["laser", "american", "copa", "avianca"],
    // Avianca: ¿Google muestra familias de tarifa? Si las muestra, una fila
    // por familia. (Verificado 2026-10-03: para los vuelos solo de Avianca
    // Google responde "No encontramos opciones de reserva".)
    familiasGoogleAvianca: true,
  },
  "eze-ccs": {
    hoja: "EZE-CCS",
    csv: "estudio_eze_ccs.csv",
    rutas: ["EZE-CCS", "CCS-EZE"],
    fuentes: ["avianca", "gol", "copa", "latam"],
    frecuenciasFuturas: true,
  },
  "bue-mia": {
    hoja: "BUE-MIA",
    csv: "estudio_bue_mia.csv",
    rutas: ["BUE-MIA", "MIA-BUE"],
    fuentes: ["copa", "latam"],
    escalas: 1, // solo itinerarios con 1 escala (Copa vía PTY, LATAM vía LIM/GRU)
  },
};

const arg = (nombre) => process.argv.find((a) => a.startsWith(`--${nombre}=`))?.slice(nombre.length + 3);
const PRUEBA = process.argv.includes("--prueba");
const ESTUDIO_ID = arg("estudio");
const VENTANAS_ARG = arg("ventanas")?.split(",").map(Number);
// Ventanas de anticipación: día 1 a 30 + un extra a día 60 (31 fechas).
// Con --prueba, 3 fechas por ruta.
const VENTANAS =
  VENTANAS_ARG ?? (PRUEBA ? [1, 15, 60] : [...Array.from({ length: 30 }, (_, i) => i + 1), 60]);

const NOMBRES_FAMILIA_AMERICAN = ["Basic Economy", "Main Cabin", "Main Plus"]; // Business se ignora

function fechaDesdeHoy(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ── armado de filas ────────────────────────────────────────────────────────

const base = (ctx, aerolinea) => ({
  fecha_busqueda: ctx.fechaBusqueda,
  ruta: ctx.ruta.replace("-", "_"),
  fecha_vuelo: ctx.fechaVuelo,
  dias_anticipacion: ctx.dias,
  aerolinea,
});

const detalle = (v) => ({
  hora_salida: v.hora_salida,
  hora_llegada: v.hora_llegada,
  escalas: v.escalas,
  aeropuertos_escala: v.aeropuertos_escala,
  duracion_total_min: v.duracion_total_min,
  conexion_min: v.conexion_min,
  horas_vuelo_min: v.horas_vuelo_min,
  operador: v.operador,
});

const filaError = (ctx, aerolinea, mensaje, fuente) =>
  fila({ ...base(ctx, aerolinea), fuente, nota: `ERROR: ${mensaje}` });

// Si quedó en la página de reserva, vuelve a la lista de búsqueda.
async function asegurarBusqueda(ctx) {
  if (ctx.page.url().includes("/travel/flights/search")) return;
  await gf.pausa();
  await gf.volverABusqueda(ctx.page, ctx.url);
}

// ── fuente: Laser (sitio, HTTP) ────────────────────────────────────────────

async function filasLaser(ctx) {
  const [origen, destino] = ctx.ruta.split("-");
  const r = await scrapeLaser({ origen, destino, fechaVuelo: ctx.fechaVuelo, tramoId: ctx.ruta });
  const b = base(ctx, "laser");
  if (!r.ok) return [filaError(ctx, "laser", r.error, "sitio_aerolinea")];
  if (!r.familias.length) {
    // Sin vuelo ese día: las 3 familias van igual, no disponibles.
    return FAMILIAS_LASER.map((f) =>
      fila({ ...b, tarifa: f, moneda: "USD", disponible: "no", fuente: "sitio_aerolinea", nota: r.nota })
    );
  }
  return r.familias.map((f) =>
    fila({
      ...b,
      tarifa: f.familia,
      // precio = base + cargos de aerolínea (sin tasas de gobierno);
      // total_con_tasas = average_amount del sitio.
      precio: f.precio,
      moneda: "USD",
      incluye_tasas: f.disponible ? "no" : "",
      total_con_tasas: f.total_con_tasas,
      disponible: f.disponible ? "si" : "no",
      hora_salida: f.hora_salida,
      hora_llegada: f.hora_llegada,
      escalas: f.escalas,
      aeropuertos_escala: f.escalas === 0 ? "" : null,
      duracion_total_min: f.duracion_total_min,
      conexion_min: f.escalas === 0 ? 0 : null,
      horas_vuelo_min: f.escalas === 0 ? f.duracion_total_min : null,
      operador: f.operador,
      numero_vuelo: f.numero_vuelo,
      fuente: "sitio_aerolinea",
      nota: f.disponible ? f.nota : f.nota ?? "agotada (rbd.posting = 0)",
    })
  );
}

// ── fuente: Avianca / Gol (precio del sitio; escalas y duraciones de GF) ───

const SCRAPERS_SITIO = { avianca: scrapeAvianca, gol: scrapeGol };

async function filasSitio(ctx, id) {
  const [origen, destino] = ctx.ruta.split("-");
  const r = await SCRAPERS_SITIO[id]({ origen, destino, fechaVuelo: ctx.fechaVuelo, tramoId: ctx.ruta });
  if (!r.ok) return [filaError(ctx, id, r.error, "sitio_aerolinea")];

  const nombre = gf.AEROLINEAS[id].nombre;
  // Escalas y duraciones: itinerario de la aerolínea SOLA en Google
  // Flights con menos escalas (nunca uno combinado con otra aerolínea).
  let vuelo = null;
  let notaGF;
  if (ctx.gfError) notaGF = `escalas y duraciones vacías: Google Flights falló (${ctx.gfError})`;
  else {
    // El precio del sitio no corresponde a un vuelo puntual de Google: se
    // toma el itinerario más representativo (menos escalas; a igual
    // cantidad, menor duración total; luego el más barato).
    vuelo =
      gf.vuelosPropios(ctx.vuelos, id).sort(
        (x, y) =>
          x.escalas - y.escalas ||
          (x.duracion_total_min ?? Infinity) - (y.duracion_total_min ?? Infinity) ||
          x.precio_gf - y.precio_gf
      )[0] ?? null;
    notaGF = vuelo
      ? `itinerario GF con menos escalas (solo ${nombre}, desempate por menor duración; US$ ${vuelo.precio_gf} en Google)`
      : `escalas y duraciones vacías: Google Flights no muestra un vuelo solo de ${nombre} con precio`;
  }

  const filas = [
    fila({
      ...base(ctx, id),
      precio: r.tarifa,
      moneda: r.moneda ?? "USD",
      // El calendario de precios no dice si incluye tasas: no verificado.
      disponible: r.tarifa != null ? "si" : "no",
      ...(vuelo ? detalle(vuelo) : {}),
      fuente: "sitio_aerolinea",
      nota: [r.nota, notaGF].filter(Boolean).join(" | "),
    }),
  ];

  // ¿Google muestra familias de tarifa de Avianca? Si sí, una fila por familia.
  if (id === "avianca" && ctx.estudio.familiasGoogleAvianca && vuelo) {
    try {
      await asegurarBusqueda(ctx);
      await gf.pausa();
      const { vendedores, sinOpciones } = await gf.leerOpcionesDeReserva(ctx.page, vuelo.masterLabel);
      const propia = vendedores.find((v) => v.esAerolinea && gf.AEROLINEAS.avianca.vendedor.test(v.nombre));
      if (propia?.familias.length) {
        for (const f of propia.familias) {
          filas.push(
            fila({
              ...base(ctx, id),
              tarifa: f.nombre,
              precio: f.precio,
              moneda: "USD",
              incluye_tasas: "si",
              total_con_tasas: f.precio,
              disponible: "si",
              ...detalle(vuelo),
              fuente: "google_flights",
              nota: "familia de tarifa de Avianca según Google Flights",
            })
          );
        }
      } else {
        filas[0].nota += sinOpciones
          ? " | Google no ofrece opciones de reserva de Avianca (sin familias)"
          : " | Google no desglosa familias de Avianca";
      }
    } catch (err) {
      filas[0].nota += ` | no se pudo consultar familias en Google: ${err.message.split("\n")[0]}`;
    }
  }
  return filas;
}

// ── fuente: Google Flights (Copa, LATAM, American) ─────────────────────────

async function filasGoogle(ctx, id) {
  const cfg = gf.AEROLINEAS[id];
  const b = { ...base(ctx, id), moneda: "USD", fuente: "google_flights" };
  if (ctx.gfError) return [fila({ ...b, nota: `ERROR: ${ctx.gfError}` })];

  const { escalas } = ctx.estudio;
  const candidatos = gf.vuelosPropios(ctx.vuelos, id, escalas ?? null).slice(0, id === "american" ? 3 : 2);
  if (!candidatos.length) {
    return [
      fila({
        ...b,
        disponible: "no",
        nota: `${cfg.nombre} no tiene vuelos propios con precio en Google Flights` + (escalas != null ? ` (con ${escalas} escala)` : ""),
      }),
    ];
  }

  // Precio de la PROPIA aerolínea: se abre la reserva de los vuelos más
  // baratos de la lista (el precio de la lista puede ser de una agencia o
  // de una socia). American: el primer vuelo donde American vende, con sus
  // familias. Copa/LATAM: el menor precio directo entre 2 candidatos.
  const errores = [];
  const otros = new Set();
  let mejor = null;
  for (const c of candidatos) {
    try {
      await asegurarBusqueda(ctx);
      await gf.pausa();
      const { vendedores } = await gf.leerOpcionesDeReserva(ctx.page, c.masterLabel);
      const propia = vendedores.find((v) => v.esAerolinea && cfg.vendedor.test(v.nombre) && v.precio != null);
      vendedores.filter((v) => v !== propia).forEach((v) => otros.add(v.nombre));
      if (propia && (!mejor || propia.precio < mejor.propia.precio)) mejor = { propia, vuelo: c };
      if (propia && id === "american") break;
    } catch (err) {
      errores.push(err.message.split("\n")[0]);
    }
  }

  if (!mejor) {
    if (errores.length === candidatos.length) return [fila({ ...b, nota: `ERROR: no cargó ninguna página de reserva: ${errores[0]}` })];
    return [
      fila({
        ...b,
        disponible: "no",
        nota:
          `${cfg.nombre} no aparece como vendedor en sus ${candidatos.length} vuelo(s) más barato(s)` +
          (otros.size ? ` (vendían: ${[...otros].join(", ")})` : ""),
      }),
    ];
  }

  const { propia, vuelo } = mejor;
  const comun = { ...b, moneda: "USD", incluye_tasas: "si", ...detalle(vuelo) };
  const notaErr = errores.length ? `${errores.length} de ${candidatos.length} página(s) de reserva fallaron: ${errores[0]}` : "";

  if (id === "american" && propia.familias.length) {
    return familiasAmerican(propia).map(({ nombre, f }) =>
      f
        ? fila({ ...comun, tarifa: nombre, precio: f.precio, total_con_tasas: f.precio, disponible: "si", nota: notaErr })
        : fila({ ...comun, tarifa: nombre, incluye_tasas: "", disponible: "no", nota: "Google no ofrece esta familia en este vuelo" })
    );
  }
  return [
    fila({
      ...comun,
      precio: propia.precio,
      total_con_tasas: propia.precio,
      disponible: "si",
      nota: [
        id === "american" ? "Google no desglosa familias de tarifa en este vuelo" : "",
        propia.desde ? "precio 'desde' (mínimo de varias clases)" : "",
        notaErr,
      ].filter(Boolean).join(" | "),
    }),
  ];
}

// Las 3 familias de American (Business ignorada), en orden fijo.
function familiasAmerican(propia) {
  return NOMBRES_FAMILIA_AMERICAN.map((nombre) => ({
    nombre,
    f: propia.familias.find((x) => x.nombre.toLowerCase() === nombre.toLowerCase()),
  }));
}

const FUENTES = {
  laser: (ctx) => filasLaser(ctx),
  avianca: (ctx) => filasSitio(ctx, "avianca"),
  gol: (ctx) => filasSitio(ctx, "gol"),
  american: (ctx) => filasGoogle(ctx, "american"),
  copa: (ctx) => filasGoogle(ctx, "copa"),
  latam: (ctx) => filasGoogle(ctx, "latam"),
};
const FUENTE_DE_ERROR = { laser: "sitio_aerolinea", avianca: "sitio_aerolinea", gol: "sitio_aerolinea" };

// ── corrida ────────────────────────────────────────────────────────────────

async function relevarRutaFecha(browser, estudio, ruta, dias, fechaBusqueda, tiemposFuente) {
  const fechaVuelo = fechaDesdeHoy(dias);
  const url = gf.urlParaFecha(ruta, fechaVuelo);
  const ctx = { estudio, ruta, dias, fechaVuelo, fechaBusqueda, url, page: null, vuelos: [], gfError: null, frecuencias: [] };
  ctx.page = await browser.newPage({ userAgent: gf.UA, viewport: { width: 1280, height: 900 } });
  const filas = [];
  try {
    try {
      await gf.irABusqueda(ctx.page, url);
      if (estudio.frecuenciasFuturas) {
        // Frecuencias: la lista tal como carga, sin expandir.
        const visibles = await gf.extraerVuelos(ctx.page);
        ctx.frecuencias = visibles.map((v) => ({
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
        console.log(`  Frecuencias: ${ctx.frecuencias.length} vuelo(s) visibles.`);
      }
      await gf.expandirLista(ctx.page);
      ctx.vuelos = await gf.extraerVuelos(ctx.page);
      console.log(`  ${ctx.vuelos.length} vuelo(s) en la lista completa.`);
      if (!ctx.vuelos.length) throw new Error("la lista de vuelos de Google Flights vino vacía");
    } catch (err) {
      ctx.gfError = err.message.split("\n")[0];
      console.log(`  FALLÓ Google Flights: ${ctx.gfError}`);
    }

    for (const fuente of estudio.fuentes) {
      const t0 = Date.now();
      try {
        const nuevas = await FUENTES[fuente](ctx);
        filas.push(...nuevas);
        for (const f of nuevas) {
          const precio = f.precio === "" ? "sin precio" : `${f.precio} ${f.moneda}`;
          console.log(
            `  ${fuente}${f.tarifa ? ` [${f.tarifa}]` : ""}: ${precio} — esc ${f.escalas === "" ? "?" : f.escalas}, ` +
              `${f.duracion_total_min === "" ? "?" : f.duracion_total_min + "min"}` +
              (f.nota ? ` — ${f.nota}` : "")
          );
        }
      } catch (err) {
        console.log(`  ${fuente}: FALLÓ — ${err.message.split("\n")[0]}`);
        filas.push(filaError(ctx, fuente, err.message.split("\n")[0], FUENTE_DE_ERROR[fuente] ?? "google_flights"));
      }
      tiemposFuente[fuente] = (tiemposFuente[fuente] ?? 0) + (Date.now() - t0);
    }
  } finally {
    await ctx.page.close();
  }
  return { filas, frecuencias: ctx.frecuencias, gfError: ctx.gfError };
}

async function main() {
  const estudio = ESTUDIOS[ESTUDIO_ID];
  if (!estudio) {
    console.error(`Uso: node estudio.js --estudio=${Object.keys(ESTUDIOS).join("|")} [--prueba] [--ventanas=1,15,60]`);
    process.exit(2);
  }
  const t0 = Date.now();
  const fechaBusqueda = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, "output", PRUEBA ? "prueba" : "");
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, estudio.csv);
  console.log(
    `Estudio ${ESTUDIO_ID} — hoja "${estudio.hoja}" — rutas ${estudio.rutas.join(", ")} — ` +
      `ventanas ${VENTANAS.join(",")} — CSV ${csvPath}` +
      (PRUEBA ? " (--prueba: sin Sheets)" : "")
  );

  if (!PRUEBA) await prepararHoja(estudio.hoja);

  const todas = [];
  const frecuencias = [];
  const pendientes = []; // filas que Sheets no aceptó (se reintentan)
  const tiemposFuente = {};
  const duraciones = [];
  let fallasGF = 0;

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  try {
    let primera = true;
    for (const ruta of estudio.rutas) {
      for (const dias of VENTANAS) {
        if (!primera) await gf.pausa();
        primera = false;
        console.log(`Relevando ${ruta} — ${fechaDesdeHoy(dias)} (+${dias}d)...`);
        const tRuta = Date.now();
        const res = await relevarRutaFecha(browser, estudio, ruta, dias, fechaBusqueda, tiemposFuente);
        duraciones.push(Date.now() - tRuta);
        console.log(`  (${((Date.now() - tRuta) / 1000).toFixed(0)}s con pausas)`);
        if (res.gfError) fallasGF++;
        todas.push(...res.filas);
        frecuencias.push(...res.frecuencias);

        appendCsv(csvPath, res.filas);
        if (!PRUEBA) {
          pendientes.push(...res.filas);
          try {
            const n = await appendHoja(estudio.hoja, pendientes);
            console.log(`  Sheets "${estudio.hoja}": ${n} fila(s) agregadas.`);
            pendientes.length = 0;
          } catch (err) {
            console.error(`  Sheets "${estudio.hoja}": error — ${err.message} (${pendientes.length} fila(s) pendientes)`);
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (pendientes.length) {
    console.log(`\nReintentando ${pendientes.length} fila(s) pendientes de "${estudio.hoja}"...`);
    try {
      await appendHoja(estudio.hoja, pendientes);
      pendientes.length = 0;
    } catch (err) {
      console.error(`  sigue fallando: ${err.message}`);
    }
  }

  const conPrecio = todas.filter((f) => f.precio !== "").length;
  const errores = todas.filter((f) => String(f.nota).startsWith("ERROR")).length;
  console.log(
    `\n${todas.length} fila(s): ${conPrecio} con precio, ${todas.filter((f) => f.disponible === "no").length} no disponibles, ` +
      `${errores} con error. Búsquedas de Google Flights caídas: ${fallasGF}.`
  );
  console.log(gf.resumenTiempos("Búsquedas GF", gf.tiempos.busqueda));
  console.log(gf.resumenTiempos("Opciones de reserva GF", gf.tiempos.reserva));
  for (const [f, ms] of Object.entries(tiemposFuente)) console.log(`Fuente ${f}: ${(ms / 60_000).toFixed(1)} min en total`);
  const prom = duraciones.reduce((a, b) => a + b, 0) / (duraciones.length || 1);
  console.log(
    `Por ruta/fecha: promedio ${(prom / 1000).toFixed(0)}s. TOTAL ${ESTUDIO_ID}: ${((Date.now() - t0) / 60_000).toFixed(1)} min ` +
      `(${duraciones.length} ruta/fecha).`
  );

  if (PRUEBA) {
    console.log("--prueba: no se sube a Google Sheets.");
    return;
  }

  // Frecuencias_Futuras (solo EZE-CCS): overwrite completo y de una vez.
  // Con 0 vuelos (todas las búsquedas caídas) no se toca, para no borrar la
  // foto anterior.
  if (estudio.frecuenciasFuturas) {
    if (frecuencias.length) {
      console.log(`\nSubiendo Frecuencias_Futuras (${frecuencias.length} vuelo(s))...`);
      await subirFrecuencias(frecuencias);
    } else console.warn("\nFrecuencias_Futuras: 0 vuelos relevados — no se reescribe la hoja.");
  }

  if (pendientes.length) {
    throw new Error(`${pendientes.length} fila(s) no se pudieron subir a "${estudio.hoja}" (están en ${csvPath})`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
