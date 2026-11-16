import { onExecuted } from "../gateway.ts";
import { SALES_AGENTS, type SalesAgent } from "./agents.ts";
import type { RunResult } from "./run.ts";

export interface AutoOptions {
  /** Cliente cuyos mensajes entrantes despiertan a los agentes. */
  tenantId: string;
  run(agent: SalesAgent, task: string): Promise<RunResult>;
  /** Espera tras el ultimo mensaje de un contacto, para atender una rafaga en una sola ronda. */
  waitMs?: number;
  log?(line: string): void;
}

const task = (contactId: string) =>
  `Acaba de escribir el contacto ${contactId}. Trabaja solo con ese contacto: lee su historial con activity_list ` +
  "y haz tu parte con lo que dice su ultimo mensaje.";

/**
 * Despierta a los agentes de venta cuando entra un mensaje de un cliente: prospeccion, calificacion y seguimiento,
 * uno tras otro y un contacto a la vez. Cada agente sigue pasando por la pasarela con su propia credencial.
 */
export function startAuto(opts: AutoOptions): { stop(): void; idle(): Promise<void> } {
  const waitMs = opts.waitMs ?? 20_000;
  const log = opts.log ?? console.log;
  const timers = new Map<string, NodeJS.Timeout>();
  let queue = Promise.resolve();

  async function serve(contactId: string): Promise<void> {
    for (const agent of SALES_AGENTS) {
      try {
        const out = await opts.run(agent, task(contactId));
        log(`[auto] ${agent.name} · contacto ${contactId} · ${out.report.split("\n")[0]}`);
      } catch (err) {
        // Un agente que falla no deja al contacto sin los demas.
        log(`[auto] ${agent.name} · contacto ${contactId} · fallo: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const off = onExecuted((agent, tool, data) => {
    const d = data as { duplicate?: boolean; contact_id?: string } | undefined;
    if (tool !== "message_receive" || agent.tenantId !== opts.tenantId || !d?.contact_id || d.duplicate) return;
    const id = d.contact_id;
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      queue = queue.then(() => serve(id));
    }, waitMs));
  });

  return {
    stop() {
      off();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    /** Termina cuando no queda ningun contacto por atender. */
    async idle() {
      while (timers.size) await new Promise((r) => setTimeout(r, 5));
      await queue;
      if (timers.size) await this.idle();
    },
  };
}
