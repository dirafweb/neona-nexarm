import grabador
from pathlib import Path
grabador.W, grabador.H = 1080, 1920
base = Path(__file__).resolve().parent
c = grabador.grabar(base / "escena.html", base / "cuadros-v4", 43.0, transparente=False)
print(len(list(c.glob("f*.png"))), "cuadros-v4")
