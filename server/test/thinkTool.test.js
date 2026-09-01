/**
 * Unit tests for the think tool's shape and its place in the voice session.
 * No network, no model — this covers the contract the realtime API is handed
 * and the instructions that decide when the agent reaches for it.
 *
 * Run with: npm test (node --test).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { THINK_TOOL, thinkDeployment } from "../src/thinkTool.js";
import { TOOL_SCHEMAS } from "../src/toolSchemas.js";
import { toRealtimeTools, VOICE_SYSTEM_PROMPT } from "../src/voicePrompt.js";

describe("THINK_TOOL", () => {
  it("uses the flat realtime tool shape, not the nested chat one", () => {
    assert.equal(THINK_TOOL.type, "function");
    assert.equal(THINK_TOOL.name, "think");
    assert.ok(THINK_TOOL.parameters, "parameters must sit at the top level");
    assert.equal(
      THINK_TOOL.function,
      undefined,
      "realtime tools are flat — a nested `function` key would be ignored",
    );
  });

  it("requires a self-contained question", () => {
    assert.deepEqual(THINK_TOOL.parameters.required, ["question"]);
    assert.equal(THINK_TOOL.parameters.properties.question.type, "string");
    // The answering model sees neither the conversation nor the canvas.
    assert.match(
      THINK_TOOL.parameters.properties.question.description,
      /stands on its own|cannot see/i,
    );
  });

  it("tells the agent to speak first and to call it alone", () => {
    // Both matter: the spoken cue explains the pause, and calling it alone
    // keeps the server's continuation from racing the browser's.
    assert.match(THINK_TOOL.description, /say a short phrase out loud first/i);
    assert.match(THINK_TOOL.description, /ALONE/);
  });

  it("steers away from using it for ordinary drawing", () => {
    assert.match(THINK_TOOL.description, /do NOT use it for ordinary drawing/i);
  });

  it("never silently falls back to the chat deployment", () => {
    // Falling back to the model already in the loop would defeat the point of
    // the tool, which exists to reach for something stronger. Only an explicit
    // AZURE_OPENAI_THINK_DEPLOYMENT overrides the reasoning default.
    assert.equal(
      thinkDeployment(),
      process.env.AZURE_OPENAI_THINK_DEPLOYMENT || "gpt-5.6-sol",
    );
  });
});

describe("voice session tool list", () => {
  const canvasTools = toRealtimeTools(
    TOOL_SCHEMAS.filter((tool) => tool.name !== "teach_diagram"),
  );

  it("converts canvas tools to the flat realtime shape", () => {
    assert.ok(canvasTools.length > 0);
    for (const tool of canvasTools) {
      assert.equal(tool.type, "function");
      assert.ok(tool.name && tool.parameters);
      assert.equal(tool.function, undefined);
    }
  });

  it("withholds the tutor, which speaks through its own pipeline", () => {
    assert.ok(
      !canvasTools.some((tool) => tool.name === "teach_diagram"),
      "two voices at once helps nobody",
    );
  });

  it("does not collide with an existing canvas tool name", () => {
    assert.ok(!canvasTools.some((tool) => tool.name === THINK_TOOL.name));
  });
});

describe("VOICE_SYSTEM_PROMPT", () => {
  it("documents when to think and when not to", () => {
    assert.match(VOICE_SYSTEM_PROMPT, /Thinking things through/);
    assert.match(VOICE_SYSTEM_PROMPT, /Do NOT reach for it for ordinary work/i);
  });

  it("still carries the drawing rules the typed agent uses", () => {
    // The two agents share tooling, so they must share positioning rules.
    assert.match(VOICE_SYSTEM_PROMPT, /next to/i);
    assert.match(VOICE_SYSTEM_PROMPT, /bind_arrow/);
  });
});
