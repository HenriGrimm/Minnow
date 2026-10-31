import { ChatContractError } from './contracts.js';
import { AGENT_CHAT_TOOL_IDS } from './tool-catalog.js';
import { hashChatPayload } from './repository.js';

/** Local execution transport; a normal human command endpoint never accepts agent identity. */
export function createAgentChatToolsMiddleware({ getRuntime, approvalTimeoutMs = 120000 } = {}) {
  if (typeof getRuntime !== 'function') throw new TypeError('Agent chat transport requires its canonical runtime');
  if (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs < 1 || approvalTimeoutMs > 240000) throw new TypeError('A bounded approval deadline is required');
  return async (req, res, next) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/api/chats/agent-commands') return next();
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
    try {
      if (req.minnowAuth?.kind !== 'host') throw new ChatContractError('caller_denied', 'Only an authenticated owning computer execution may use agent chat tools');
      if (req.method !== 'POST') { send(405, { error: { code: 'invalid_request', message: 'Use POST for agent chat tools', retryable: false } }); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw new ChatContractError('invalid_request', 'Agent chat command exceeds its input budget'); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ChatContractError('invalid_request', 'Invalid agent chat JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['sourceChatId', 'ownerId', 'toolCallId', 'name', 'args'].includes(key)) ||
          !/^[A-Za-z0-9_-]{1,160}$/.test(body.sourceChatId ?? '') || !/^[A-Za-z0-9_-]{1,160}$/.test(body.ownerId ?? '') ||
          typeof body.toolCallId !== 'string' || !body.toolCallId || body.toolCallId.length > 256 || !AGENT_CHAT_TOOL_IDS.includes(body.name)) {
        throw new ChatContractError('invalid_request', 'A current source execution and known conversation tool are required');
      }
      const runtime = await getRuntime();
      if (!runtime.chatTools) throw new ChatContractError('capability_unavailable', 'Agent chat tools are unavailable');
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(new DOMException('Tool caller disconnected', 'AbortError')); };
      res.once('close', disconnected);
      try {
        const { caller } = await runtime.legacyCaller({ chatId: body.sourceChatId, ownerId: body.ownerId });
        const input = { caller, toolCallId: body.toolCallId, signal: controller.signal };
        let result;
        try { result = await runtime.chatTools.execute(body.name, body.args ?? {}, input); }
        catch (error) {
          if (!(error instanceof ChatContractError) || error.reason !== 'approval_required') throw error;
          if (typeof runtime.requests?.openLegacy !== 'function') throw new ChatContractError('capability_unavailable', 'The active legacy execution cannot receive a durable approval');
          const request = await runtime.requests.openLegacy({ caller, toolCallId: body.toolCallId, kind: 'approval',
            title: `Allow ${body.name}?`, presentation: { name: body.name, argsHash: hashChatPayload(body.args ?? {}),
              argsPreview: JSON.stringify(body.args ?? {}, Object.keys(body.args ?? {}).sort()).slice(0, 4000) } });
          const approvalSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(approvalTimeoutMs)]);
          let answer;
          try { answer = await runtime.requests.wait(request.requestId, { signal: approvalSignal }); }
          catch (waitError) {
            if (approvalSignal.aborted && !controller.signal.aborted) throw new ChatContractError('request_expired', 'This conversation approval timed out');
            throw waitError;
          }
          if (answer !== 'allow_once' && answer?.decision !== 'allow_once') throw new ChatContractError('policy_denied', 'The user declined this conversation operation');
          result = await runtime.chatTools.execute(body.name, body.args ?? {}, { ...input, approvalGranted: true });
        }
        send(200, { result });
      } finally { res.removeListener('close', disconnected); }
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      send(error instanceof ChatContractError ? error.statusCode : 500,
        { error: error instanceof ChatContractError ? error.toJSON() : { code: 'internal_error', message: 'Agent conversation operation failed', retryable: false } });
    }
  };
}
