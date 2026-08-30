import { AzureOpenAI } from "openai";

import { SYSTEM_PROMPT } from "../systemPrompt.js";
import { toOpenAITools } from "../toolSchemas.js";

const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4.1";
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

let client;
const getClient = () => {
  if (!client) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!endpoint || !apiKey) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY must be set to use the azure provider.",
      );
    }
    client = new AzureOpenAI({
      endpoint,
      apiKey,
      apiVersion: API_VERSION,
      deployment: DEPLOYMENT,
    });
  }
  return client;
};

/** Neutral history -> OpenAI chat messages. */
const toOpenAIMessages = (messages, systemPrompt) => {
  const out = [{ role: "system", content: systemPrompt }];

  for (const message of messages) {
    if (message.role === "tool") {
      // OpenAI wants one `tool` message per tool call, not a batched one.
      for (const result of message.results) {
        out.push({
          role: "tool",
          tool_call_id: result.id,
          content: result.content,
        });
      }
      continue;
    }

    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input ?? {}),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    out.push({ role: "user", content: message.content });
  }

  return out;
};

/**
 * One model turn. `options` lets a caller swap the persona and toolset — the
 * tutor runs on the same providers with its own prompt and one forced tool —
 * while the defaults keep the drawing agent's behaviour byte-for-byte.
 */
export const runTurn = async (messages, options = {}) => {
  const { systemPrompt = SYSTEM_PROMPT, tools, forceTool, timeout } = options;

  const response = await getClient().chat.completions.create(
    {
      model: DEPLOYMENT,
      max_tokens: 4096,
      // Layout is rule-following, not creative writing. Deterministic sampling
      // makes the model actually honour the positioning rules instead of
      // occasionally improvising a different arrangement.
      temperature: 0,
      messages: toOpenAIMessages(messages, systemPrompt),
      tools: toOpenAITools(tools),
      tool_choice: forceTool
        ? { type: "function", function: { name: forceTool } }
        : "auto",
    },
    ...(timeout ? [{ timeout }] : []),
  );

  const choice = response.choices[0]?.message;
  const text = (choice?.content || "").trim();

  const toolCalls = (choice?.tool_calls || []).map((call) => ({
    id: call.id,
    name: call.function.name,
    // Arguments arrive as a JSON string; parse rather than string-match.
    input: call.function.arguments ? JSON.parse(call.function.arguments) : {},
  }));

  const message = {
    role: "assistant",
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
  };

  return toolCalls.length
    ? { type: "tool_calls", message }
    : { type: "final", message };
};
