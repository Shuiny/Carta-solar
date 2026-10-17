# Carta solar · [cartasolar.com](https://cartasolar.com)

Herramienta gratuita de diseño bioclimático en el navegador, para arquitectos y estudiantes.

- **Carta solar** con máscara de sombra, volados y aletas (acomodo automático), confort ASHRAE 55 y rosa de vientos.
- **Datos EPW**: nubosidad, lluvia, temperatura, humedad, confort por hora, bochorno y vientos.
- **Buscar EPW**: mapa con estaciones de EnergyPlus y Climate.OneBuilding.
- **Análisis de sitio**: terreno 3D con lluvia y escurrimiento.
- **Modelo 3D**: simulación de ventilación natural con tu IFC.
- **Diagramas** de funcionamiento y matriz de relaciones.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La página completa (diseño, estilos y código). |
| `visor-3d.bin`, `visor-sitio.bin` | Visores 3D comprimidos; se descargan solo al abrir Modelo 3D o Análisis de sitio. |
| `energyplus.json`, `onebuilding.json` | Estaciones del mapa (se actualizan con `actualizar_estaciones.py`). |
| `robots.txt`, `sitemap.xml` | Para buscadores. |

© 2026 Luis Ángel Patrón Juárez. Ver `LICENSE`.
