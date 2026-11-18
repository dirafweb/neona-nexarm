# -*- coding: utf-8 -*-
"""Locucion del video de demostracion con la voz de Luisa. Imprime la duracion de cada linea."""
import importlib.util
import subprocess
from pathlib import Path

from guion_demo import LINEAS, LUISA

spec = importlib.util.spec_from_file_location("fabrica_voz", r"C:\Users\xentr\proyectos\laboratorio-estudio\fabrica\voz.py")
fabrica = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fabrica)

base = Path(__file__).resolve().parent / "audio"
for nombre, texto in LINEAS:
    out = base / (nombre + ".mp3")
    if not out.exists():
        fabrica.main(texto, str(out), LUISA)
    d = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
                       capture_output=True, text=True).stdout.strip()
    print(nombre, d)
