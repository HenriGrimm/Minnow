// Deliberately process-local. Neither request JSON, state serialization nor a
// provider preference can manufacture this server execution authority.
const contexts = new WeakMap();
const generations = new WeakMap();
const minnowOnly = new WeakSet();
const reject = message => Object.assign(new Error(message), { cliPolicyRejected: true });

export function createNativeExecutionContext(execution, identity) {
  if (!execution || !Object.isFrozen(execution) || !identity?.chatId || !identity.providerId || !identity.modelId) {
    throw reject('Native execution requires a frozen server authority and exact model/chat identity.');
  }
  contexts.set(execution, Object.freeze({ ...identity }));
  return execution;
}

export function assertNativeExecutionContext(execution, { chatId, providerId, modelId, body, fallbackRole } = {}) {
  const identity = contexts.get(execution);
  if (!identity || identity.chatId !== chatId || identity.providerId !== providerId || identity.modelId !== modelId
    || body?.model !== modelId || body?.tool_choice === 'none' || fallbackRole !== 'default') {
    throw reject('Native authority does not belong to this chat/model request, or this is a utility request.');
  }
  execution.signal.throwIfAborted();
  return execution;
}

export function bindNativeExecutionContext(state, execution) {
  assertNativeExecutionContext(execution, { chatId: state.chatId, providerId: state.providerId,
    modelId: state.candidates?.[0]?.modelId, body: JSON.parse(state.requestBody.toString('utf8')),
    fallbackRole: state.fallbackRole });
  if (state.candidates?.length !== 1 || state.candidates[0].providerId !== state.providerId) {
    throw reject('Native execution cannot use provider/model failover.');
  }
  generations.set(state, execution);
  state.failoverDisabled = true;
}

// The Codex adapter must use this accessor, not a similarly named body field.
export const getNativeExecutionContext = state => generations.get(state) ?? null;
/** Captured dynamic-only choice for accepted queue entries; not a native grant. */
export function bindMinnowOnlyExecution(state) { minnowOnly.add(state); }
export const isMinnowOnlyExecution = state => minnowOnly.has(state);
