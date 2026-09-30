// index.js
// Orquestador de la corrida: recorre rutas x aerolíneas x ventanas de
// anticipación de config.js, junta resultados y los guarda en output/
// (CSV + JSON) y en Google Sheets (pestaña "Historico").

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { scrapeAvianca } = require("./scrapers/avianca");
const { scrapeCopa } = require("./scrapers/copa");
const { scrapeGol } = require("./scrapers/gol");
const { scrapeAmerican } = require("./scrapers/american");
const { scrapeLaser } = require("./scrapers/laser");
const { scrapeLatam } = require("./scrapers/latam");
const { ensureHeader, appendToSheet } = require("./sheets");

const SCRAPERS = {
  avianca: scrapeAvianca,
  copa: scrapeCopa,
  gol: scrapeGol,
  american: scrapeAmerican,
  laser: scrapeLaser,
  latam: scrapeLatam,
};

const PRUEBA = process.argv.includes("--prueba");
// --solo=laser[,gol...]: releva solo esas aerolíneas (para pruebas).
const SOLO = process.argv.find((a) => a.startsWith("--solo="))?.slice(7).split(",") ?? null;

function fechaDesdeHoy(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function run() {
  const resultados = [];

  for (const ruta of config.rutas) {
    for (const aerolineaId of ruta.aerolineas) {
      if (SOLO && !SOLO.includes(aerolineaId)) continue;
      const scraper = SCRAPERS[aerolineaId];
      if (!scraper) {
        console.warn(`No hay scraper implementado para: ${aerolineaId}`);
        continue;
      }
      for (const dias of config.ventanas) {
        const fechaVuelo = fechaDesdeHoy(dias);

        console.log(`Relevando ${aerolineaId} — ${ruta.id} — ${fechaVuelo} (+${dias}d)...`);
        const resultado = await scraper({
          origen: ruta.origen,
          destino: ruta.destino,
          fechaVuelo,
          tramoId: ruta.id,
          dias,
        });
        resultado.dias_anticipacion = dias;
        resultados.push(resultado);
        console.log(
          resultado.ok
            ? `  OK: ${resultado.tarifa} ${resultado.moneda} — hora salida: ${resultado.hora_salida ?? "N/D"}`
            : `  FALLÓ: ${resultado.error}`
        );
      }
    }
  }

  // Guardar output local. Con --prueba va a output/prueba/ (ignorado por
  // git) y no se sube a Sheets: una corrida local de prueba no duplica
  // filas en el histórico real que commitea el workflow ni en la planilla.
  const outputDir = PRUEBA ? path.join(config.outputDir, "prueba") : config.outputDir;
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, `relevamiento_${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(resultados, null, 2));

  const csvPath = path.join(outputDir, "historico.csv");
  const csvExiste = fs.existsSync(csvPath);
  // "operador" (2026-09-28): aerolínea que opera el vuelo cuando no es la
  // que lo vende (ej. Laser CCS<->MIA lo opera GlobalX, G6). Columna nueva
  // al final: si el CSV ya existía con el encabezado viejo, se actualiza
  // solo esa primera línea — las filas anteriores quedan con la columna vacía.
  const header =
    "fecha_busqueda,ruta,aerolinea,fecha_vuelo,dias_anticipacion,precio,moneda,hora_salida,ok,error,operador\n";
  if (csvExiste) {
    const contenido = fs.readFileSync(csvPath, "utf8");
    const primeraLinea = contenido.slice(0, contenido.indexOf("\n") + 1);
    if (primeraLinea !== header) fs.writeFileSync(csvPath, header + contenido.slice(primeraLinea.length));
  }
  const filas = resultados
    .map(
      (r) =>
        `${r.timestamp},${r.tramo},${r.aerolinea},${r.fecha},${r.dias_anticipacion},${r.tarifa ?? ""},${r.moneda ?? ""},${r.hora_salida ?? ""},${r.ok},"${r.error ?? ""}",${r.operador ?? ""}`
    )
    .join("\n");
  fs.writeFileSync(csvPath, csvExiste ? filas + "\n" : header + filas + "\n", {
    flag: csvExiste ? "a" : "w",
  });

  console.log(`\nListo. JSON: ${jsonPath} | histórico acumulado: ${csvPath}`);

  if (PRUEBA) {
    console.log("--prueba: no se sube a Google Sheets.");
    return;
  }

  // Subir a Google Sheets (pestaña "Historico")
  try {
    await ensureHeader();
    const filasSubidas = await appendToSheet(resultados);
    console.log(`Google Sheets: ${filasSubidas} fila(s) agregada(s).`);
  } catch (err) {
    console.error(`Google Sheets: error al subir datos — ${err.message}`);
  }
}

run();
