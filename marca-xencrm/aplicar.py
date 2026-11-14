"""Viste una copia de XENCRM con la marca de la solucion: Nexarm, de Neona Tech.

Uso: python aplicar.py <carpeta de la copia de XENCRM>

Hace tres cosas en public/ y se puede repetir despues de cada actualizacion del repositorio:
  1. Tablero (admin.html): paleta y tipografia del manual de marca de Neona Tech (https://neona.tech/marca)
     en los tokens --fx-* de la piel. Mide el contraste de cada texto contra su fondo (minimo 4.5) antes de escribir.
  2. Consola y portada (consola.html, inicio.html): los colores de la piel de fabrica pasan a los de Neona Tech.
  3. Nombre del producto en lo que se ve: XENCRM pasa a Nexarm. Los identificadores del codigo (window.XENCRM_*) no cambian.
  4. Pruebas (src/eval): las cuatro comprobaciones que nombran la marca de fabrica esperan la de Nexarm.

El nombre del negocio, su logo y su color van aparte, en xencrm.config.json (business.name y brand).
Si una actualizacion trae un admin.html con cambios locales, restauralo antes de actualizar:
  git checkout -- public/ && git merge --ff-only origin/main && python aplicar.py .
"""
import re, sys
from pathlib import Path

root = Path(sys.argv[1]) / "public"

CLARO = {
    "fx-fondo": "#eef2f7", "fx-panel": "#fff", "fx-panel-2": "#f4f6fa", "fx-borde": "#d9dee7", "fx-borde-2": "#e7ebf1",
    "fx-hover": "#edf1f7", "fx-fila": "#f4f6fa",
    "fx-t0": "#0a2a5e", "fx-t1": "#2e3440", "fx-t2": "#555e6e", "fx-t3": "#5f6878", "fx-t4": "#b9c2d0",
    "fx-acento": "#0a2a5e", "fx-acento-2": "#082149", "fx-acento-t": "#0a2a5e", "fx-sobre-acento": "#fff",
    "fx-suave": "#e3ecf8", "fx-suave-t": "#0a2a5e", "fx-suave-borde": "#bcd0ec",
    "fx-ia": "#007fb0", "fx-ia-s": "#e2f5fc", "fx-ia-t": "#006a94", "fx-ia-borde": "#b3e2f5",
    "fx-verde": "#00b386", "fx-verde-s": "#e3f6f0", "fx-verde-t": "#006b52",
    "fx-papel": "#f1f3f7", "fx-papel-trama": "rgb(10 42 94/.05)", "fx-burbuja-xen": "#dff3fb",
    "fx-nombre-xen": "#005f86", "fx-hora-burbuja": "#4a5a6e",
    "fx-oscura": "#0a2a5e", "fx-oscura-t": "#b9c8e0",
    "fx-letra": '"IBM Plex Sans",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    "fx-display": 'Sora,"IBM Plex Sans",ui-sans-serif,-apple-system,sans-serif',
    "fx-sombra-xs": "0 1px 2px 0 rgb(10 42 94/.05)",
    "fx-sombra-sm": "0 1px 3px 0 rgb(10 42 94/.08),0 1px 2px -1px rgb(10 42 94/.06)",
    "fx-sombra-md": "0 6px 14px -4px rgb(10 42 94/.12),0 2px 4px -2px rgb(10 42 94/.06)",
    "fx-sombra-pop": "0 16px 32px -8px rgb(10 42 94/.18),0 4px 8px -4px rgb(10 42 94/.08)",
    "fx-anillo": "0 0 0 3px rgb(0 127 176/.5)",
}
OSCURO = {
    "fx-fondo": "#262b35", "fx-panel": "#2e3440", "fx-panel-2": "#343b48", "fx-borde": "#434c5c", "fx-borde-2": "#3a4250",
    "fx-hover": "#384050", "fx-fila": "#323946",
    "fx-t0": "#ffffff", "fx-t1": "#e6eaf0", "fx-t2": "#b3bccb", "fx-t3": "#a3adbd", "fx-t4": "#4a5263",
    "fx-acento": "#00a3e0", "fx-acento-2": "#33b8e8", "fx-acento-t": "#5cc8ee", "fx-sobre-acento": "#06203f",
    "fx-suave": "#1d3a5c", "fx-suave-t": "#a9d9f2", "fx-suave-borde": "#2c5380",
    "fx-ia": "#00a3e0", "fx-ia-s": "#173748", "fx-ia-t": "#8fd8f5", "fx-ia-borde": "#1f5873",
    "fx-verde": "#2fd1a6", "fx-verde-s": "#12352d", "fx-verde-t": "#6fe0c0",
    "fx-papel": "#232831", "fx-papel-trama": "rgb(230 234 240/.04)", "fx-burbuja-xen": "#1b4257",
    "fx-nombre-xen": "#8fd8f5", "fx-hora-burbuja": "#b4cbd8",
    "fx-oscura": "#1b2029", "fx-oscura-t": "#b3bccb",
    "fx-anillo": "0 0 0 3px rgb(0 163 224/.5)",
}
# Texto contra el fondo donde aparece.
PAIRS = [
    ("fx-t0", "fx-fondo"), ("fx-t0", "fx-panel"), ("fx-t1", "fx-fondo"), ("fx-t1", "fx-panel"), ("fx-t1", "fx-fila"),
    ("fx-t2", "fx-fondo"), ("fx-t2", "fx-panel"), ("fx-t2", "fx-hover"), ("fx-t3", "fx-fondo"), ("fx-t3", "fx-panel"), ("fx-t3", "fx-panel-2"),
    ("fx-sobre-acento", "fx-acento"), ("fx-sobre-acento", "fx-acento-2"), ("fx-acento-t", "fx-panel"), ("fx-acento-t", "fx-fondo"),
    ("fx-suave-t", "fx-suave"), ("fx-ia-t", "fx-ia-s"), ("fx-ia-t", "fx-panel"), ("fx-verde-t", "fx-verde-s"), ("fx-verde-t", "fx-panel"),
    ("fx-nombre-xen", "fx-burbuja-xen"), ("fx-hora-burbuja", "fx-burbuja-xen"), ("fx-t1", "fx-burbuja-xen"), ("fx-t1", "fx-papel"),
    ("fx-oscura-t", "fx-oscura"),
]
# Colores de la piel de fabrica de XENCRM y su equivalente en Neona Tech, para la consola y la portada.
FABRICA = {
    "#0b7466": "#0a2a5e", "#095e53": "#082149", "#2fb5a0": "#0b6aa2", "#e2f2ee": "#e3ecf8", "#bfe3da": "#bcd0ec", "#075247": "#0a2a5e",
    "#0a2227": "#0a2a5e", "#12333a": "#2e3440", "#4d666c": "#555e6e", "#5c7177": "#5f6878", "#dae3e1": "#d9dee7", "#e8eeed": "#e7ebf1",
    "#f5f8f7": "#f4f6fa", "#edf3f1": "#edf1f7", "#eef3f2": "#eef2f7", "#f4f7f6": "#f4f6fa", "#7cc9bb": "#7fc4e8", "#b8c6c4": "#b9c2d0",
    "#6d4fe0": "#007fb0", "#9d8cff": "#5cc8ee", "#eafffb": "#eaf7ff", "#7fe3d1": "#7fd4f2", "#c9bfff": "#b9c8e0",
    # Fondo y olas de la portada, la burbuja del asistente y el boton.
    "#073b39": "#071b3f", "#3a2bb0": "#0a2a5e", "#0a3f3b": "#071b3f", "#3d2fb3": "#0a2a5e",
    "#0e8a79": "#0a2a5e", "#5a45d6": "#0b6aa2", "#e7fbf6": "#ffffff", "#ece8ff": "#e3ecf8",
}
PORTADA = [  # Las olas, mas sobrias que el reemplazo general, para que el titulo se lea encima.
    ("--ola-1:#0a2a5e; --ola-2:#0b6aa2; --ola-3:#007fb0; --ola-4:#5cc8ee; --ola-brillo:#eaf7ff;",
     "--ola-1:#0a2a5e; --ola-2:#0b4f8a; --ola-3:#0b6aa2; --ola-4:#00a3e0; --ola-brillo:#bfe6f7;"),
    ("rgba(7,30,34,.55)", "rgba(7,27,63,.55)"),
    ('<meta name="theme-color" content="#071b3f">', '<meta name="theme-color" content="#0a2a5e">'),  # la barra del navegador, en el azul de la marca
]
FUENTES = "family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&family=Sora:wght@500;600;700"


def lum(h):
    h = h.lstrip("#")
    if len(h) == 3: h = "".join(c * 2 for c in h)
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4 for v in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def contrast(a, b):
    x, y = sorted([lum(a), lum(b)], reverse=True)
    return (x + 0.05) / (y + 0.05)


def read(name):
    return (root / name).read_text(encoding="utf-8") if (root / name).exists() else None


def write(name, text):
    with open(root / name, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def fonts(text):
    text = re.sub(r"family=Bricolage\+Grotesque[^\"'&]*(&family=Figtree[^\"'&]*)?", FUENTES, text)
    text = text.replace('"Bricolage Grotesque"', "Sora")
    return re.sub(r"(?<![\"\w])Figtree\b", '"IBM Plex Sans"', text)


COMENTARIO = r"(/\*[\s\S]*?\*/|<!--[\s\S]*?-->)"


def name(text):
    """El nombre del producto en lo que se ve. Deja quietos los identificadores (window.XENCRM_QUIEN)."""
    text = re.sub(r"(<span[^>]*>)XEN(</span>)CRM", r"\1NEX\2ARM", text)
    # Los comentarios no se ven y las pruebas de XENCRM ubican sus bloques por ellos: quedan como vienen.
    parts = re.split(COMENTARIO, text)
    return "".join(p if i % 2 else re.sub(r"XENCRM(?![_A-Za-z0-9])", "Nexarm", p) for i, p in enumerate(parts))


for label, values in (("claro", CLARO), ("oscuro", OSCURO)):
    low = [(contrast(values[fg], values[bg]), fg, bg) for fg, bg in PAIRS]
    for r, fg, bg in low:
        if r < 4.5: sys.exit(f"contraste bajo en {label}: {fg} sobre {bg} = {r:.2f}")
    print(f"{label}: {len(PAIRS)} pares de texto y fondo, contraste minimo {min(low)[0]:.2f}")

# 1. Tablero
admin = read("admin.html")
for selector, values in ((':root[data-piel="xen"]{', CLARO), (':root[data-piel="xen"][data-theme=dark]{', OSCURO)):
    a = admin.index(selector)
    b = admin.index("\n}", a) + 2
    block = admin[a:b]
    for token, value in values.items():
        block, n = re.subn(r"(--%s:)[^;]+;" % re.escape(token), lambda m: m.group(1) + value + ";", block)
        if n != 1: sys.exit(f"el token --{token} aparece {n} veces en {selector}: la piel de XENCRM cambio, revisa este script")
    admin = admin[:a] + block + admin[b:]
write("admin.html", name(fonts(admin)))
print("admin.html: paleta, tipografia y nombre")

# 2. Consola y portada
for file in ("consola.html", "inicio.html"):
    text = read(file)
    if text is None: continue
    for old, new in FABRICA.items():
        text = re.sub(re.escape(old), new, text, flags=re.I)
    text = re.sub(r"rgba\(10,\s*34,\s*39,", "rgba(10,42,94,", text)
    text = re.sub(r"rgb\(10 34 39/", "rgb(10 42 94/", text)
    if file == "inicio.html":
        for old, new in PORTADA: text = text.replace(old, new)
    write(file, name(fonts(text)))
    print(f"{file}: paleta, tipografia y nombre")

# 3. El nombre en el resto de lo que se ve
for path in sorted(root.glob("*")):
    if path.suffix not in (".html", ".js") or path.name in ("admin.html", "consola.html", "inicio.html"): continue
    text = path.read_text(encoding="utf-8")
    renamed = name(fonts(text)) if path.suffix == ".html" else name(text)
    if renamed != text:
        write(path.name, renamed)
        print(f"{path.name}: nombre")

left = sum(len(re.findall(r"XENCRM(?![_A-Za-z0-9])", re.sub(COMENTARIO, "", p.read_text(encoding="utf-8")))) for p in root.glob("*") if p.suffix in (".html", ".js"))
print(f"menciones visibles de XENCRM que quedan en public/: {left}")

# 4. Las comprobaciones que nombran la marca de fabrica esperan la de Nexarm
PRUEBAS = {
    "facil.ts": [(r'/family=Bricolage\+Grotesque:[^"]*&family=Figtree:/', r'/family=IBM\+Plex\+Mono:[^"]*&family=IBM\+Plex\+Sans:[^"]*&family=Sora:/')],
    "optimizacion.ts": [("/Esto lo hace quien administra XENCRM/", "/Esto lo hace quien administra Nexarm/")],
    "agenda.ts": [("'XENCRM no le avisa: díselo tú en el chat.'", "'Nexarm no le avisa: díselo tú en el chat.'")],
    "prospectos.ts": [(r"/<span>XEN<\/span>CRM/", r"/<span>NEX<\/span>ARM/")],
}
evals = root.parent / "src" / "eval"
for file, pairs in PRUEBAS.items():
    path = evals / file
    text = path.read_text(encoding="utf-8")
    for old, new in pairs:
        if old in text: text = text.replace(old, new)
        elif new not in text: sys.exit(f"{file}: no esta la comprobacion de marca esperada: XENCRM la cambio, revisa este script")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
print(f"src/eval: {len(PRUEBAS)} comprobaciones de marca")
