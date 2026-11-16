// Simula un mensaje de un cliente contra el servidor encendido, con la credencial del agente de entrada.
// Uso: tsx test/entrada-real.ts <correo> "<nombre>" "<mensaje>"
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [email, name, body] = process.argv.slice(2);
const token = JSON.parse(readFileSync(".tokens.local.json", "utf8")).tokens["entrada-xencrm"];
const mcp = new Client({ name: "entrada-real", version: "0.1.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL("/mcp", process.env.NEXARM_URL ?? "http://127.0.0.1:8787"), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
const out = await mcp.callTool({
  name: "message_receive",
  arguments: { channel: "correo", external_id: `entrada-real:${Date.now()}`, email, name, body, origin: "Prueba de entrada" },
});
console.log((out.content as { text: string }[])[0]!.text);
await mcp.close();
