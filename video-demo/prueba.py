# Cuadros sueltos para revisar la escena antes de grabar: python prueba.py 3 15 30 ...
import sys, time
from pathlib import Path
import grabador
base = Path(__file__).resolve().parent
out = base / "prueba"; out.mkdir(exist_ok=True)
nav = grabador.Navegador((base / "escena.html").as_uri(), False)
try:
    time.sleep(2.5)
    for t in sys.argv[1:]:
        nav.js("render(%s)" % t); nav.foto(out / ("t%s.png" % t))
finally:
    nav.cerrar()
