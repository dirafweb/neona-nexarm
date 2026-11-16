import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { mcpTools, type MCPCallToolResultLike, type MCPClientLike } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import OpenAI from "openai";
import { SALES_AGENTS, systemPrompt, type SalesAgent } from "./agents.ts";

export type Provider = "anthropic" | "openai";

const ANTHROPIC_MODEL = "claude-opus-5-5";
const OPENAI_MODEL = "gpt-5.5";
const MAX_ITERATIONS = 40;
/** Una cuenta con pocas llamadas por minuto responde 429: el SDK espera lo que la API indica y reintenta. */
const RATE_LIMIT_WAITS = 8;
// Cuenta con cupo de 3 llamadas por minuto: tras el primer limite, una llamada cada 21 s.
const RATE_LIMIT_GAP_MS = 21_000;
let gapMs = 0;
let nextCallAt = 0;

/** NEXARM_PROVEEDOR manda. Sin el, se usa el proveedor cuya clave este en el entorno. */
export function pickProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  if (env.NEXARM_PROVEEDOR === "openai" || env.NEXARM_PROVEEDOR === "anthropic") return env.NEXARM_PROVEEDOR;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  return env.OPENAI_API_KEY ? "openai" : "anthropic";
}

export interface RunResult {
  /** Informe final del agente para la persona que supervisa. */
  report: string;
  stopReason: string | null;
}

interface Turn {
  agent: SalesAgent;
  task: string;
  mcp: Client;
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
}

const outOfSteps = (text: string): RunResult =>
  ({ report: `${text}\n\nEl agente llego al limite de ${MAX_ITERATIONS} pasos sin terminar.`.trim(), stopReason: "limite" });

async function withClaude({ agent, task, mcp, tools }: Turn, anthropic: Anthropic): Promise<RunResult> {
  // El cliente MCP declara ademas un formato de resultado antiguo que este servidor no usa.
  const caller: MCPClientLike = { callTool: async (p) => (await mcp.callTool(p)) as MCPCallToolResultLike };
  const final = await anthropic.beta.messages.toolRunner({
    model: ANTHROPIC_MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium" },
    // Si el modelo declina por una politica de seguridad, la API reintenta en el modelo de respaldo.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: systemPrompt(agent),
    tools: mcpTools(tools, caller),
    messages: [{ role: "user", content: task }],
    max_iterations: MAX_ITERATIONS,
  });
  const text = final.content.flatMap((b) => b.type === "text" ? [b.text] : []).join("\n").trim();
  if (final.stop_reason === "refusal") {
    return { report: `El modelo declino el encargo (${final.stop_details?.category ?? "sin categoria"}).`, stopReason: "refusal" };
  }
  return final.stop_reason === "tool_use" ? outOfSteps(text) : { report: text, stopReason: final.stop_reason };
}

/** Con el cupo por minuto agotado, espera a que se libere y repite la llamada. */
async function paced<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = nextCallAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextCallAt = Date.now() + gapMs;
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof OpenAI.RateLimitError) || attempt >= RATE_LIMIT_WAITS) throw err;
      gapMs = RATE_LIMIT_GAP_MS;
      nextCallAt = Date.now() + gapMs;
    }
  }
}

async function withOpenAI({ agent, task, mcp, tools }: Turn, openai: OpenAI, model: string): Promise<RunResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(agent) },
    { role: "user", content: task },
  ];
  const functions: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
    type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema },
  }));
  let last = "";
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const choice = (await paced(() => openai.chat.completions.create({ model, messages, tools: functions }))).choices[0]!;
    const message = choice.message;
    messages.push(message);
    last = (message.content ?? message.refusal ?? "").trim();
    const calls = (message.tool_calls ?? []).flatMap((c) => c.type === "function" ? [c] : []);
    if (!calls.length) return { report: last, stopReason: choice.finish_reason };
    for (const c of calls) {
      let content: string;
      try {
        const out = await mcp.callTool({ name: c.function.name, arguments: JSON.parse(c.function.arguments || "{}") });
        content = (out.content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("\n");
      } catch (err) {
        // El modelo ve el fallo y puede corregir la llamada.
        content = `Error: ${err instanceof Error ? err.message : err}`;
      }
      messages.push({ role: "tool", tool_call_id: c.id, content });
    }
  }
  return outOfSteps(last);
}

/**
 * Corre un agente de venta sobre un encargo. El agente no toca la base: solo llama herramientas MCP
 * con su propia credencial, asi que la pasarela lo autoriza, lo limita y lo registra igual con cualquier modelo.
 */
export async function runAgent(opts: {
  agent: SalesAgent; token: string; task: string; mcpUrl: URL;
  provider?: Provider; anthropic?: Anthropic; openai?: OpenAI; openaiModel?: string;
}): Promise<RunResult> {
  const provider = opts.provider ?? pickProvider();
  const mcp = new Client({ name: `nexarm-${opts.agent.name}`, version: "0.1.0" });
  await mcp.connect(new StreamableHTTPClientTransport(opts.mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  }));
  try {
    const tools = (await mcp.listTools()).tools.filter((t) => opts.agent.tools.includes(t.name));
    const turn: Turn = { agent: opts.agent, task: opts.task, mcp, tools };
    return provider === "openai"
      ? await withOpenAI(turn, opts.openai ?? new OpenAI({ maxRetries: 0 }), opts.openaiModel ?? process.env.OPENAI_MODEL ?? OPENAI_MODEL)
      : await withClaude(turn, opts.anthropic ?? new Anthropic());
  } finally {
    await mcp.close();
  }
}

/** Causa y arreglo de un fallo, en una frase cada uno. */
function explain(err: unknown, base: string): [string, string] {
  const again = "repite el comando.";
  for (const [sdk, name, key] of [[Anthropic, "Anthropic", "ANTHROPIC_API_KEY"], [OpenAI, "OpenAI", "OPENAI_API_KEY"]] as const) {
    if (err instanceof sdk.RateLimitError) return [`La API de ${name} limito las llamadas o la cuenta no tiene saldo.`, `revisa el saldo, espera un minuto y ${again}`];
    if (err instanceof sdk.AuthenticationError) return [`La API de ${name} rechazo la credencial.`, `revisa ${key} y ${again}`];
    if (err instanceof sdk.APIConnectionError) return [`No hubo conexion con la API de ${name}.`, `revisa la red y ${again}`];
    if (err instanceof sdk.APIError) return [`La API de ${name} respondio ${err.status}: ${err.message}`, `corrige lo que indica el mensaje y ${again}`];
  }
  // Cualquier otro fallo de un SDK ocurre antes de llamar a la API: no encontro credencial.
  if (err instanceof Anthropic.AnthropicError) return ["Falta la credencial de la API de Anthropic.", `define ANTHROPIC_API_KEY, o NEXARM_PROVEEDOR=openai, y ${again}`];
  if (err instanceof OpenAI.OpenAIError) return ["Falta la credencial de la API de OpenAI.", `define OPENAI_API_KEY en esta terminal y ${again}`];
  return [`No se pudo conectar con Nexarm en ${base}: ${err instanceof Error ? err.message : err}`, "arranca el servidor con `pnpm start`."];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [name, ...rest] = process.argv.slice(2);
  const agent = SALES_AGENTS.find((a) => a.name === name);
  const base = process.env.NEXARM_URL ?? "http://127.0.0.1:8787";
  let token: string | undefined;
  try {
    token = agent && JSON.parse(readFileSync(".tokens.local.json", "utf8")).tokens?.[agent.name];
  } catch { /* sin archivo: se informa abajo */ }
  process.exitCode = 1;
  if (!agent) {
    console.error(`Uso: pnpm agente <${SALES_AGENTS.map((a) => a.name).join("|")}> ["encargo"]`);
  } else if (!token) {
    console.error(`Falta el token de ${agent.name} en .tokens.local.json.\nArreglo: deten el servidor, corre \`pnpm seed\` y vuelve a arrancarlo.`);
  } else {
    try {
      const out = await runAgent({ agent, token, task: rest.join(" ").trim() || agent.defaultTask, mcpUrl: new URL("/mcp", base) });
      console.log(out.report);
      process.exitCode = 0;
    } catch (err) {
      const [cause, fix] = explain(err, base);
      console.error(`${cause}\nArreglo: ${fix}`);
    }
  }
}
