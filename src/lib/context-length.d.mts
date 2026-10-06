export function contextLengthFromModelRow(row: {
  id?: string;
  state?: string;
  loaded_context_length?: number;
  max_context_length?: number;
  capabilities?: { contextLength?: number | null };
}): number | undefined;
