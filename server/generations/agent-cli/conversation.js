import { cliHash } from './checkpoints.js';

/** UI reasoning/transport annotations are not part of the inference transcript. */
export function canonicalCliMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('CLI requires a conversation.');
  return messages.map(row => ({ role: row.role, content: row.content ?? '',
    ...(row.role === 'tool' ? { tool_call_id: row.tool_call_id } : {}),
    ...(row.tool_calls?.length ? { tool_calls: row.tool_calls.map(call => ({ id: call.id, type: 'function',
      function: { name: call.function?.name, arguments: call.function?.arguments } })) } : {}) }));
}
export function cliContinuation(before, after) {
  if (after.length <= before.length || cliHash(after.slice(0, before.length)) !== cliHash(before)) return null;
  const appended = after.slice(before.length);
  return appended.every(row => row.role === 'user') ? appended : null;
}

export function cliRebuildReason(session, body, identity) {
  const systems = rows => canonicalCliMessages(rows).filter(row => ['system', 'developer'].includes(row.role));
  if (cliHash(systems(session.messages)) !== cliHash(systems(body.messages))) return 'Instructions changed.';
  if (session.identity.workspace !== identity.workspace) return 'Workspace changed.';
  if (session.identity.account !== identity.account) return 'Account changed.';
  if (session.modelId !== body.model) return 'Model changed.';
  if (cliHash(session.originalTools) !== cliHash(body.tools ?? [])) return 'Tools changed.';
  if (cliHash(session.identity.settings) !== cliHash(identity.settings)) return 'Generation settings changed.';
  return 'Recorded history or generation configuration changed.';
}

export function withCliTurnContext(text, context) {
  return context ? `<minnow_turn_context>\nThe following context applies to this turn. Earlier turn-context blocks are historical.\n${context}\n</minnow_turn_context>\n\n${text}` : text;
}
