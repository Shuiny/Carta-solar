#!/usr/bin/env python3
"""
Genera onebuilding.json (y con --todo también energyplus.json) para el mapa de "Buscar archivo EPW".

Uso:   python3 actualizar_estaciones.py            # solo OneBuilding
       python3 actualizar_estaciones.py --todo     # OneBuilding + Energyplus.net

Solo usa la librería estándar de Python. Se puede correr a mano o desde GitHub Actions
(.github/workflows/estaciones.yml).
"""
import json, os, re, sys, urllib.request

OB = 'https://climate.onebuilding.org/'
SRC = OB + 'sources/'
# KML "TMYx" por región (lista de respaldo si no se puede leer la página de fuentes)
KMLS = ['Region1_Africa', 'Region2_Asia', 'Region2_Region6_Russia', 'Region3_South_America',
        'Region4_USA', 'Region4_Canada', 'Region4_NA_CA_Caribbean', 'Region5_Southwest_Pacific',
        'Region6_Europe', 'Region7_Antarctica']
KML_SUFFIX = '_TMYx_EPW_Processing_locations.kml'
OUT = os.path.dirname(os.path.abspath(__file__))   # los JSON van en la raíz del repo


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'cartasolar-estaciones/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read().decode('utf-8', 'replace')


def descubrir_kmls():
    try:
        html = get(SRC + 'default.html')
        hallados = sorted(set(re.findall(r'(Region\d[\w]*?' + re.escape(KML_SUFFIX) + ')', html)))
        if hallados:
            return [SRC + h for h in hallados]
    except Exception as e:
        print('  (no pude leer la página de fuentes, uso la lista fija):', e)
    return [SRC + k + KML_SUFFIX for k in KMLS]


PM = re.compile(r'<Placemark>(.*?)</Placemark>', re.S)
URL = re.compile(r'URL\s+(https://climate\.onebuilding\.org/[^<\s\]]+?)_TMYx(\.\d{4}-\d{4})?\.zip')
CO = re.compile(r'<coordinates>\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)')


def parsear_kml(texto, acum):
    """acum: dict base -> [lon, lat, base_relativa, set(variantes)]  (una estación = varios archivos TMYx)"""
    n = 0
    for bloque in PM.findall(texto):
        u = URL.search(bloque)
        c = CO.search(bloque)
        if not u or not c:
            continue
        base = u.group(1)[len(OB):]
        var = u.group(2) or ''
        e = acum.get(base)
        if e is None:
            acum[base] = e = [round(float(c.group(1)), 4), round(float(c.group(2)), 4), base, set()]
        e[3].add(var)
        n += 1
    return n


def orden_variante(v):          # primero la más reciente: 2011-2025, 2009-2023, 2007-2021, 2004-2018, completa ('')
    return (v == '', v and -int(v[-4:]))


def onebuilding():
    acum = {}
    for k in descubrir_kmls():
        print('  ', k.split('/')[-1], end=' ... ', flush=True)
        n = parsear_kml(get(k), acum)
        print(n, 'archivos')
    est = [[e[0], e[1], e[2], sorted(e[3], key=orden_variante)] for e in acum.values()]
    est.sort(key=lambda e: (e[1], e[0]))
    guardar('onebuilding.json', {'v': 1, 'fuente': 'climate.onebuilding.org (TMYx)', 'base': OB, 'est': est})
    print('OneBuilding:', len(est), 'estaciones')


def energyplus():
    S = 'https://energyplus-weather.s3.amazonaws.com/'
    g = json.loads(get('https://raw.githubusercontent.com/NREL/EnergyPlus/develop/weather/master.geojson'))
    est = []
    for f in g['features']:
        m = re.search(r'href=(\S+?\.epw)', f['properties'].get('epw', ''))
        if not m or not m.group(1).startswith(S):
            continue
        d = m.group(1)[len(S):].rsplit('/', 1)[0]
        lon, lat = f['geometry']['coordinates'][:2]
        est.append([round(lon, 4), round(lat, 4), d])
    guardar('energyplus.json', {'v': 1, 'fuente': 'energyplus.net (NREL/EnergyPlus weather/master.geojson)', 's3': S, 'est': est})
    print('Energyplus:', len(est), 'estaciones')


def guardar(nombre, datos):
    with open(os.path.join(OUT, nombre), 'w', encoding='utf-8') as f:
        json.dump(datos, f, separators=(',', ':'), ensure_ascii=False)


if __name__ == '__main__':
    if '--todo' in sys.argv:
        energyplus()
    onebuilding()
