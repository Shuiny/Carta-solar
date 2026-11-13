# Carta solar · [cartasolar.com](https://cartasolar.com)

Herramienta gratuita de diseño bioclimático en el navegador, para arquitectos y estudiantes.

- **Carta solar** con máscara de sombra, volados y aletas (acomodo automático), confort ASHRAE 55 y rosa de vientos.
- **Datos EPW**: nubosidad, lluvia, temperatura, humedad, confort por hora, bochorno y vientos.
- **Buscar EPW**: mapa con estaciones de EnergyPlus y Climate.OneBuilding.
- **Análisis de sitio**: terreno 3D con lluvia y escurrimiento.
- **Modelo 3D**: simulación de ventilación natural con tu IFC.
- **Diagramas** de funcionamiento y matriz de relaciones.

## Estructura

```
index.html            La página completa (diseño SVG, estilos, clima por defecto y código), en un solo archivo.
404.html              Página de error.
robots.txt            Para buscadores.
sitemap.xml           Para buscadores.
CNAME                 Dominio de GitHub Pages (cartasolar.com).
.nojekyll             Publica los archivos tal cual, sin procesarlos con Jekyll.

datos/
  energyplus.json     Estaciones de energyplus.net para el mapa.
  onebuilding.json    Estaciones de climate.onebuilding.org (formato compacto v2).

visores/
  visor-sitio.bin     Visor 3D de Análisis de sitio (HTML comprimido con gzip).
  visor-3d.bin        Visor 3D de Modelo 3D (HTML comprimido con gzip).
                      Se descargan solo al abrir su pestaña.

img/
  favicon.png         Ícono del sitio.
  og-banner.png       Imagen de vista previa al compartir.

scripts/
  actualizar_estaciones.py   Regenera los JSON de datos/ (solo biblioteca estándar de Python).
  cabeceras.json             Caché del script (coordenadas leídas de cada EPW).

.github/workflows/
  estaciones.yml      Corre el script el día 1 de cada mes y guarda los cambios.

worker/               API en Cloudflare Workers (un solo worker):
  src/index.js          proxy de EPW + estaciones de la comunidad.
  wrangler.toml         configuración (KV "DATOS" y límites por IP).
  desplegar.sh          despliega en tu cuenta y apunta index.html al worker.
  admin.py              revisar / aprobar / rechazar estaciones subidas.
```

## API (worker)

| Ruta | Qué hace |
|---|---|
| `GET /?u=URL` | Baja un EPW de `climate.onebuilding.org` o `energyplus-weather.s3.amazonaws.com` (el navegador no puede directo por CORS). Solo esos dos servidores, solo `.zip`/`.epw`, con caché de 30 días. |
| `GET /lista` | Estaciones de la comunidad aprobadas. |
| `GET /archivo/ID` | EPW de una estación aprobada. |
| `POST /subir` | Sube un EPW; queda en revisión. |
| `/admin/...` | Solo con la cabecera `X-Clave` (ver `worker/admin.py`). |

Seguridad: solo responde a páginas de cartasolar.com; límites por IP (60 descargas y 3 subidas por minuto, 10 subidas al día); valida que el EPW sea real (coordenadas y al menos 8000 de las 8760 horas del año) y que no esté repetido; tope de 200 pendientes; la clave de administración es un secreto de Cloudflare y se compara en tiempo constante.

Revisar estaciones subidas:

```
./worker/admin.py pendientes
./worker/admin.py aprobar ID      # o rechazar ID
```

## Actualizar las estaciones a mano

```
python3 scripts/actualizar_estaciones.py --todo
```

### Formato de `datos/onebuilding.json` (v2)

Para que pese menos, las carpetas y las listas de versiones se guardan una sola vez:

- `dirs`: carpetas, p. ej. `"WMO_Region_4_North_and_Central_America/MEX_Mexico/BCS_Baja_California_Sur"`
- `vars`: listas de versiones TMYx, p. ej. `[".2011-2025", ".2009-2023", ""]`
- `est`: `[lon, lat, i_dir, nombre, i_vars, extras?]`, donde `extras = [[lon, lat, i_vars], ...]`

La ruta del archivo es `base + dirs[i_dir] + "/" + nombre + "_TMYx" + versión + ".zip"`.

© 2026 Luis Ángel Patrón Juárez. Ver `LICENSE`.
