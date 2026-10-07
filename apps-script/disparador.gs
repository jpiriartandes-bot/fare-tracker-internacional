// apps-script/disparador.gs
// Disparo a hora fija de los 3 estudios. Va en el Apps Script de la planilla
// "Fare Tracker Internacional" (Extensiones > Apps Script), NO corre en
// GitHub: este archivo vive en el repo solo como copia de referencia.
//
// Por qué: los cron de GitHub Actions arrancan 5 a 9 h tarde. Un
// workflow_dispatch arranca en el momento. El cron de cada workflow queda
// como respaldo y se descarta solo si ese día el estudio ya corrió.
//
// Configuración (una vez):
//   1. Propiedades del script: GITHUB_TOKEN = token fine-grained con
//      "Actions: read and write" sobre el repo (ver README).
//   2. Ejecutar crearDisparador() a mano (pide autorización la 1ª vez).
//   3. Opcional: ejecutar lanzarEstudios() a mano para probar.

const REPO = "jpiriartandes-bot/fare-tracker-internacional";
const WORKFLOWS = ["estudio-ccs-mia.yml", "estudio-eze-ccs.yml", "estudio-bue-mia.yml"];
const ZONA = "America/Argentina/Buenos_Aires";

// La llama el disparador diario. Si algún workflow no se pudo lanzar, tira
// error al final: Apps Script manda un mail con la falla (ver paso 7 del
// README) y el cron de respaldo lo cubre ese día.
function lanzarEstudios() {
  const token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!token) throw new Error("Falta la propiedad del script GITHUB_TOKEN.");

  const fallas = [];
  WORKFLOWS.forEach((wf, i) => {
    if (i > 0) Utilities.sleep(5000);
    const r = dispararWorkflow(wf, token);
    if (r.ok) console.log(`${wf}: lanzado.`);
    else fallas.push(`${wf}: HTTP ${r.codigo} — ${r.cuerpo}`);
  });
  if (fallas.length) throw new Error("No se pudieron lanzar:\n" + fallas.join("\n"));
}

// POST /repos/{repo}/actions/workflows/{archivo}/dispatches con ref main.
// GitHub responde 204 sin cuerpo. Ante 5xx o error de red reintenta una vez.
function dispararWorkflow(archivo, token) {
  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${archivo}/dispatches`;
  const opciones = {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    payload: JSON.stringify({ ref: "main" }),
    muteHttpExceptions: true,
  };
  let codigo = 0;
  let cuerpo = "";
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const resp = UrlFetchApp.fetch(url, opciones);
      codigo = resp.getResponseCode();
      cuerpo = resp.getContentText().slice(0, 300);
      if (codigo === 204) return { ok: true, codigo };
      if (codigo < 500) break; // 401/403/404/422: reintentar no cambia nada
    } catch (err) {
      cuerpo = String(err);
    }
    if (intento === 1) Utilities.sleep(30000);
  }
  return { ok: false, codigo, cuerpo };
}

// Crea (o recrea) el disparador diario a las 05:00 hora argentina. Apps
// Script no garantiza el minuto exacto: con nearMinute(0) corre dentro de
// ±15 min de las 05:00.
function crearDisparador() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "lanzarEstudios")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("lanzarEstudios")
    .timeBased()
    .everyDays(1)
    .atHour(5)
    .nearMinute(0)
    .inTimezone(ZONA)
    .create();
  console.log("Disparador diario creado: lanzarEstudios() a las 05:00 (" + ZONA + ").");
}
