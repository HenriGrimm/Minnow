import type { AssistantMessage, Message } from '../../src/types.js';
export declare const TURN_DEBUG_STORAGE_KEY = "minnowDebugTurns";
export declare const MAX_EMPTY_POST_TOOL_RETRIES = 1;
export declare const EMPTY_POST_TOOL_CONTINUE_INSTRUCTION = "You have tool results above. Reply to the user in plain language; do not call more tools unless necessary.";
export declare const CONTINUE_AFTER_TRUNCATION_INSTRUCTION = "Your previous reply was cut off because of the output token limit. Continue exactly where you left off without repeating what you already wrote.";
export declare const CONTINUE_AFTER_FAILURE_INSTRUCTION = "The previous reply failed before it finished. Continue from the work above — keep its conclusions and pick up exactly where it stopped. Do not repeat it and do not start over.";
export declare const WORK_AGENT_TRUNCATION_CONTINUE_INSTRUCTION: string;
export declare function resolveFailedTurnContinueInstruction(history: Message[]): string | undefined;
export declare const MAX_PROSE_QUESTION_RETRIES = 1;
export declare const PROSE_QUESTION_RETRY_INSTRUCTION = "Your previous reply is already in the chat. You presented multiple-choice options in plain text. Do not repeat that list in prose. Call the ask_question tool now with a questions array (each item: id, prompt, options as {id, label} objects). Wait for the user to answer before continuing.";
export declare const MAX_INTENT_TO_ACT_RETRIES = 1;
export declare const INTENT_TO_ACT_RETRY_INSTRUCTION = "Your previous reply is already in the chat. It announced a next action but did not call a tool. Do not repeat it. Call those tools now.";
export declare const SUB_AGENT_TOOL_USE_NUDGE_INSTRUCTION = "You must use the available tools to complete the task. Do not answer with prose only \u2014 call the appropriate tool(s) now, then summarize after you have tool results.";
export declare function buildReportToolNudgeInstruction(toolName: string): string;
export type TurnContinuation = 'continueTools' | 'finalize' | 'retryEmpty';
export declare function isTurnDebugEnabled(): boolean;
export declare function logTurnDebug(payload: Record<string, unknown>): void;
export declare function hasPostToolTail(history: Message[]): boolean;
export declare function resolveTurnContinuation(input: {
    finishReason: string | undefined;
    toolCallsCount: number;
    fullTextLength: number;
    hasPostToolTail: boolean;
    emptyPostToolRetries: number;
    maxEmptyPostToolRetries?: number;
}): TurnContinuation;
export declare function resolveFinalAssistantContent(fullText: string, thinkingSegments: string[]): {
    content: string;
    usedThinkingAsContent: boolean;
};
export interface FailedTurnPartialInput {
    partialText: string;
    thinking: string[];
}
export declare function resolveFailedTurnPartialRow(input: FailedTurnPartialInput): AssistantMessage | null;
