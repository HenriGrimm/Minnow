import { stripXmlToolCallBlocks } from "./xml-tool-calls.js";
const TURN_DEBUG_STORAGE_KEY = "minnowDebugTurns";
const MAX_EMPTY_POST_TOOL_RETRIES = 1;
const EMPTY_POST_TOOL_CONTINUE_INSTRUCTION = "You have tool results above. Reply to the user in plain language; do not call more tools unless necessary.";
const CONTINUE_AFTER_TRUNCATION_INSTRUCTION = "Your previous reply was cut off because of the output token limit. Continue exactly where you left off without repeating what you already wrote.";
const CONTINUE_AFTER_FAILURE_INSTRUCTION = "The previous reply failed before it finished. Continue from the work above — keep its conclusions and pick up exactly where it stopped. Do not repeat it and do not start over.";
const WORK_AGENT_TRUNCATION_CONTINUE_INSTRUCTION = "Your previous generation reached its output token limit while the task was still in progress. Continue the work from the current state and make the next concrete tool call. Do not call report_outcome until the task is implemented and verified, or you have a genuine blocker.";
function resolveFailedTurnContinueInstruction(history) {
  const last = history[history.length - 1];
  if (!last || last.role === "user") return void 0;
  return CONTINUE_AFTER_FAILURE_INSTRUCTION;
}
const MAX_PROSE_QUESTION_RETRIES = 1;
const PROSE_QUESTION_RETRY_INSTRUCTION = "Your previous reply is already in the chat. You presented multiple-choice options in plain text. Do not repeat that list in prose. Call the ask_question tool now with a questions array (each item: id, prompt, options as {id, label} objects). Wait for the user to answer before continuing.";
const MAX_INTENT_TO_ACT_RETRIES = 1;
const INTENT_TO_ACT_RETRY_INSTRUCTION = "Your previous reply is already in the chat. It announced a next action but did not call a tool. Do not repeat it. Call those tools now.";
const SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION = "You must use the available tools to complete the task. Do not answer with prose only \u2014 call the appropriate tool(s) now, then summarize after you have tool results.";
/**
 * @param {string} toolName
 * @returns {string}
 */
function buildReportToolNudgeInstruction(toolName) {
  const name = typeof toolName === "string" && toolName.trim() ? toolName.trim() : "report_outcome";
  return `You must call the ${name} tool now with a valid JSON payload (outcome, summary, and the other required fields). Do not put the outcome only in assistant text, and do not reply with a JSON object as your message. A rejected ${name} call is not finished — read the error, fix the payload, and call the tool again.`;
}
function isTurnDebugEnabled() {
  return false;
}
function logTurnDebug(payload) {
  if (!isTurnDebugEnabled()) return;
  console.debug("[minnow:turn]", payload);
}
function hasPostToolTail(history) {
  if (history.length === 0) return false;
  const last = history[history.length - 1];
  if (last?.role === "tool") return true;
  if (last?.role === "assistant") {
    const withTools = last;
    return Boolean(withTools.tool_calls?.length);
  }
  return false;
}
function resolveTurnContinuation(input) {
  const maxRetries = input.maxEmptyPostToolRetries ?? MAX_EMPTY_POST_TOOL_RETRIES;
  if (input.finishReason === "tool_calls" && input.toolCallsCount > 0) {
    return "continueTools";
  }
  if (input.fullTextLength === 0 && input.hasPostToolTail && input.emptyPostToolRetries < maxRetries) {
    return "retryEmpty";
  }
  return "finalize";
}
function resolveFinalAssistantContent(fullText, thinkingSegments) {
  const trimmed = fullText.trim();
  if (trimmed) {
    return { content: trimmed, usedThinkingAsContent: false };
  }
  const thinking = thinkingSegments.filter((s) => s.trim().length > 0);
  if (thinking.length > 0) {
    return { content: thinking.join("\n\n"), usedThinkingAsContent: true };
  }
  return {
    content: "The model returned no text.",
    usedThinkingAsContent: false
  };
}
function resolveFailedTurnPartialRow(input) {
  const thinking = input.thinking.filter((seg) => seg.trim().length > 0);
  const prose = stripXmlToolCallBlocks(input.partialText.trim()).trim();
  if (!prose && thinking.length === 0) return null;
  const { content } = resolveFinalAssistantContent(prose, thinking);
  const row = { role: "assistant", content, failed: true };
  if (thinking.length > 0) {
    row.thinking = thinking;
  }
  return row;
}
export {
  CONTINUE_AFTER_FAILURE_INSTRUCTION,
  CONTINUE_AFTER_TRUNCATION_INSTRUCTION,
  WORK_AGENT_TRUNCATION_CONTINUE_INSTRUCTION,
  EMPTY_POST_TOOL_CONTINUE_INSTRUCTION,
  MAX_EMPTY_POST_TOOL_RETRIES,
  MAX_PROSE_QUESTION_RETRIES,
  PROSE_QUESTION_RETRY_INSTRUCTION,
  MAX_INTENT_TO_ACT_RETRIES,
  INTENT_TO_ACT_RETRY_INSTRUCTION,
  SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION,
  buildReportToolNudgeInstruction,
  TURN_DEBUG_STORAGE_KEY,
  hasPostToolTail,
  isTurnDebugEnabled,
  logTurnDebug,
  resolveFailedTurnContinueInstruction,
  resolveFailedTurnPartialRow,
  resolveFinalAssistantContent,
  resolveTurnContinuation
};
