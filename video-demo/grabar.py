# Graba escena.html cuadro a cuadro (1920x1080, 30 fps) en cuadros/.
from pathlib import Path
import grabador
base = Path(__file__).resolve().parent
c = grabador.grabar(base / "escena.html", base / "cuadros", 118.9, transparente=False)
print(len(list(c.glob("f*.png"))), "cuadros")
