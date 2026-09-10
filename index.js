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
const { ensureHeader, appendToSheet } = require("./sheets");

const SCRAPERS = {
  avianca: scrapeAvianca,
  copa: scrapeCopa,
  gol: scrapeGol,
};

function fechaDesdeHoy(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function run() {
  const resultados = [];

  for (const ruta of config.rutas) {
    for (const aerolineaId of config.aerolineas) {
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

  // Guardar output local
  if (!fs.existsSync(config.outputDir)) fs.mkdirSync(config.outputDir, { recursive: true });

  const jsonPath = path.join(config.outputDir, `relevamiento_${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(resultados, null, 2));

  const csvPath = path.join(config.outputDir, "historico.csv");
  const csvExiste = fs.existsSync(csvPath);
  const header =
    "fecha_busqueda,ruta,aerolinea,fecha_vuelo,dias_anticipacion,precio,moneda,hora_salida,ok,error\n";
  const filas = resultados
    .map(
      (r) =>
        `${r.timestamp},${r.tramo},${r.aerolinea},${r.fecha},${r.dias_anticipacion},${r.tarifa ?? ""},${r.moneda ?? ""},${r.hora_salida ?? ""},${r.ok},"${r.error ?? ""}"`
    )
    .join("\n");
  fs.writeFileSync(csvPath, csvExiste ? filas + "\n" : header + filas + "\n", {
    flag: csvExiste ? "a" : "w",
  });

  console.log(`\nListo. JSON: ${jsonPath} | histórico acumulado: ${csvPath}`);

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
