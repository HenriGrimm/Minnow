import { validateModelSelection } from './contracts.js';

const active = new Set(['running', 'loading_model']);
const terminal = new Set(['completed', 'failed', 'stopped', 'settled', 'cancelled', 'recovery_required']);
const fields = ['name', 'groupId', 'pinnedAt', 'archivedAt', 'composerDraft', 'workspacePath', 'worktreeRoot', 'worktreeEnabled', 'providerId', 'modelId', 'modeId',
  'updatedAt', 'lastMessageAt', 'messageCount', 'lastStats', 'modelInfo', 'reasoningEffort',
  'agentConversation', 'agentTypeId', 'chatCommandVersion', 'profileReference', 'todos', 'todosUpdatedAt', 'worktreeSetupRequired', 'workspacePreparation'];
const summaryFields = ['name', 'workspacePath', 'worktreeRoot', 'modelId', 'providerId', 'modeId', 'messageCount',
  'lastMessageAt', 'updatedAt', 'agentConversation', 'agentTypeId', 'chatCommandVersion', 'agentExecution',
  'agentPendingCommand', 'agentRequestSummary', 'agentActivityCursor', 'agentPresentationRevision', 'agentTitleCandidate', 'unread', 'turnError'];

/** Bounded view state only. SQLite remains the transcript and command authority. */
export function createChatPresentation({ repository, now = Date.now, flushMs = 40 } = {}) {
  const live = new Map(), viewers = new Set(), timers = new Map(), externalRequests = new Map();
  let sequence = 0;
  function activity(chatId) {
    return repository.getActivity(chatId);
  }
  function notice(chatId) {
    const chat = repository.getChat(chatId), execution = chat.agentExecution, requests = chat.agentRequestSummary;
    return { kind: 'chat-changed', chatId, sequence: ++sequence, at: now(),
      execution: execution ? { executionId: execution.executionId, status: execution.status } : null, requests,
      fields: { ...Object.fromEntries(summaryFields.map(name => [name, chat[name] ?? null])), agentTaskAttention: repository.getTaskAttention(chatId) },
    };
  }
  function frame(chatId, { history = true, metadata = true } = {}) {
    const projection = activity(chatId), execution = projection.agentExecution;
    const state = live.get(chatId);
    const running = active.has(execution?.status);
    const result = { chatId, hostId: 'minnow-server', sequence: ++sequence, epoch: execution?.executionId ?? 'idle',
      running, live: running && state?.executionId === execution?.executionId && state.roundOpen ? {
        lastDelta: state.text, lastThinking: state.thinking, toolCallCount: state.toolCount,
        phase: state.phase, currentTool: state.tool,
      } : null };
    if (!metadata) return result;
    const chat = repository.getChat(chatId);
    const output = Object.fromEntries(fields.map(name => [name, chat[name] ?? null]));
    const profile = repository.getLatestProfile(chatId)?.snapshot;
    const selection = validateModelSelection(profile?.modelSelection);
    output.agentModelSelection = selection.ok ? selection.value : null;
    if (selection.ok) {
      output.reasoningEffort = selection.value.options?.reasoningEffort ?? null;
      output.thinkingMode = selection.value.options?.thinkingMode ?? null;
    }
    const ceiling = profile?.policy;
    output.agentAuthority = ceiling ? {
      modeId: ceiling.modeId, filesystemAccess: ceiling.filesystemAccess, fileWriteScope: ceiling.fileWriteScope,
      shellSandboxMode: ceiling.shellSandboxMode, toolPermissions: { ...ceiling.toolPermissions },
    } : null;
    const pending = repository.listCommands({ chatId, states: ['accepted', 'queued', 'waiting_for_host'], limit: 1000 })
      .filter(row => row.effectiveCommand.kind === 'send' || row.effectiveCommand.kind === 'steer');
    output.pendingMessageQueue = pending.map((row, index) => ({ id: row.commandId, text: row.effectiveCommand.message,
      createdAt: row.createdAt, commandRevision: row.revision, modelSelection: row.effectiveCommand.modelSelection,
      kind: row.effectiveCommand.kind, held: row.held, provenance: row.effectiveCommand.provenance,
      // Only the leading input can be presented as a sending transcript row.
      ...(index === 0 || row.effectiveCommand.kind === 'steer' ? {
        ...(row.effectiveCommand.images?.length ? { images: row.effectiveCommand.images } : {}),
        ...(row.effectiveCommand.intent?.issue ? { issue: row.effectiveCommand.intent.issue } : {}),
        ...(row.effectiveCommand.intent?.codeMap ? { codeMap: row.effectiveCommand.intent.codeMap } : {}),
        ...(row.effectiveCommand.intent?.suppressUserEcho ? { hiddenFromTranscript: true } : {}),
      } : {}),
    }));
    output.pendingSteerMessage = null;
    Object.assign(output, projection);
    output.agentRequests = repository.listRequestPresentation(chatId, { limit: 32, recentLimit: 0 }).requests;
    output.agentTaskAttention = repository.getTaskAttention(chatId);
    result.fields = output;
    if (history) {
      const transcript = repository.readTranscript(chatId)?.messages ?? [];
      const start = Math.max(0, transcript.length - 20);
      result.history = { start, length: transcript.length, messages: transcript.slice(start) };
    }
    return result;
  }
  function publish(chatId, withHistory = true) {
    const projectId = repository.getChatProjectId(chatId);
    if (!projectId) return;
    const audiences = [...viewers].filter(viewer => viewer.projectId === projectId && (withHistory || viewer.chatId === chatId));
    if (!audiences.length) return;
    const summary = withHistory ? notice(chatId) : null;
    let snapshot;
    for (const viewer of audiences) {
      try {
        if (viewer.chatId === chatId) { snapshot ??= frame(chatId, { history: withHistory, metadata: withHistory }); viewer.send({ kind: 'frame', frame: snapshot }); }
        else viewer.send(summary);
      } catch { viewers.delete(viewer); }
    }
  }
  function changed(chatId, withHistory = true) {
    const prior = timers.get(chatId);
    if (prior) { prior.history ||= withHistory; return; }
    const state = { history: withHistory };
    state.timer = setTimeout(() => { timers.delete(chatId); try { publish(chatId, state.history); } catch { /* Deletion is reconciled by session sync. */ } }, flushMs);
    state.timer.unref?.(); timers.set(chatId, state);
  }
  function externalRequestNotice(chatId) {
    const requests = repository.listRequests(chatId, 'pending').map(row => ({ requestId: row.requestId, kind: row.kind }));
    return { kind: 'chat-changed', chatId, sequence: ++sequence, at: now(), requests,
      fields: { agentRequestSummary: requests } };
  }
  return {
    frame,
    changed,
    externalRequestChanged({ chatId, projectId }) {
      // A live renderer owns its history. An approval must not promote that
      // chat or send a server snapshot over the renderer's unfinished turn.
      if (repository.getChatProjectId(chatId)) { changed(chatId); return; }
      const message = externalRequestNotice(chatId);
      if (message.requests.length) externalRequests.set(chatId, projectId);
      else externalRequests.delete(chatId);
      for (const viewer of [...viewers]) if (viewer.projectId === projectId) {
        try { viewer.send(message); } catch { viewers.delete(viewer); }
      }
    },
    onEvent({ chatId, executionId, event }) {
      // Payload-free diagnostics do not change the rendered conversation. A
      // timing span must not manufacture frames or trigger activity reads.
      if (event.type === 'runner_timing') return;
      let state = live.get(chatId);
      if (!state || state.executionId !== executionId) {
        if (activity(chatId)?.agentExecution?.executionId !== executionId) return;
        state = { executionId, text: '', thinking: '', phase: 'generating', tool: null, toolCount: 0, roundOpen: false };
        live.set(chatId, state);
      }
      if (event.type === 'round_start' || event.type === 'response_restart') {
        Object.assign(state, { text: '', thinking: '', tool: null, toolCount: 0, roundOpen: true });
      } else if (event.type === 'delta') state.text = event.text;
      else if (event.type === 'thinking') state.thinking = event.text;
      else if (event.type === 'phase') state.phase = event.phase;
      else if (event.type === 'loading_model') state.phase = 'loading_model';
      else if (event.type === 'tool_call') { state.tool = event.name; state.toolCount++; }
      else if (event.type === 'tool_streaming') state.tool = event.name;
      else if (event.type === 'tool_result') state.tool = null;
      else if (event.type === 'round_end') { state.roundOpen = false; state.tool = null; }
      changed(chatId, event.type === 'round_end' || event.type === 'round_start');
    },
    onServiceEvent(event) {
      // Configuration changes placement/model controls, never transcript content.
      // Send a notice even to the mounted viewer so background receipts cannot
      // trigger a full transcript hydration in the shared frame observer.
      if (event.type === 'configuration') {
        const projectId = repository.getChatProjectId(event.chatId);
        const audiences = [...viewers].filter(viewer => viewer.projectId === projectId);
        if (!audiences.length) return;
        const snapshot = frame(event.chatId, { history: false });
        const message = { kind: 'chat-changed', chatId: event.chatId, sequence: snapshot.sequence, fields: snapshot.fields };
        for (const viewer of audiences) {
          try { viewer.send(message); } catch { viewers.delete(viewer); }
        }
        return;
      }
      if (terminal.has(event.status) && event.executionId && live.get(event.chatId)?.executionId === event.executionId) live.delete(event.chatId);
      changed(event.chatId);
    },
    subscribe({ projectId, chatId, send }) {
      const viewer = { projectId, chatId, send }; viewers.add(viewer);
      try {
        if (chatId && repository.getChatProjectId(chatId) === projectId) send({ kind: 'frame', baseline: true, frame: frame(chatId) });
        for (const id of repository.listActiveChatIds({ projectId, limit: 100 })) {
          if (id !== chatId) send({ ...notice(id), baseline: true });
        }
        for (const [id, scopedProject] of externalRequests) if (scopedProject === projectId) send({ ...externalRequestNotice(id), baseline: true });
      } catch (error) { viewers.delete(viewer); throw error; }
      return () => viewers.delete(viewer);
    },
    dispose() { for (const state of timers.values()) clearTimeout(state.timer); timers.clear(); live.clear(); externalRequests.clear(); viewers.clear(); },
  };
}
