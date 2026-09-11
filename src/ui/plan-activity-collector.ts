import { defaultSuperPlanClaimTransport } from '../chat/super-plan/claim-loop';
import { subscribeSuperPlanEvents } from '../chat/super-plan/events';
import { findChatById } from '../state/sessions';
import { ActivityLogBuffer } from '../research/activity-log';

/** Durable stage history plus live runner activity, scoped to one run. */
export class PlanActivityCollector {
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  constructor(private readonly chatId: string, private readonly buffer: ActivityLogBuffer) {}
  async start(): Promise<void> {
    this.stop();
    const runId = findChatById(this.chatId)?.superPlanRunId;
    if (!runId || typeof EventSource === 'undefined') return;
    const generation = this.generation;
    this.unsubscribe = subscribeSuperPlanEvents(runId, (type, data) => {
      if (generation !== this.generation) return;
      if (type === 'snapshot') {
        for (const [index, row] of (data.state?.stageRecords ?? []).entries()) {
          this.buffer.append({ id: row.seq ? `${runId}-event-${row.seq}` : `${runId}-stage-${index}`, atMs: row.atMs ?? 0, kind: 'stage', label: `${row.stage}: ${row.outcome}`, detail: row.summary });
        }
      } else if (type === 'event' && ['stage.started', 'stage.ended', 'gate.opened', 'gate.answered', 'run.stopped', 'run.resumed', 'run.finished'].includes(data.type)) {
        this.buffer.append({ id: `${runId}-event-${data.seq}`, atMs: data.ts ?? Date.now(), kind: 'stage', label: `${data.stage ?? data.kind ?? 'Plan'}: ${data.type.split('.')[1]}`, detail: data.summary });
      } else if (type === 'live' && data.event?.type === 'research.progress') {
        const event = data.event;
        this.buffer.append({ id: `${runId}-research-${event.phase}`, atMs: Date.now(), kind: 'stage', label: event.phase ?? 'Research' });
      }
    });
    const state = await defaultSuperPlanClaimTransport.fetchState(runId).catch(() => null);
    if (generation !== this.generation) return;
    for (const [index, row] of (state?.stageRecords ?? []).entries()) {
      this.buffer.append({ id: row.seq ? `${runId}-event-${row.seq}` : `${runId}-stage-${index}`, atMs: row.atMs ?? 0, kind: 'stage', label: `${row.stage}: ${row.outcome}`, detail: row.summary });
    }
  }
  stop(): void {
    this.generation++;
    this.unsubscribe?.(); this.unsubscribe = null;
  }
}
