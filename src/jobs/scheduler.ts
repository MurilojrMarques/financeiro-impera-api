import { logger } from '../config/logger';
import { SyncBusyError } from '../modules/sincronizacao/sync.service';
import { sanitizeError } from '../shared/utils/text';

export interface Task {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

/** Agendador simples: um timer por tarefa, sem sobreposição de execuções da MESMA tarefa. */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private inFlight = new Set<Promise<void>>();
  private stopped = false;

  add(task: Task): void {
    const tick = (): void => {
      if (this.stopped) return;
      const p = this.runOnce(task).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    };
    this.timers.push(setInterval(tick, task.intervalMs));
  }

  async runOnce(task: Task): Promise<void> {
    if (this.running.has(task.name)) return;
    this.running.add(task.name);
    try {
      await task.run();
    } catch (err) {
      if (err instanceof SyncBusyError) logger.debug({ task: task.name }, 'sincronização ocupada, tarefa adiada');
      else logger.error({ task: task.name, msg: sanitizeError(err) }, 'tarefa agendada falhou');
    } finally {
      this.running.delete(task.name);
    }
  }

  private running = new Set<string>();

  /** Graceful shutdown: para novos ciclos e espera os em andamento. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    await Promise.allSettled([...this.inFlight]);
  }
}
