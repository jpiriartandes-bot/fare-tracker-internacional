# fare-tracker-internacional — EZE ↔ CCS / Avianca, Copa

## Qué es
Hermano internacional del [fare-tracker](https://github.com/jpiriartandes-bot/fare-tracker)
doméstico: mismo patrón (Playwright + GitHub Actions + Google Sheets), pero
para rutas internacionales. Etapa 1: EZE↔CCS (Buenos Aires Ezeiza ↔ Caracas,
aeropuerto Simón Bolívar) en Avianca y Copa Airlines. Gol y American Airlines
quedan para la etapa 2.

Por corrida: 31 fechas (día 1 a 30 + un extra a día 60) × 2 rutas × 2
aerolíneas = 124 búsquedas.

## Estado actual (2026-09-09)
Scaffold armado y repo creado, pero **ningún scraper está terminado
todavía** — están los TODOs marcados con lo que se relevó en vivo y lo que
falta. Ver el header de cada archivo en `scrapers/` para el detalle.

- **Avianca** (`scrapers/avianca.js`): reconocimiento parcial confirmado
  contra el sitio real (origen/destino vía autocomplete funcionando).
  Hallazgo importante: existe una API interna de calendario de precios
  (`airmkt/api/pricing/calendar`) que da precio por día para ~40 días en
  una sola llamada — mucho más eficiente que 31 búsquedas si nos alcanza.
  Ojo: el sitio tiene Akamai Bot Manager, así que cualquier request a esa
  API tiene que salir de un `fetch()` ejecutado dentro de una página de
  Playwright ya cargada (un cliente HTTP directo da `ECONNRESET`). Falta
  completar el flujo hasta los resultados reales para conseguir la hora de
  salida (el calendario solo da precio).
- **Copa** (`scrapers/copa.js`): sin reconocimiento en vivo todavía, solo
  el inventario de campos del formulario de búsqueda.
- **Google Sheets**: todavía no hay Sheet creado ni `sheets.js` escrito.
  El plan es reutilizar la misma service account del fare-tracker
  doméstico (`fare-tracker-writer@fare-tracker-506113.iam.gserviceaccount.com`),
  compartiendo un Sheet nuevo con esa cuenta.
- **GitHub Actions**: el workflow (`fare-tracker-internacional.yml`) está
  armado siguiendo el mismo patrón del doméstico (cron diario +
  `workflow_dispatch`, secret `GOOGLE_CREDENTIALS` escrito a archivo y
  borrado al final), pero todavía no tiene el secret configurado en el
  repo, y correrlo hoy fallaría porque los scrapers no están terminados.

## Setup local (correr con Claude Code local — necesita salida a internet real)

```bash
npm install
npx playwright install chromium
```

## Próximos pasos (en orden)
1. Terminar `scrapers/avianca.js`: resolver destino/fecha/submit y decidir
   si conviene apoyarse en la API de calendario para el precio y solo
   entrar a resultados reales para la hora de salida (evaluar el costo en
   tiempo de corrida antes de decidir).
2. Reconocimiento en vivo de Copa (`scrapers/copa.js`) — primero chequear
   si expone una API interna como Aerolíneas Argentinas y Avianca, antes
   de ir a selectores DOM.
3. Backoff/reintentos agresivos desde el arranque en ambos scrapers — en
   el fare-tracker doméstico, JetSMART tuvo inestabilidad recurrente por
   no tener esto desde el principio.
4. Crear el Google Sheet nuevo, compartirlo con la service account, y
   escribir `sheets.js` (mismo patrón que el doméstico).
5. Configurar el secret `GOOGLE_CREDENTIALS` en este repo (Settings →
   Secrets and variables → Actions).
6. Corrida de prueba end-to-end (unas pocas combinaciones primero, no las
   124 de una) antes de confiar en el cron diario.
