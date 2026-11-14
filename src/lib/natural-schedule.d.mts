export type ParsedScheduleKind = 'interval' | 'cron' | 'manual';
export interface ParsedSchedule { kind: ParsedScheduleKind; value: string }
export type NaturalScheduleResult =
  | { ok: true; schedule: ParsedSchedule; description: string }
  | { ok: false; error: string };
export function parseNaturalSchedule(input: string): NaturalScheduleResult;
export function describeSimpleCron(expression: string): string | null;
export function describeAnySchedule(schedule: { kind: string; value: string } | null | undefined): string;
export function formatClock(hour: number, minute: number): string;
