# -*- coding: utf-8 -*-
"""Une los cuadros con la locucion de Luisa y la musica: NEXARM-DEMO-16x9.mp4."""
import subprocess
from pathlib import Path
from guion_demo import LINEAS
base = Path(__file__).resolve().parent
INICIOS = [0, 9.5, 22.4, 34.3, 47.7, 57.2, 68.5, 78.8, 93.4, 102.4]   # igual que S en escena.html
DUR = 118.9
cmd = ["ffmpeg", "-y", "-v", "error", "-framerate", "30", "-i", str(base / "cuadros" / "f%05d.png")]
for nombre, _ in LINEAS:
    cmd += ["-i", str(base / "audio" / (nombre + ".mp3"))]
cmd += ["-i", str(base / "audio" / "musica.mp3")]
n = len(LINEAS)
f = "".join("[%d:a]adelay=%d:all=1[v%d];" % (i + 1, int((INICIOS[i] + 0.5) * 1000), i) for i in range(n))
f += "".join("[v%d]" % i for i in range(n)) + "amix=inputs=%d:normalize=0[voz];" % n
f += "[voz]asplit[vz][llave];"
f += "[%d:a]volume=0.5,afade=t=in:d=1.5,afade=t=out:st=%.1f:d=3[mus];" % (n + 1, DUR - 3)
f += "[mus][llave]sidechaincompress=threshold=0.03:ratio=8:attack=40:release=500[baja];"
f += "[vz][baja]amix=inputs=2:normalize=0,loudnorm=I=-14:TP=-1.2:LRA=11[a]"
cmd += ["-filter_complex", f, "-map", "0:v", "-map", "[a]", "-t", str(DUR), "-c:v", "libx264", "-crf", "18", "-preset", "medium",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(base / "NEXARM-DEMO-16x9.mp4")]
subprocess.run(cmd, check=True)
print("listo")
