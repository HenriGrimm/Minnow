/**
 * MCP annotation hints for the permission classifier. Lives on its own so the
 * tool client can register a resolver without importing the permission gate
 * (the two modules import each other indirectly).
 */

export type ToolHint = 'read' | 'write' | 'destructive' | null;

let resolver: (name: string) => ToolHint = () => null;

export function setToolHintResolver(fn: (name: string) => ToolHint): void {
  resolver = fn;
}

export function resolveToolHint(name: string): ToolHint {
  return resolver(name);
}
