const TOOL_IMAGE_FOLLOW_UP_TEXT = "[tool image] Visual result of the preceding tool call. Inspect the image; do not fetch the file URL.";
const TOOL_IMAGE_NO_VISION_HINT = "\n\n(The image file was saved, but the current model cannot view images. Report metadata only; switch to a vision model to inspect the pixels.)";
function isToolImageFollowUpMessage(msg) {
  return msg.role === "user" && msg.toolImageFollowUp === true;
}
function toolImageFollowUpFromAttachments(attachments) {
  if (!attachments?.length) return null;
  const parts = [{ type: "text", text: TOOL_IMAGE_FOLLOW_UP_TEXT }];
  for (const att of attachments) {
    if (att.type !== "image" || typeof att.dataUrl !== "string") continue;
    if (!att.dataUrl.startsWith("data:image/")) continue;
    parts.push({
      type: "image_url",
      image_url: { url: att.dataUrl, detail: "auto" }
    });
  }
  if (parts.length < 2) return null;
  return { role: "user", content: parts, toolImageFollowUp: true };
}
function toolImageFollowUpUserMessage(message) {
  if (message.role !== "tool") return null;
  return toolImageFollowUpFromAttachments(message.attachments);
}
function toolMessageHasImageAttachment(message) {
  if (message.role !== "tool" || !message.attachments?.length) return false;
  return message.attachments.some((att) => att.type === "image");
}
/**
 * Screenshots kept as pixels in an outbound transcript. An agent that shoots a
 * frame per turn otherwise re-sends every prior screenshot forever: each one is
 * thousands of vision tokens, so the prompt grows by megapixels a turn and the
 * window fills with views the model has already acted on.
 */
const MAX_LIVE_TOOL_IMAGES = 2;
const TOOL_IMAGE_SUPERSEDED_TEXT = "[tool screenshot dropped to save context \u2014 a newer screenshot supersedes it. Call the screenshot tool again to take a fresh look.]";
function toolImageFollowUpImageCount(msg) {
  if (!Array.isArray(msg?.content)) return 0;
  let count = 0;
  for (const part of msg.content) {
    if (part.type === "image_url") count += 1;
  }
  return count;
}
/**
 * Replace the pixels of all but the `keep` most recent screenshot follow-ups
 * with a short note. The rows themselves stay put: they are grouped with the
 * tool call that produced them, so dropping the message would strip a tool
 * result out of its turn.
 */
function pruneSupersededToolImages(messages, keep = MAX_LIVE_TOOL_IMAGES) {
  const limit = Math.max(0, Math.floor(keep));
  const withImages = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (isToolImageFollowUpMessage(messages[i]) && toolImageFollowUpImageCount(messages[i]) > 0) {
      withImages.push(i);
    }
  }
  if (withImages.length <= limit) return { messages, droppedMessages: 0, droppedImages: 0 };
  const superseded = new Set(withImages.slice(0, withImages.length - limit));
  let droppedImages = 0;
  const next = messages.map((msg, i) => {
    if (!superseded.has(i)) return msg;
    droppedImages += toolImageFollowUpImageCount(msg);
    return { ...msg, content: TOOL_IMAGE_SUPERSEDED_TEXT };
  });
  return { messages: next, droppedMessages: superseded.size, droppedImages };
}
const USER_IMAGE_NO_VISION_HINT = "\n\n(The user attached the image(s) named above, but the current model cannot accept image input, so the pixels were not sent. There is no tool that can read them \u2014 say you cannot see the image and suggest switching to a vision model.)";
export {
  MAX_LIVE_TOOL_IMAGES,
  TOOL_IMAGE_SUPERSEDED_TEXT,
  pruneSupersededToolImages,
  toolImageFollowUpImageCount,
  TOOL_IMAGE_FOLLOW_UP_TEXT,
  TOOL_IMAGE_NO_VISION_HINT,
  USER_IMAGE_NO_VISION_HINT,
  isToolImageFollowUpMessage,
  toolImageFollowUpFromAttachments,
  toolImageFollowUpUserMessage,
  toolMessageHasImageAttachment
};
