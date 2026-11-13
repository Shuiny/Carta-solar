// API de cartasolar.com en un solo Worker de Cloudflare.
// Reemplaza a los dos workers viejos:
//   cartasolar.<cuenta>.workers.dev/?u=URL   → proxy de archivos EPW (energyplus / onebuilding)
//   cartasolar-epw.<cuenta>.workers.dev/...  → estaciones de la comunidad
//
// Rutas públicas
//   GET  /?u=URL  (o /epw?u=URL)   Proxy de EPW, solo a hosts permitidos, con caché de 30 días.
//   GET  /lista                     Estaciones aprobadas (JSON).
//   GET  /archivo/ID                EPW de una estación aprobada.
//   POST /subir                     Sube un EPW (queda pendiente de revisión).
// Rutas de administración (cabecera X-Clave = secreto CLAVE)
//   GET  /admin/pendientes
//   POST /admin/aprobar/ID   POST /admin/rechazar/ID   POST /admin/borrar/ID
//   POST /admin/importar?id=&fecha=&autor=   (cuerpo: EPW; entra ya aprobado, para migrar)
//
// Almacenamiento (KV "DATOS"):
//   lista        → arreglo JSON de estaciones aprobadas
//   f:ID         → texto del EPW (aprobado o pendiente)
//   p:ID         → pendiente; la ficha va en los metadatos de la clave (sin valor útil)
//   h:HASH       → ID, para no aceptar el mismo archivo dos veces
//   d:IP:AAAAMMDD→ contador de subidas por IP al día (expira solo)

const ORIGENES = new Set([
  "https://cartasolar.com",
  "https://www.cartasolar.com",
  "https://shuiny.github.io",
]);
const HOSTS_EPW = new Set([
  "climate.onebuilding.org",
  "energyplus-weather.s3.amazonaws.com",
]);
const MAX_EPW = 4 * 1024 * 1024;          // lo mismo que revisa la página
const MAX_PROXY = 40 * 1024 * 1024;       // un ZIP de onebuilding pesa unos pocos MB
const CACHE_PROXY = 30 * 24 * 3600;       // los EPW casi nunca cambian
const SUBIDAS_POR_IP_DIA = 10;
const PENDIENTES_MAX = 200;               // tope global para que nadie llene el KV

const SEG = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export default {
  async fetch(req, env, ctx) {
    try {
      return await atender(req, env, ctx);
    } catch (e) {
      console.error(e && e.stack || e);
      return json(req, { error: "Error del servidor" }, 500);
    }
  },
};

async function atender(req, env, ctx) {
  const url = new URL(req.url);
  const ruta = url.pathname.replace(/^\/api(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  const origen = req.headers.get("Origin");

  if (req.method === "OPTIONS") return preflight(req, env);

  // Las páginas de otros sitios no pueden usar la API desde el navegador.
  if (origen && !origenOk(origen, env)) return texto(req, "Origen no permitido", 403);

  if (ruta.startsWith("/admin/")) return admin(req, env, ruta, url);

  if (req.method === "GET" || req.method === "HEAD") {
    if (ruta === "/" || ruta === "/epw") {
      if (!url.searchParams.has("u")) return texto(req, "API de cartasolar.com", 200);
      // Solo para la página (así nadie lo usa como proxy gratis desde otro lado).
      if (!origenOk(origen, env)) return texto(req, "Origen no permitido", 403);
      if (!(await limite(env.LIMITE_PROXY, req))) return json(req, { error: "Demasiadas solicitudes, espera un minuto" }, 429);
      return proxy(req, url.searchParams.get("u"), ctx);
    }
    if (ruta === "/lista") return lista(req, env, ctx);
    const m = ruta.match(/^\/archivo\/([a-z0-9]{6,32})$/);
    if (m) return archivo(req, env, m[1], ctx);
    return texto(req, "No existe", 404);
  }

  if (req.method === "POST" && ruta === "/subir") return subir(req, env);
  return texto(req, "Método no permitido", 405);
}

/* ---------------- proxy de EPW ---------------- */

async function proxy(req, destino, ctx) {
  let u;
  try { u = new URL(destino); } catch { return texto(req, "URL inválida", 400); }
  if (!destinoOk(u)) return texto(req, "Destino no permitido", 403);

  // caches.default no hace nada en *.workers.dev, pero sirve si algún día se usa un dominio propio.
  const cache = caches.default;
  const clave = new Request("https://cache.cartasolar.invalid/epw/" + encodeURIComponent(u.href));
  let r = await cache.match(clave);
  if (!r) {
    // Seguimos redirecciones a mano para que nunca terminen fuera de la lista.
    let resp, actual = u;
    for (let i = 0; i < 4; i++) {
      // La caché de fetch sí funciona en workers.dev (caches.default no); guarda solo respuestas 200.
      resp = await fetch(actual.href, {
        redirect: "manual",
        headers: { "User-Agent": "cartasolar.com" },
        cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": CACHE_PROXY, "404": 3600, "500-599": 0 } },
      });
      if (resp.status < 300 || resp.status >= 400) break;
      const loc = resp.headers.get("Location");
      if (!loc) break;
      actual = new URL(loc, actual);
      if (!destinoOk(actual)) return texto(req, "Redirección no permitida", 403);
      resp = null;
    }
    if (!resp) return texto(req, "Demasiadas redirecciones", 502);
    if (!resp.ok) return texto(req, "El servidor de origen respondió " + resp.status, resp.status === 404 ? 404 : 502);
    const largo = +resp.headers.get("Content-Length") || 0;
    if (largo > MAX_PROXY) return texto(req, "Archivo demasiado grande", 413);

    const h = new Headers(SEG);
    h.set("Content-Type", /\.zip$/i.test(actual.pathname) ? "application/zip" : "text/plain; charset=utf-8");
    h.set("Cache-Control", "public, max-age=" + CACHE_PROXY + ", immutable");
    r = new Response(resp.body, { status: 200, headers: h });
    ctx.waitUntil(cache.put(clave, r.clone()));
  }
  return conCors(req, r);
}

function destinoOk(u) {
  return u.protocol === "https:" && !u.username && !u.password && (u.port === "" || u.port === "443")
    && HOSTS_EPW.has(u.hostname) && /\.(zip|epw)$/i.test(u.pathname);
}

/* ---------------- comunidad ---------------- */

async function lista(req, env, ctx) {
  const cache = caches.default;
  const clave = new Request("https://cache.cartasolar.invalid/lista");
  let r = await cache.match(clave);
  if (!r) {
    const datos = (await env.DATOS.get("lista", { cacheTtl: 300 })) || "[]";
    r = new Response(datos, { headers: { ...SEG, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    ctx.waitUntil(cache.put(clave, r.clone()));
  }
  return conCors(req, r);
}

async function archivo(req, env, id, ctx) {
  const cache = caches.default;
  const clave = new Request("https://cache.cartasolar.invalid/archivo/" + id);
  let r = await cache.match(clave);
  if (!r) {
    const est = (await leerLista(env)).find((e) => e.id === id);
    if (!est) return texto(req, "No existe", 404);
    const cuerpo = await env.DATOS.get("f:" + id, { type: "stream", cacheTtl: 86400 });
    if (!cuerpo) return texto(req, "No existe", 404);
    const nombre = (est.nombre || id).replace(/[^\w\-]+/g, "_").slice(0, 60) + ".epw";
    r = new Response(cuerpo, {
      headers: {
        ...SEG,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="' + nombre + '"',
        "Cache-Control": "public, max-age=86400",
      },
    });
    ctx.waitUntil(cache.put(clave, r.clone()));
  }
  return conCors(req, r);
}

async function subir(req, env) {
  if (!origenOk(req.headers.get("Origin"), env)) return json(req, { error: "Origen no permitido" }, 403);
  if (!(await limite(env.LIMITE_SUBIR, req))) return json(req, { error: "Demasiados intentos, espera un minuto" }, 429);

  const largo = +req.headers.get("Content-Length") || 0;
  if (largo > MAX_EPW) return json(req, { error: "El EPW pesa más de 4 MB" }, 413);

  const ip = req.headers.get("CF-Connecting-IP") || "?";
  const dia = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const kDia = "d:" + ip + ":" + dia;
  const usadas = +((await env.DATOS.get(kDia)) || 0);
  if (usadas >= SUBIDAS_POR_IP_DIA) return json(req, { error: "Llegaste al límite de subidas de hoy" }, 429);

  const crudo = await leerConTope(req.body, MAX_EPW);
  if (crudo === null) return json(req, { error: "El EPW pesa más de 4 MB" }, 413);
  const txt = new TextDecoder("utf-8", { fatal: false }).decode(crudo);
  const ficha = validarEpw(txt);
  if (ficha.error) return json(req, { error: ficha.error }, 400);

  const hash = await sha256(crudo);
  if (await env.DATOS.get("h:" + hash)) return json(req, { error: "Esa estación ya se había subido" }, 409);

  const pend = await env.DATOS.list({ prefix: "p:", limit: PENDIENTES_MAX });
  if (pend.keys.length >= PENDIENTES_MAX) return json(req, { error: "Hay demasiadas estaciones en revisión, intenta más tarde" }, 503);

  const id = nuevoId();
  const est = { id, ...ficha, autor: "", fecha: new Date().toISOString().slice(0, 10), hash };
  await env.DATOS.put("f:" + id, crudo);
  await env.DATOS.put("p:" + id, "", { metadata: est });
  await env.DATOS.put("h:" + hash, id);
  await env.DATOS.put(kDia, String(usadas + 1), { expirationTtl: 2 * 86400 });
  return json(req, { ok: true, id, revision: true }, 201);
}

/* Revisa que de verdad sea un EPW y saca la ficha de la línea LOCATION. */
function validarEpw(txt) {
  if (!/^LOCATION,/i.test(txt)) return { error: "Ese archivo no es un EPW" };
  const lineas = txt.split(/\r?\n/);
  const loc = lineas[0].split(",");
  const lat = parseFloat(loc[6]), lon = parseFloat(loc[7]);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return { error: "El EPW no tiene coordenadas válidas" };
  let horas = 0;
  for (let i = 8; i < lineas.length; i++) {
    const c = lineas[i].split(",", 5);
    if (c.length >= 5 && /^\d{4}$/.test(c[0]) && +c[1] >= 1 && +c[1] <= 12 && +c[2] >= 1 && +c[2] <= 31 && +c[3] >= 1 && +c[3] <= 24) horas++;
  }
  // Un año son 8760 horas; se aceptan archivos a los que les faltan unos días (hay EPW así que la página lee bien).
  if (horas < 8000) return { error: "El EPW está incompleto (debe traer casi un año de datos por hora)" };
  const limpio = (s) => String(s || "").replace(/[\u0000-\u001f\u007f<>"'`\\]/g, "").trim().slice(0, 60);
  const nombre = [limpio(loc[1]) || "EPW", limpio(loc[2]) || "-", limpio(loc[3]) || "-"].join(", ");
  return { nombre, lat: +lat.toFixed(6), lon: +lon.toFixed(6), fuente: limpio(loc[4]) };
}

/* ---------------- administración ---------------- */

async function admin(req, env, ruta, url) {
  if (!env.CLAVE || !(await claveOk(req.headers.get("X-Clave"), env.CLAVE))) {
    await new Promise((r) => setTimeout(r, 400)); // frena a quien adivina claves
    return json(req, { error: "Clave incorrecta" }, 401);
  }
  if (req.method === "GET" && ruta === "/admin/pendientes") {
    const l = await env.DATOS.list({ prefix: "p:", limit: 1000 });
    return json(req, l.keys.map((k) => k.metadata), 200);
  }
  if (req.method !== "POST") return json(req, { error: "Método no permitido" }, 405);

  if (ruta === "/admin/importar") {
    const crudo = await leerConTope(req.body, MAX_EPW * 2);
    if (!crudo) return json(req, { error: "Archivo demasiado grande" }, 413);
    const ficha = validarEpw(new TextDecoder().decode(crudo));
    if (ficha.error) return json(req, ficha, 400);
    const id = (url.searchParams.get("id") || nuevoId()).replace(/[^a-z0-9]/g, "").slice(0, 32);
    const hash = await sha256(crudo);
    const est = { id, ...ficha, autor: url.searchParams.get("autor") || "", fecha: url.searchParams.get("fecha") || hoy(), hash };
    if (url.searchParams.get("nombre")) est.nombre = url.searchParams.get("nombre").slice(0, 120);
    await env.DATOS.put("f:" + id, crudo);
    await env.DATOS.put("h:" + hash, id);
    await guardarLista(env, (await leerLista(env)).filter((e) => e.id !== id && e.hash !== hash).concat(est));
    return json(req, { ok: true, id }, 200);
  }

  const m = ruta.match(/^\/admin\/(aprobar|rechazar|borrar)\/([a-z0-9]{6,32})$/);
  if (!m) return json(req, { error: "No existe" }, 404);
  const [, accion, id] = m;
  const p = await env.DATOS.getWithMetadata("p:" + id);
  if (accion === "aprobar") {
    if (!p.metadata) return json(req, { error: "No está pendiente" }, 404);
    await guardarLista(env, (await leerLista(env)).filter((e) => e.id !== id).concat(p.metadata));
    await env.DATOS.delete("p:" + id);
  } else {
    const est = p.metadata || (await leerLista(env)).find((e) => e.id === id);
    if (!est) return json(req, { error: "No existe" }, 404);
    await env.DATOS.delete("p:" + id);
    await env.DATOS.delete("f:" + id);
    if (est.hash) await env.DATOS.delete("h:" + est.hash);
    await guardarLista(env, (await leerLista(env)).filter((e) => e.id !== id));
  }
  return json(req, { ok: true }, 200);
}

async function leerLista(env) {
  try { return JSON.parse((await env.DATOS.get("lista")) || "[]"); } catch { return []; }
}
async function guardarLista(env, l) {
  await env.DATOS.put("lista", JSON.stringify(l));
  await caches.default.delete(new Request("https://cache.cartasolar.invalid/lista"));
}

/* ---------------- utilidades ---------------- */

function origenOk(o, env) {
  if (!o) return false;
  if (ORIGENES.has(o)) return true;
  // Para probar en casa: ORIGENES_EXTRA="http://localhost:8000,..."
  return (env.ORIGENES_EXTRA || "").split(",").map((s) => s.trim()).filter(Boolean).includes(o);
}

function cors(req) {
  const o = req.headers.get("Origin");
  return o ? { "Access-Control-Allow-Origin": o, "Vary": "Origin" } : {};
}

function preflight(req, env) {
  if (!origenOk(req.headers.get("Origin"), env)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      ...cors(req),
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Clave",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function conCors(req, r) {
  const n = new Response(r.body, r);
  for (const [k, v] of Object.entries(cors(req))) n.headers.set(k, v);
  return n;
}

function json(req, obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...SEG, ...cors(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function texto(req, s, status) {
  return new Response(s, { status, headers: { ...SEG, ...cors(req), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function limite(binding, req) {
  if (!binding) return true; // sin binding configurado no se limita
  const { success } = await binding.limit({ key: req.headers.get("CF-Connecting-IP") || "?" });
  return success;
}

async function leerConTope(cuerpo, tope) {
  if (!cuerpo) return new Uint8Array(0);
  const partes = [];
  let total = 0;
  const lector = cuerpo.getReader();
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > tope) { lector.cancel(); return null; }
    partes.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.byteLength; }
  return out;
}

async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function claveOk(dada, real) {
  if (!dada) return false;
  const e = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", e.encode(dada)), crypto.subtle.digest("SHA-256", e.encode(real))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function nuevoId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return "m" + [...a].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

function hoy() { return new Date().toISOString().slice(0, 10); }
