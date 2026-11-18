# -*- coding: utf-8 -*-
"""Grabador CDP para el cortometraje (16:9): escenas HTML con render(t) y rotulos
cineticos, cuadro a cuadro, con o sin alfa.

Trae las tres lecciones que costaron tres intentos en el spot (Chrome 151):
  · headless=new puede arrancar SIN pestana -> se pide una con PUT /json/new
  · si no conecta, se mata el proceso (si no, se queda huerfano con el puerto)
  · la transparencia se pide por CDP (setDefaultBackgroundColorOverride), no
    con la bandera de linea de comandos, que no aplica a las capturas
"""
from __future__ import annotations

import base64
import json
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

import websocket

BASE = Path(__file__).resolve().parent
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
MARCA = "C:/Users/xentr/proyectos/xentris-empresa/marca"
W, H, FPS = 1920, 1080, 30
PUERTO = 9384
SUFIJO = ""          # "-en" para la version en ingles

ROTULO = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:'Mansfield';src:url('file:///%(marca)s/fonts/Mansfield Black Italic.ttf');font-weight:900;font-style:italic}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1920px;height:1080px;background:transparent;overflow:hidden}
body{position:relative;font-family:'Mansfield',sans-serif}
.bloque{position:absolute;left:120px;right:120px;bottom:150px;will-change:transform,opacity,filter}
.filete{height:8px;border-radius:99px;margin-bottom:24px;transform-origin:left;width:150px;
  background:linear-gradient(90deg,rgba(199,140,232,0),#c78ce8 42%%,#8B3BC0)}
h1{font-family:'Mansfield',serif;font-style:italic;font-weight:900;color:#fff;
   font-size:%(tam)spx;line-height:1.04;
   text-shadow:0 10px 46px rgba(0,0,0,.85),0 2px 10px rgba(0,0,0,.7)}
h1 .b{color:#c78ce8}
</style></head><body>
<div class="bloque" id="b"><div class="filete" id="f"></div>
<h1><span id="l1">%(l1)s</span><br><span class="b" id="l2">%(l2)s</span></h1></div>
<script>
const DUR=%(dur)s, GOLPE=%(golpe)s, HAY2=%(hay2)s;
const p=(t,s,d)=>Math.min(1,Math.max(0,(t-s)/d));
const eo=x=>1-Math.pow(1-x,3);
const eb=x=>{const c=1.70158;return 1+(c+1)*Math.pow(x-1,3)+c*Math.pow(x-1,2)};
const b=document.getElementById('b'), f=document.getElementById('f');
const l1=document.getElementById('l1'), l2=document.getElementById('l2');
function linea(el, t0, ent){
  const a=eo(p(t,t0,ent));
  el.style.display='inline-block';
  el.style.letterSpacing=((GOLPE?18:12)*(1-a)-1)+'px';
  el.style.filter='blur('+((GOLPE?12:8)*(1-a)).toFixed(2)+'px)';
  el.style.opacity=a.toFixed(3);
  el.style.transform='translateY('+(14*(1-a)).toFixed(1)+'px)';
}
let t=0;
function render(tt){
  t=tt;
  const ent = GOLPE?0.16:0.34;
  linea(l1, 0, ent);
  if(HAY2) linea(l2, 0.42, ent); else l2.style.opacity=0;
  const s = GOLPE ? 1.16-0.16*eb(p(t,0,ent)) : 1.06-0.06*eo(p(t,0,ent));
  const sal=p(t,DUR-0.22,0.22);
  b.style.transform='translateY('+(-30*eo(sal)).toFixed(1)+'px) scale('+s.toFixed(4)+')';
  b.style.opacity=(1-sal).toFixed(3);
  f.style.transform='scaleX('+eo(p(t,0.05,0.3)).toFixed(3)+')';
}
window.render=render; window.TOTAL=DUR; window.ALTO=1080;
</script></body></html>"""


class Navegador:
    def __init__(self, url, transparente):
        self.perfil = Path(tempfile.mkdtemp(prefix="cdp-"))
        self.proc = subprocess.Popen([
            str(CHROME), "--headless=new", "--remote-debugging-port=%d" % PUERTO,
            "--user-data-dir=" + str(self.perfil), "--window-size=%d,%d" % (W, H),
            "--hide-scrollbars", "--force-device-scale-factor=1", "--no-first-run",
            "--no-sandbox", "--no-default-browser-check", "--disable-extensions",
            "--disable-gpu", "--allow-file-access-from-files", "--remote-allow-origins=*", url,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.ws = self._conectar(url)
        except Exception:
            self.proc.terminate()
            raise
        self.n = 0
        self.pide("Page.enable"); self.pide("Runtime.enable")
        if transparente:
            self.pide("Emulation.setDefaultBackgroundColorOverride",
                      color={"r": 0, "g": 0, "b": 0, "a": 0})
        for _ in range(80):
            if self.js("typeof render==='function'"):
                break
            time.sleep(0.25)
        self.pide("Emulation.setDeviceMetricsOverride", width=W, height=H,
                  deviceScaleFactor=1, mobile=False)
        self.js("document.fonts.ready.then(()=>1)")
        time.sleep(0.5)

    @staticmethod
    def _conectar(url):
        base = "http://127.0.0.1:%d" % PUERTO
        ultimo = None
        for intento in range(60):
            try:
                paginas = json.loads(urllib.request.urlopen(base + "/json/list", timeout=2).read())
                pg = next((x for x in paginas
                           if x.get("type") == "page" and x.get("webSocketDebuggerUrl")), None)
                if pg is None and intento >= 4:
                    req = urllib.request.Request(base + "/json/new?" + url, method="PUT")
                    pg = json.loads(urllib.request.urlopen(req, timeout=4).read())
                if pg and pg.get("webSocketDebuggerUrl"):
                    return websocket.create_connection(pg["webSocketDebuggerUrl"], timeout=90,
                                                       max_size=64 * 1024 * 1024,
                                                       suppress_origin=True)
            except Exception as e:  # noqa: BLE001
                ultimo = e
            time.sleep(0.4)
        raise RuntimeError("Chrome no abrio el puerto de depuracion: %r" % (ultimo,))

    def pide(self, metodo, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": metodo, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError("%s: %s" % (metodo, m["error"]))
                return m.get("result", {})

    def js(self, expr):
        r = self.pide("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True)
        if r.get("exceptionDetails"):
            raise RuntimeError("JS: %s" % r["exceptionDetails"].get("text"))
        return r.get("result", {}).get("value")

    def foto(self, destino):
        r = self.pide("Page.captureScreenshot", format="png", fromSurface=True,
                      captureBeyondViewport=False)
        destino.write_bytes(base64.b64decode(r["data"]))

    def cerrar(self):
        try:
            self.ws.close()
        finally:
            self.proc.terminate()
            self.proc.wait(timeout=15)
            shutil.rmtree(self.perfil, ignore_errors=True)


def grabar(html, carpeta, dur, transparente):
    """Graba `html` (con render(t)) en carpeta/f00000.png ... Se salta si ya existe."""
    carpeta = Path(carpeta)
    n = int(round(dur * FPS))
    if carpeta.is_dir() and len(list(carpeta.glob("f*.png"))) >= n:
        return carpeta
    shutil.rmtree(carpeta, ignore_errors=True)
    carpeta.mkdir(parents=True)
    nav = Navegador(Path(html).as_uri(), transparente)
    try:
        for i in range(n):
            nav.js("render(%.5f)" % (i / FPS))
            nav.foto(carpeta / ("f%05d.png" % i))
    finally:
        nav.cerrar()
    return carpeta


def grabar_rotulo(nombre, l1, l2, dur, tam=88, golpe=False):
    html = BASE / ("texto" + SUFIJO) / ("_%s.html" % nombre)
    html.parent.mkdir(exist_ok=True)
    html.write_text(ROTULO % dict(marca=MARCA, l1=l1, l2=l2 or "", tam=tam, dur=dur,
                                  golpe="true" if golpe else "false",
                                  hay2="true" if l2 else "false"), encoding="utf-8")
    return grabar(html, BASE / ("texto" + SUFIJO) / nombre, dur, transparente=True)


def grabar_escena(nombre, dur):
    return grabar(BASE / (nombre + SUFIJO + ".html"), BASE / ("escenas" + SUFIJO) / nombre,
                  dur, transparente=False)


if __name__ == "__main__":
    c = grabar_escena("conexion", 5.0)
    print(c, len(list(c.glob("f*.png"))), "cuadros")
