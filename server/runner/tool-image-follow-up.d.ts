/**
 * Attach screenshot pixels to the outbound API after a tool result.
 *
 * OpenAI-compatible tool messages are string-only, so VLMs never see
 * `/api/browser/screenshot/:id`. A follow-up user message with `image_url`
 * data URLs is the portable way to feed the PNG to the model.
 */
import type { ApiMessage, ApiUserMessage, Message, ToolImageAttachment } from '../../src/types.js';
/** Text part so the model treats the image as the preceding tool's visual result. */
export declare const TOOL_IMAGE_FOLLOW_UP_TEXT: string;
/** Shown on the wire when a screenshot exists but the model is not a VLM. */
export declare const TOOL_IMAGE_NO_VISION_HINT: string;
/** True when this API user row is an ephemeral screenshot follow-up (not chat history). */
export declare function isToolImageFollowUpMessage(msg: ApiMessage): boolean;
/** Build a multimodal user follow-up from tool screenshot attachments (data URLs only). */
export declare function toolImageFollowUpFromAttachments(attachments: ToolImageAttachment[] | undefined): ApiUserMessage | null;
/** Follow-up for a persisted tool history row, or null when there are no pixels. */
export declare function toolImageFollowUpUserMessage(message: Message): ApiUserMessage | null;
/** True when a tool row stored at least one screenshot attachment. */
export declare function toolMessageHasImageAttachment(message: Message): boolean;
/**
 * Screenshots kept as pixels in an outbound transcript. An agent that shoots a
 * frame per turn otherwise re-sends every prior screenshot forever: each one is
 * thousands of vision tokens, so the prompt grows by megapixels a turn.
 */
export declare const MAX_LIVE_TOOL_IMAGES = 2;
/** Replaces the pixels of a screenshot a newer one has superseded. */
export declare const TOOL_IMAGE_SUPERSEDED_TEXT: string;
/** Number of `image_url` parts carried by a screenshot follow-up row. */
export declare function toolImageFollowUpImageCount(msg: ApiMessage): number;
/**
 * Replace the pixels of all but the `keep` most recent screenshot follow-ups
 * with a short note. The rows themselves stay put: they are grouped with the
 * tool call that produced them, so dropping the message would strip a tool
 * result out of its turn.
 */
export declare function pruneSupersededToolImages(messages: ApiMessage[], keep?: number): {
    messages: ApiMessage[];
    droppedMessages: number;
    droppedImages: number;
};
/**
 * Appended to a user message whose attached images could not be sent as pixels.
 * Without it the model sees only `[image: name]` and reports a missing tool.
 */
export declare const USER_IMAGE_NO_VISION_HINT = "\n\n(The user attached the image(s) named above, but the current model cannot accept image input, so the pixels were not sent. There is no tool that can read them \u2014 say you cannot see the image and suggest switching to a vision model.)";
