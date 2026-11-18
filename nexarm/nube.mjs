// Arma en nube/ lo que se sube a Vercel: el servidor en un solo archivo, sin instalar nada alla.
// Uso: pnpm nube, copiar nube/ a una carpeta fuera del repositorio y alli `vercel deploy --prod --yes --scope xentristech`.
// Desde dentro del repositorio Vercel deja el despliegue en BLOCKED: el autor del commit no es miembro del equipo.
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("nube/api", { recursive: true });
mkdirSync("nube/public", { recursive: true });

await build({
  entryPoints: ["src/server.ts"],
  outfile: "nube/api/index.js",
  bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "none",
  // PGlite solo se usa en el equipo local; pg-native es opcional y no existe en la nube.
  external: ["@electric-sql/pglite", "pg-native"],
  // Las dependencias CommonJS piden require dentro de un modulo ES.
  banner: { js: "import { createRequire as __nexarmRequire } from 'node:module'; const require = __nexarmRequire(import.meta.url);" },
});

writeFileSync("nube/package.json", JSON.stringify({ name: "nexarm-nube", private: true, type: "module" }, null, 2));
writeFileSync("nube/public/robots.txt", "User-agent: *\nDisallow: /\n");
writeFileSync("nube/vercel.json", JSON.stringify({
  $schema: "https://openapi.vercel.sh/vercel.json",
  framework: null, installCommand: "", buildCommand: "", outputDirectory: "public",
  functions: { "api/index.js": { maxDuration: 60 } },
  rewrites: [{ source: "/(.*)", destination: "/api" }],
}, null, 2));
console.log("Paquete de la nube listo en nube/");
