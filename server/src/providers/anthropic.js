import Anthropic from "@anthropic-ai/sdk";

import { SYSTEM_PROMPT } from "../systemPrompt.js";
import { TOOL_SCHEMAS } from "../toolSchemas.js";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

let client;
const getClient = () => {
  if (!client) {
    // Resolves ANTHROPIC_API_KEY (or an `ant auth login` profile) from the env.
    client = new Anthropic();
  }
  return client;
};

/**
 * Neutral history -> Anthropic `messages`.
 *
 * Assistant turns carry their original content blocks in `raw`; we replay those
 * verbatim so that thinking blocks (which Opus 5 emits and requires echoed back
 * during a tool loop) survive the round trip untouched.
 */
const toAnthropicMessages = (messages) =>
  messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
    }

    if (message.role === "assistant") {
      if (message.raw) {
        return { role: "assistant", content: message.raw };
      }
      return { role: "assistant", content: message.content || "" };
    }

    return { role: "user", content: message.content };
  });

export const runTurn = async (messages) => {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Positioning is arithmetic the model has to get right; medium effort keeps
    // the demo responsive without making it sloppy.
    output_config: { effort: "medium" },
    system: SYSTEM_PROMPT,
    tools: TOOL_SCHEMAS,
    messages: toAnthropicMessages(messages),
  });

  if (response.stop_reason === "refusal") {
    return {
      type: "final",
      message: {
        role: "assistant",
        content:
          "I can't help with that request. Try describing a diagram to draw instead.",
      },
    };
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const toolCalls = response.content
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }));

  const message = {
    role: "assistant",
    content: text,
    raw: response.content,
    ...(toolCalls.length ? { toolCalls } : {}),
  };

  return toolCalls.length
    ? { type: "tool_calls", message }
    : { type: "final", message };
};
