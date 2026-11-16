/**
 * Identidad de Neona Tech para las pantallas de Nexarm, segun su manual de marca (neona.tech/marca):
 * azul profundo 60 %, gris antracita 25 %, cian 10 % como acento y verde esmeralda 5 % solo como enfasis, nunca superficie.
 * Sora en titulares, IBM Plex Sans en el cuerpo e IBM Plex Mono en etiquetas con el patron "// 0N · NOMBRE".
 */

const SUPERNOVA = (accent: string) => `<mask id="n" maskUnits="userSpaceOnUse" x="0" y="0" width="640" height="640"><rect width="640" height="640" fill="#fff"/><rect x="299" y="170" width="42" height="300" fill="#000" transform="rotate(-52 320 320)"/></mask><polygon fill="#fff" mask="url(#n)" points="272,50 320,20 368,50 368,590 320,620 272,590"/><polygon fill="#fff" points="193.8,302.6 58.7,224.6 56.7,168 106.7,141.4 241.8,219.4 243.8,276"/><polygon fill="${accent}" points="398.2,219.4 533.3,141.4 583.3,168 581.3,224.6 446.2,302.6 396.2,276"/><polygon fill="${accent}" points="241.8,420.6 106.7,498.6 56.7,472 58.7,415.4 193.8,337.4 243.8,364"/><polygon fill="#fff" points="446.2,337.4 581.3,415.4 583.3,472 533.3,498.6 398.2,420.6 396.2,364"/>`;

/** Simbolo en negativo, para el encabezado azul. El manual fija su minimo en 24 pt. */
export const ISOTIPO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640" width="32" height="32" role="img" aria-label="Neona Tech">${SUPERNOVA("#00A3E0")}</svg>`;

/** Icono digital: simbolo blanco sobre azul profundo. */
export const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><rect width="640" height="640" rx="128" fill="#0A2A5E"/><g transform="translate(96 96) scale(0.7)">${SUPERNOVA("#fff")}</g></svg>`)}`;

export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Sora:wght@600&display=swap">`;

export const CSS = `
:root{--azul:#0A2A5E;--antracita:#2E3440;--cian:#00A3E0;--verde:#00B386;
--bg:#fff;--fg:#2E3440;--head:#0A2A5E;--mut:#5b6474;--line:#d9dee7;--soft:#f3f5f9;--no:#b42318;--go:#0A2A5E;--on-go:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#2E3440;--fg:#f4f6fa;--head:#fff;--mut:#b6bfce;--line:#4a5263;--soft:#3a4150;--no:#ff8f85;--go:#00A3E0;--on-go:#0A2A5E}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px;background:var(--azul);color:#fff}
.brand{display:flex;align-items:center;gap:10px}.brand svg{display:block}
.brand b{font:600 17px/1 Sora,system-ui,sans-serif;letter-spacing:.14em}
header .tag{color:#c9d6ea;margin:0}header .mut{color:#c9d6ea}
header button{background:transparent;color:#fff;border-color:#5f7aa6}
main{max-width:980px;margin:0 auto;padding:16px}
h1,h2{font-family:Sora,system-ui,sans-serif;font-weight:600;color:var(--head);text-wrap:balance}
h1{font-size:24px;margin:4px 0 10px}h2{font-size:20px;margin:4px 0 10px}
.tag{font:500 12px/1.4 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:28px 0 0}
.card{border:1px solid var(--line);border-left:3px solid var(--cian);border-radius:8px;padding:12px;margin:8px 0}
.mut{color:var(--mut)}.no{color:var(--no)}.ok{white-space:nowrap}
.ok::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--verde);margin-right:6px}
pre,code{font-family:"IBM Plex Mono",ui-monospace,monospace}
pre{background:var(--soft);padding:8px;border-radius:6px;overflow-x:auto;margin:8px 0;font-size:13px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font:500 12px/1.4 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
a{color:var(--head)}
input,select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{cursor:pointer}button.go{background:var(--go);color:var(--on-go);border-color:var(--go);font-weight:500}
:focus-visible{outline:2px solid var(--cian);outline-offset:2px}
form.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}form.row input[type=text]{flex:1;min-width:160px}
form.stack{display:grid;gap:10px;max-width:320px}
.arm{background:var(--azul);color:#fff;border-radius:12px;padding:20px;margin:0 0 16px}
.arm h1{color:#fff;font-size:26px;margin:6px 0 16px}.arm .tag{color:#c9d6ea;margin:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:18px}
.tile{display:grid;gap:2px;padding:12px;border:1px solid #2f4f86;border-radius:8px;background:#0d3270}
.tile b{font:600 26px/1.15 Sora,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.tile span{font:500 12px/1.4 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#7fd3f2}
.tile small{color:#c9d6ea;font-size:13px}
.bar{display:grid;grid-template-columns:minmax(90px,150px) 1fr 32px;gap:10px;align-items:center;margin-top:8px;font-size:14px}
.bar i{height:8px;border-radius:4px;background:#0d3270}.bar u{display:block;height:8px;border-radius:4px;background:var(--cian)}
.bar b{text-align:right;font-variant-numeric:tabular-nums}
.bar small{display:block;font:500 11px/1.4 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#7fd3f2}
.bar em{grid-column:1/-1;font-style:normal;font-size:13px;color:#c9d6ea}
footer{max-width:980px;margin:32px auto 0;padding:16px;border-top:1px solid var(--line)}footer .tag{margin:0}
`;

export const FOOTER = `<footer><p class="tag">Nexarm · Neona Tech · El origen de nuevas posibilidades</p>
<p class="mut">Gobernanza de IA diseñada conforme a ISO 9001, ISO/IEC 27001 e ISO/IEC 42001.</p></footer>`;
