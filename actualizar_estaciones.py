#!/usr/bin/env python3
"""
Genera onebuilding.json (y con --todo también energyplus.json) para el mapa de "Buscar archivo EPW".

Uso:   python3 actualizar_estaciones.py            # solo OneBuilding
       python3 actualizar_estaciones.py --todo     # OneBuilding + Energyplus.net

Opciones para las coordenadas por versión (ver leer_cabeceras):
       --cabeceras=MEX_Mexico/    # solo lee los EPW de las estaciones cuya ruta contenga este texto (defecto)
       --cabeceras=               # lee todas (lento: miles de zips)
       --sin-cabeceras            # no abre ningún EPW, usa solo las coordenadas del KML
       --presupuesto=600          # segundos máximos leyendo cabeceras; lo que falte se completa en la siguiente corrida

Solo usa la librería estándar de Python. Se puede correr a mano o desde GitHub Actions
(.github/workflows/estaciones.yml).
"""
import csv, io, json, os, re, struct, sys, time, urllib.error, urllib.request, zipfile, zlib
from concurrent.futures import ThreadPoolExecutor

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


UA = 'cartasolar-estaciones/1.0'
UMBRAL = 0.01          # grados (~1 km): dos versiones más lejos que esto se dibujan como puntos distintos
CACHE = 'cabeceras.json'


def pedir(url, rango=None):
    h = {'User-Agent': UA}
    if rango:
        h['Range'] = rango
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, r.headers, r.read()


def coords_de_linea(texto):
    """Primera línea LOCATION de un EPW -> [lon, lat] (o None)."""
    for linea in texto.splitlines():
        if linea.upper().startswith('LOCATION,'):
            c = next(csv.reader([linea]))
            return [round(float(c[7]), 4), round(float(c[6]), 4)]
    return None


def cabecera_con_rangos(url):
    """Lee la línea LOCATION del EPW dentro del zip bajando solo unos KB (HTTP Range)."""
    st, h, cola = pedir(url, 'bytes=-65536')
    if st != 206:
        raise ValueError('el servidor no admite Range')
    total = int(h['Content-Range'].split('/')[-1])
    ini = total - len(cola)
    i = cola.rfind(b'PK\x05\x06')
    if i < 0:
        raise ValueError('sin directorio central')
    _, tam_cd, off_cd = struct.unpack('<HII', cola[i + 10:i + 20])
    if off_cd >= ini:
        cd = cola[off_cd - ini:off_cd - ini + tam_cd]
    else:
        cd = pedir(url, 'bytes=%d-%d' % (off_cd, off_cd + tam_cd - 1))[2]
    p = 0
    while cd[p:p + 4] == b'PK\x01\x02':
        metodo = struct.unpack('<H', cd[p + 10:p + 12])[0]
        tam_c = struct.unpack('<I', cd[p + 20:p + 24])[0]
        ln, le, lc = struct.unpack('<HHH', cd[p + 28:p + 34])
        off = struct.unpack('<I', cd[p + 42:p + 46])[0]
        nombre = cd[p + 46:p + 46 + ln].decode('latin-1')
        p += 46 + ln + le + lc
        if not nombre.lower().endswith('.epw'):
            continue
        b = pedir(url, 'bytes=%d-%d' % (off, off + 8191))[2]
        ln2, le2 = struct.unpack('<HH', b[26:30])
        datos = b[30 + ln2 + le2:]
        txt = datos if metodo == 0 else zlib.decompressobj(-15).decompress(datos)
        txt = txt.decode('latin-1')
        if '\n' not in txt:
            raise ValueError('cabecera incompleta')
        return coords_de_linea(txt)
    raise ValueError('el zip no trae .epw')


def cabecera_completa(url):
    """Respaldo: baja el zip entero."""
    b = pedir(url)[2]
    z = zipfile.ZipFile(io.BytesIO(b))
    n = next(n for n in z.namelist() if n.lower().endswith('.epw'))
    return coords_de_linea(z.open(n).read(8192).decode('latin-1'))


def coordenadas_epw(url):
    """[lon, lat] | 0 si el archivo no existe (404) | None si falló y conviene reintentar."""
    for f in (cabecera_con_rangos, cabecera_completa):
        try:
            c = f(url)
            if c:
                return c
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 0
        except Exception:
            pass
    return None


def opcion(nombre, defecto):
    for a in sys.argv[1:]:
        if a.startswith(nombre + '='):
            return a.split('=', 1)[1]
    return defecto


def leer_cabeceras(acum, filtro, presupuesto):
    """OneBuilding declara una sola ubicación por estación en el KML, pero cada versión (2004-2018, 2009-2023,
    2011-2025...) puede traer otra en la línea LOCATION de su EPW (las nuevas, con ERA5, a veces cambian el punto).
    Aquí se lee esa línea y se corrige la coordenada de cada versión. Los resultados se guardan en cabeceras.json
    para no volver a bajar nada en las siguientes corridas."""
    ruta = os.path.join(OUT, CACHE)
    try:
        cache = json.load(open(ruta, encoding='utf-8'))
    except Exception:
        cache = {}
    tareas = [(b, v) for b, e in acum.items() if filtro in b for v in sorted(e[3], key=orden_variante)
              if b + v not in cache]
    limite = time.time() + presupuesto
    print('  cabeceras: %d por leer (%d ya en caché)' % (len(tareas), len(cache)))

    def leer(t):
        if time.time() > limite:
            return t, None
        return t, coordenadas_epw(OB + t[0] + '_TMYx' + t[1] + '.zip')

    hechas = 0
    with ThreadPoolExecutor(8) as ex:
        for (b, v), c in ex.map(leer, tareas):
            if c is not None:
                cache[b + v] = c
                hechas += 1
    print('  cabeceras leídas:', hechas, '| pendientes para la siguiente corrida:', len(tareas) - hechas)
    if hechas:
        guardar(CACHE, cache)
    for b, e in acum.items():
        for v in e[3]:
            c = cache.get(b + v)
            if isinstance(c, list):
                e[3][v] = c


def agrupar(e):
    """-> [lon, lat, base, variantes_en_el_punto_principal, (extras)] ; extras = [[lon, lat, variantes], ...]"""
    lon0, lat0, base, vs = e
    grupos = []                                   # [lon, lat, [variantes]]
    for v in sorted(vs, key=orden_variante):
        lo, la = vs[v]
        for g in grupos:
            if abs(g[0] - lo) < UMBRAL and abs(g[1] - la) < UMBRAL:
                g[2].append(v)
                break
        else:
            grupos.append([lo, la, [v]])
    # punto principal: el del listado de OneBuilding si todavía tiene alguna versión; si no, el de la versión más nueva
    cerca = lambda g: abs(g[0] - lon0) < UMBRAL and abs(g[1] - lat0) < UMBRAL
    ppal = next((g for g in grupos if cerca(g)), grupos[0])
    fila = [lon0, lat0, base, ppal[2]] if cerca(ppal) else [ppal[0], ppal[1], base, ppal[2]]
    extras = [g for g in grupos if g is not ppal]
    if extras:
        fila.append(extras)
    return fila


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
    """acum: dict base -> [lon, lat, base_relativa, {variante: [lon, lat]}]  (una estación = varios archivos TMYx)"""
    n = 0
    for bloque in PM.findall(texto):
        u = URL.search(bloque)
        c = CO.search(bloque)
        if not u or not c:
            continue
        base = u.group(1)[len(OB):]
        var = u.group(2) or ''
        lon, lat = round(float(c.group(1)), 4), round(float(c.group(2)), 4)
        e = acum.get(base)
        if e is None:
            acum[base] = e = [lon, lat, base, {}]
        e[3].setdefault(var, [lon, lat])
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
    if '--sin-cabeceras' not in sys.argv:
        leer_cabeceras(acum, opcion('--cabeceras', 'MEX_Mexico/'), float(opcion('--presupuesto', 600)))
    est = [agrupar(e) for e in acum.values()]
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
