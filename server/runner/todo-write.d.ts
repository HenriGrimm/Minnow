import type { ChatTodo } from '../../src/types';
export type TodoWriteArgs = { todos: ChatTodo[] };
export type ValidateTodoWriteResult = { ok: true; args: TodoWriteArgs } | { ok: false; error: string };
export function normalizeTodoStatus(raw: unknown): ChatTodo['status'];
export function normalizeTodoWriteArgs(args: Record<string, unknown>): Record<string, unknown>;
export function validateTodoWriteArgs(args: Record<string, unknown>): ValidateTodoWriteResult;
export function formatTodoProgress(todos: ChatTodo[]): string;
