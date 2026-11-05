const MISSING_TOOL_RESULT_CONTENT = "Tool call did not complete; no result was recorded.";
function assistantToolCalls(message) {
  if (message.role !== "assistant") return void 0;
  const calls = message.tool_calls;
  return calls?.length ? calls : void 0;
}
function repairUnpairedToolCalls(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "tool") {
      continue;
    }
    const toolCalls = assistantToolCalls(message);
    if (!toolCalls) {
      out.push(message);
      continue;
    }
    out.push(message);
    const requestedIds = new Set(toolCalls.map(call => call.id));
    const answered = /* @__PURE__ */ new Set();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const row = messages[j];
      if (requestedIds.has(row.tool_call_id) && !answered.has(row.tool_call_id)) {
        out.push(row);
        answered.add(row.tool_call_id);
      }
      j += 1;
    }
    for (const call of toolCalls) {
      if (!answered.has(call.id)) {
        out.push({
          role: "tool",
          tool_call_id: call.id,
          content: MISSING_TOOL_RESULT_CONTENT
        });
      }
    }
    i = j - 1;
  }
  return out;
}
function plainTextContent(message) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text").map((part) => "text" in part ? part.text : "").join("");
}
function systemContent(message) {
  if (message.role !== "system") return "";
  return plainTextContent(message);
}
function assistantPlainText(message) {
  if (message.role !== "assistant") return "";
  return plainTextContent(message);
}
function foldLeadingAssistantPreamble(messages) {
  if (messages.length < 2) return messages;
  let index = 0;
  const systemChunks = [];
  while (index < messages.length && messages[index].role === "system") {
    const chunk = systemContent(messages[index]).trim();
    if (chunk) systemChunks.push(chunk);
    index += 1;
  }
  const preamble = [];
  while (index < messages.length && messages[index].role === "assistant" && !assistantToolCalls(messages[index])) {
    const text = assistantPlainText(messages[index]).trim();
    if (text) preamble.push(text);
    index += 1;
  }
  if (preamble.length === 0) return messages;
  const foldedSystem = [
    ...systemChunks,
    [
      "[The specialist already greeted the user in the UI. Continue naturally; do not repeat the greeting verbatim unless helpful.]",
      ...preamble
    ].join("\n\n")
  ].filter(Boolean).join("\n\n");
  const out = [];
  if (foldedSystem.trim()) {
    out.push({ role: "system", content: foldedSystem });
  }
  out.push(...messages.slice(index));
  return out;
}
export {
  MISSING_TOOL_RESULT_CONTENT,
  foldLeadingAssistantPreamble,
  repairUnpairedToolCalls
};
