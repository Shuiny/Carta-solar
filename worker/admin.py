#!/usr/bin/env python3
"""Administra las estaciones de la comunidad.

  ./admin.py pendientes
  ./admin.py aprobar ID      ./admin.py rechazar ID      ./admin.py borrar ID
  ./admin.py importar CARPETA_CON_lista-vieja.json_Y_LOS_EPW

La URL del worker y la clave se leen de ~/.config/cartasolar/ (los crea desplegar.sh).
"""
import json, os, sys, urllib.parse, urllib.request

CONF = os.path.expanduser("~/.config/cartasolar")
API = open(os.path.join(CONF, "api")).read().strip()
CLAVE = open(os.path.join(CONF, "clave")).read().strip()


def pedir(metodo, ruta, cuerpo=None):
    r = urllib.request.Request(API + ruta, data=cuerpo, method=metodo,
                               headers={"X-Clave": CLAVE, "Content-Type": "text/plain", "User-Agent": "cartasolar-admin"})
    try:
        with urllib.request.urlopen(r, timeout=120) as f:
            return json.loads(f.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"Error {e.code}: {e.read().decode(errors='replace')}")


def main(a):
    if not a:
        sys.exit(__doc__)
    if a[0] == "pendientes":
        p = pedir("GET", "/admin/pendientes")
        if not p:
            print("No hay estaciones pendientes.")
        for e in p:
            print(f"{e['id']}  {e['fecha']}  {e['nombre']}  ({e['lat']}, {e['lon']})  fuente: {e.get('fuente','')}")
            print(f"        ver en mapa: https://www.openstreetmap.org/?mlat={e['lat']}&mlon={e['lon']}#map=10/{e['lat']}/{e['lon']}")
    elif a[0] in ("aprobar", "rechazar", "borrar") and len(a) == 2:
        print(pedir("POST", f"/admin/{a[0]}/{a[1]}"))
    elif a[0] == "importar" and len(a) == 2:
        d = a[1]
        vistos = set()
        for e in json.load(open(os.path.join(d, "lista-vieja.json"))):
            if e["id"] in vistos:
                continue
            vistos.add(e["id"])
            q = urllib.parse.urlencode({k: e.get(k, "") for k in ("id", "fecha", "autor", "nombre")})
            datos = open(os.path.join(d, e["id"] + ".epw"), "rb").read()
            print(e["id"], e["nombre"], pedir("POST", "/admin/importar?" + q, datos))
    else:
        sys.exit(__doc__)


main(sys.argv[1:])
