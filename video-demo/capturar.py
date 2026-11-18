# Captura la consola de Nexarm (sesion local) a una imagen alta y guarda donde cae cada seccion.
import base64, json, subprocess, tempfile, time, urllib.request, urllib.parse, http.cookiejar
from pathlib import Path
import websocket
BASE = Path(__file__).resolve().parent
NEX = BASE.parent / "nexarm"
URL = "http://127.0.0.1:8787"
c = json.load(open(NEX / ".tokens.local.json", encoding="utf-8"))["consola"]
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar)); op.addheaders = [("Origin", URL)]
op.open(URL + "/login", urllib.parse.urlencode({"usuario": c["usuario"], "clave": c["clave"]}).encode())
ck = next(iter(jar))
chrome = subprocess.Popen([r"C:\Program Files\Google\Chrome\Application\chrome.exe", "--headless=new", "--disable-gpu",
    "--remote-debugging-port=9391", "--remote-allow-origins=*", "--user-data-dir=" + tempfile.mkdtemp(), "about:blank"])
try:
    for _ in range(40):
        try:
            tab = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:9391/json/new?about:blank", method="PUT"))); break
        except Exception: time.sleep(0.5)
    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], max_size=None)
    n = 0
    def cdp(m, **p):
        global n; n += 1; ws.send(json.dumps({"id": n, "method": m, "params": p}))
        while True:
            r = json.loads(ws.recv())
            if r.get("id") == n: return r.get("result", {})
    cdp("Network.enable"); cdp("Page.enable")
    cdp("Network.setCookie", name=ck.name, value=ck.value, url=URL, httpOnly=True)
    cdp("Emulation.setDeviceMetricsOverride", width=1280, height=900, deviceScaleFactor=2, mobile=False)
    cdp("Page.navigate", url=URL + "/"); time.sleep(3)
    js = """JSON.stringify({h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth,
      s:[...document.querySelectorAll('p.tag, section.arm, .tiles, form.row, table, h1, h2, header')].map(e=>{const r=e.getBoundingClientRect();
      return {t:e.tagName+'.'+e.className, x:r.x, y:r.y+scrollY, w:r.width, h:r.height, txt:(e.innerText||'').slice(0,60)}})})"""
    info = json.loads(cdp("Runtime.evaluate", expression=js)["result"]["value"])
    shot = cdp("Page.captureScreenshot", format="png", captureBeyondViewport=True, clip={"x": 0, "y": 0, "width": info["w"], "height": info["h"], "scale": 1})
    (BASE / "img" / "consola.png").write_bytes(base64.b64decode(shot["data"]))
    json.dump(info, open(BASE / "img" / "consola.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(info["w"], info["h"], len(info["s"]))
finally:
    chrome.kill()
