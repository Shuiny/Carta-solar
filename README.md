# Carta solar — cartasolar.com

Herramienta gratuita de diseño bioclimático (carta solar, máscara de sombra, aletas, volados, confort ASHRAE, viento 3D). © 2026 Luis Ángel Patrón Juárez, todos los derechos reservados (ver `LICENSE`).

## Estructura

| Ruta | Para qué sirve |
|---|---|
| `index.html` | La aplicación completa (un solo archivo) |
| `estaciones/*.json` | Estaciones EPW para el mapa «Buscar archivo EPW» (las genera el script) |
| `scripts/actualizar_estaciones.py` | Descarga y arma los JSON de estaciones (solo librería estándar) |
| `.github/workflows/estaciones.yml` | Corre el script el día 1 de cada mes (o a mano desde Actions) |
| `404.html`, `favicon.png`, `og-banner.png` | Página de error, ícono y vista previa al compartir |
| `CNAME` | Solo GitHub Pages; se puede borrar al pasar a Cloudflare Pages |

## Actualizar estaciones a mano

```
python3 scripts/actualizar_estaciones.py --todo
```

## Cloudflare Pages

Sin paso de compilación: *Build command* vacío y *Build output directory* = `/` (raíz).
