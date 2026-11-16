import express from "express";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { mountChatwoot } from "./chatwoot.ts";
import { mountConsole } from "./console.ts";
import { openDb, type Db } from "./db.ts";
import { execute, identify, type Agent } from "./gateway.ts";
import { SALES_AGENTS } from "./sales/agents.ts";
import { startAuto } from "./sales/auto.ts";
import { runAgent } from "./sales/run.ts";
import { tools } from "./tools.ts";
import { mountXencrmGovernance, startXencrm } from "./xencrm.ts";

function buildMcp(db: Db, agent: Agent, now: () => Date): McpServer {
  const mcp = new McpServer({ name: "nexarm", version: "0.1.0" });
  for (const tool of tools) {
    mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      const res = await execute(db, agent, tool.name, args, now());
      // Pendiente no es un fallo: la llamada espera a una persona.
      const failed = res.outcome === "denegado" || res.outcome === "error";
      return { content: [{ type: "text" as const, text: JSON.stringify(res) }], isError: failed };
    });
  }
  return mcp;
}

/**
 * now permite fijar el reloj en pruebas de horario, frecuencia y vencimiento.
 * baseUrl es la direccion publica del servidor: la usan los metadatos de OAuth.
 */
export function createApp(db: Db, now: () => Date = () => new Date(), baseUrl = new URL(process.env.NEXARM_URL ?? "http://127.0.0.1:8787")) {
  const app = express();
  mountConsole(app, db, now, baseUrl);
  mountChatwoot(app, db, now);
  app.use(express.json({ limit: "1mb" }));
  mountXencrmGovernance(app, db, now);
  const metadata = getOAuthProtectedResourceMetadataUrl(new URL("/mcp", baseUrl));

  app.post("/mcp", async (req, res) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const agent = token ? await identify(db, token, now()) : null;
    if (!agent) {
      // Un cliente MCP sin credencial descubre aqui donde pedirla por OAuth.
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadata}"`);
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "agente no identificado" }, id: null });
      return;
    }
    const mcp = buildMcp(db, agent, now);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const noSession = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "usa POST" }, id: null });
  };
  app.get("/mcp", noSession);
  app.delete("/mcp", noSession);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 8787);
  const db = await openDb(process.env.NEXARM_DATA ?? "./data/pg");
  const base = new URL(process.env.NEXARM_URL ?? `http://127.0.0.1:${port}`);
  const app = createApp(db, undefined, base);
  // NEXARM_HOST: direcciones donde escucha, separadas por coma. Sirve para que un Chatwoot en WSL alcance el webhook.
  for (const host of (process.env.NEXARM_HOST ?? "127.0.0.1").split(",").map((h) => h.trim()).filter(Boolean))
    app.listen(port, host, () => console.log(`Nexarm escucha en ${host}:${port}`));
  console.log(`Nexarm: consola en ${base.href} y MCP en ${new URL("/mcp", base).href}`);

  // Cierre ordenado: la base queda ilegible si el proceso muere sin cerrarla. `pnpm detener` crea el archivo de parada.
  const stopFile = process.env.NEXARM_STOP_FILE ?? "./data/.detener";
  rmSync(stopFile, { force: true });
  let stopping = false;
  const xencrm = startXencrm(db);
  // NEXARM_AGENTES_AUTO=1: cada mensaje entrante despierta a los agentes de venta, con las credenciales que dejo pnpm seed.
  let auto: ReturnType<typeof startAuto> | undefined;
  if (process.env.NEXARM_AGENTES_AUTO === "1") {
    const tokens: Record<string, string> = JSON.parse(readFileSync(".tokens.local.json", "utf8")).tokens ?? {};
    const first = await identify(db, tokens[SALES_AGENTS[0]!.name] ?? "");
    if (first) {
      const mcpUrl = new URL("/mcp", `http://127.0.0.1:${port}`);
      auto = startAuto({ tenantId: first.tenantId, run: (agent, task) => runAgent({ agent, token: tokens[agent.name]!, task, mcpUrl }) });
      console.log("Nexarm: agentes automaticos encendidos, atienden cada mensaje entrante");
    } else {
      console.error("Agentes automaticos apagados: .tokens.local.json no trae credenciales vigentes. Arreglo: pnpm seed con el servidor detenido.");
    }
  }
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    xencrm?.stop();
    auto?.stop();
    await db.close();
    rmSync(stopFile, { force: true });
    console.log("Nexarm detenido con la base cerrada");
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, stop);
  setInterval(() => { if (existsSync(stopFile)) void stop(); }, 1000);
}
