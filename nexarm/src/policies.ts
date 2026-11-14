import { z } from "zod";
import type { Tx } from "./db.ts";

export const POLICY_KINDS = ["monto_maximo", "limite_frecuencia", "horario", "campos_restringidos", "requiere_aprobacion"] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "usa HH:MM");
const zona = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}, "zona horaria desconocida");

/** Forma de los parametros de cada tipo de politica. */
export const paramSchemas = {
  /** El campo numerico indicado no puede superar el maximo. */
  monto_maximo: z.object({ campo: z.string().default("amount"), maximo: z.number().positive() }),
  /** Tope de llamadas ejecutadas por agente dentro de una ventana movil. */
  limite_frecuencia: z.object({ maximo: z.number().int().positive(), ventana_minutos: z.number().int().positive() }),
  /** Dias (0 = domingo) y franja en que se permite actuar, en la zona indicada. */
  horario: z.object({ zona, dias: z.array(z.number().int().min(0).max(6)).min(1), desde: hhmm, hasta: hhmm }),
  /** Campos que el agente no puede escribir ni ver. */
  campos_restringidos: z.object({ campos: z.array(z.string().min(1)).min(1) }),
  /** La llamada espera a una persona. Con desde, solo cuando el campo numerico llega a ese valor. */
  requiere_aprobacion: z.object({
    campo: z.string().default("amount"), desde: z.number().positive().optional(),
    vence_horas: z.number().int().positive().max(720).default(24),
  }),
} satisfies Record<PolicyKind, z.ZodType>;

export class PolicyDenied extends Error {
  constructor(readonly policy: string, reason: string) { super(reason); }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

function withinSchedule(p: z.infer<typeof paramSchemas.horario>, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: p.zona, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((x) => x.type === type)!.value;
  const minute = Number(get("hour")) * 60 + Number(get("minute"));
  const [from, to] = [toMinutes(p.desde), toMinutes(p.hasta)];
  const inWindow = from <= to ? minute >= from && minute < to : minute >= from || minute < to;
  return p.dias.includes(WEEKDAYS.indexOf(get("weekday"))) && inWindow;
}

export interface ApprovalNeed { policy?: string; reason: string; hours: number }

export interface PolicyCall {
  agentId: string;
  tool: string;
  isWrite: boolean;
  /** Herramientas de escritura, para contar solo esas cuando la politica aplica a escritura. */
  writeTools: string[];
  args: Record<string, unknown>;
  now: Date;
}

/**
 * Evalua las politicas activas que alcanzan esta llamada. Lanza PolicyDenied en la primera que la bloquea.
 * Devuelve los campos que hay que ocultar y, si alguna politica lo exige, la aprobacion humana pendiente.
 * Un bloqueo siempre gana a una aprobacion: una persona no aprueba lo que otra politica prohibe.
 */
export async function evaluatePolicies(tx: Tx, call: PolicyCall): Promise<{ restricted: Set<string>; approval?: ApprovalNeed }> {
  const { rows } = await tx.query<{ name: string; kind: PolicyKind; params: any; tool: string | null; applies_to: string }>(
    `select name, kind, params, tool, applies_to from policies
     where enabled and (agent_id is null or agent_id = $1) and (tool is null or tool = $2)
       and (applies_to = 'todas' or $3) order by name`,
    [call.agentId, call.tool, call.isWrite]);

  const restricted = new Set<string>();
  let approval: ApprovalNeed | undefined;
  for (const p of rows) {
    switch (p.kind) {
      case "monto_maximo": {
        const value = call.args[p.params.campo];
        if (typeof value === "number" && value > p.params.maximo) {
          throw new PolicyDenied(p.name, `${p.params.campo} ${value} supera el maximo de ${p.params.maximo}`);
        }
        break;
      }
      case "limite_frecuencia": {
        const since = new Date(call.now.getTime() - p.params.ventana_minutos * 60_000).toISOString();
        const used = await tx.query<{ n: number }>(
          `select count(*)::int as n from audit_log
           where agent_id = $1 and outcome = 'ejecutado' and at > $2
             and ($3::text is null or tool = $3) and ($4::text[] is null or tool = any($4))`,
          [call.agentId, since, p.tool, p.applies_to === "escritura" ? call.writeTools : null]);
        if (used.rows[0]!.n >= p.params.maximo) {
          throw new PolicyDenied(p.name, `limite de ${p.params.maximo} llamadas cada ${p.params.ventana_minutos} minutos alcanzado`);
        }
        break;
      }
      case "horario":
        if (!withinSchedule(p.params, call.now)) {
          throw new PolicyDenied(p.name, `fuera del horario permitido (${p.params.desde} a ${p.params.hasta}, ${p.params.zona})`);
        }
        break;
      case "campos_restringidos": {
        const written = (p.params.campos as string[]).filter((c) => call.args[c] !== undefined);
        if (written.length) throw new PolicyDenied(p.name, `campos restringidos para este agente: ${written.join(", ")}`);
        for (const c of p.params.campos as string[]) restricted.add(c);
        break;
      }
      case "requiere_aprobacion": {
        const value = call.args[p.params.campo];
        const reached = p.params.desde === undefined || (typeof value === "number" && value >= p.params.desde);
        if (reached && !approval) {
          const reason = p.params.desde === undefined
            ? `${call.tool} requiere aprobacion humana`
            : `${p.params.campo} ${value} llega a ${p.params.desde}: requiere aprobacion humana`;
          approval = { policy: p.name, reason, hours: p.params.vence_horas ?? 24 };
        }
        break;
      }
    }
  }
  return { restricted, approval };
}
