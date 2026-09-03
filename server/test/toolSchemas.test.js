/**
 * Guards against the tool list and the prose that describes it drifting apart.
 *
 * This is not hypothetical. `add_rectangle` was renamed to `add_shape` in the
 * system prompt and in this fallback schema, but not in the browser's
 * descriptors — which are the copy actually sent to the model, because
 * `resolveTools` prefers the client's list. The result was a prompt instructing
 * the model to call a tool that was not in its manifest, and a `shape`
 * parameter that no longer reached it. Nothing failed loudly; the diamonds just
 * silently stopped being reachable.
 *
 * The rule these tests encode: any tool name written down anywhere on the
 * server must be a tool the server actually declares.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { TOOL_SCHEMAS, resolveTools, toOpenAITools } from "../src/toolSchemas.js";
import { SYSTEM_PROMPT } from "../src/systemPrompt.js";
import {
  VOICE_EXCLUDED_TOOLS,
  VOICE_SYSTEM_PROMPT,
} from "../src/voicePrompt.js";

const DECLARED = new Set(TOOL_SCHEMAS.map((tool) => tool.name));

test("every tool the system prompt names is a tool we declare", () => {
  // Tool names are snake_case verbs; this catches them wherever they appear in
  // the prose without needing the prompt to list them in a fixed place.
  const mentioned = new Set(SYSTEM_PROMPT.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);

  // Words that look like tool names but aren't — schema fields and prose.
  const notTools = new Set([
    "input_schema",
    "element_ids",
    "source_id",
    "target_id",
    "already_removed",
    "removed_ids",
    "background_color",
    "stroke_color",
    "fill_style",
  ]);

  const undeclared = [...mentioned].filter(
    (word) => !DECLARED.has(word) && !notTools.has(word),
  );

  assert.deepEqual(
    undeclared,
    [],
    `system prompt names tool(s) that are not declared: ${undeclared.join(", ")}`,
  );
});

test("every declared tool is actually mentioned in the system prompt", () => {
  // The reverse drift: a tool ships but the prompt never tells the model when
  // to reach for it, so it goes unused.
  //
  // get_scene is injected by the client every turn rather than described.
  //
  // remove_element is a real gap, exempted deliberately rather than closed.
  // Deletion works today on the strength of the tool's own description, which
  // is detailed, and adding a paragraph here was tried and abandoned: the
  // live-model e2e appeared to regress, but that test turns out to pass only
  // about two runs in three with the prompt untouched, so the signal was not
  // trustworthy either way. Closing this gap needs a way to tell a real
  // regression from that noise, which is a bigger job than the gap deserves.
  const exempt = new Set(["get_scene", "remove_element"]);

  const unmentioned = TOOL_SCHEMAS.map((t) => t.name).filter(
    (name) => !exempt.has(name) && !SYSTEM_PROMPT.includes(name),
  );

  assert.deepEqual(
    unmentioned,
    [],
    `declared but never mentioned in the prompt: ${unmentioned.join(", ")}`,
  );
});

test("every declared tool has a usable schema", () => {
  for (const tool of TOOL_SCHEMAS) {
    assert.ok(tool.name, "tool is missing a name");
    assert.ok(
      tool.description && tool.description.length > 20,
      `${tool.name} needs a description the model can act on`,
    );
    assert.equal(
      tool.input_schema?.type,
      "object",
      `${tool.name} input_schema must be an object schema`,
    );
  }
});

test("add_shape exposes the shape parameter that makes it more than a rectangle", () => {
  const addShape = TOOL_SCHEMAS.find((tool) => tool.name === "add_shape");

  assert.ok(addShape, "add_shape must be declared");
  assert.deepEqual(addShape.input_schema.properties.shape.enum, [
    "rectangle",
    "diamond",
    "ellipse",
  ]);
});

test("the voice prompt disclaims every tool the voice session withholds", () => {
  // The voice session drops teach_diagram from its tool list, but it inherits
  // the base prompt, which instructs the model to call teach_diagram when asked
  // to explain the diagram — and explicitly forbids explaining it directly. The
  // observed result was the agent saying "sure, let me walk you through it" and
  // then going quiet, because both routes were closed to it.
  for (const name of VOICE_EXCLUDED_TOOLS) {
    assert.ok(
      SYSTEM_PROMPT.includes(name),
      `${name} is excluded from the voice session but the base prompt never mentions it — nothing to override`,
    );
    assert.ok(
      VOICE_SYSTEM_PROMPT.includes(`do NOT have the \`${name}\``),
      `voice prompt must tell the model it does not have ${name} here, and what to do instead`,
    );
  }
});

test("the voice prompt tells the agent to explain the diagram itself", () => {
  assert.match(VOICE_SYSTEM_PROMPT, /Never announce a walkthrough you then do not give/);
});

test("resolveTools prefers the browser's list, since the browser is the provider", () => {
  const fromClient = [
    { name: "only_this", description: "x", input_schema: { type: "object" } },
  ];

  assert.deepEqual(resolveTools(fromClient), fromClient);
});

test("resolveTools falls back to the bundled copy for a client that sends none", () => {
  assert.equal(resolveTools([]), TOOL_SCHEMAS);
  assert.equal(resolveTools(undefined), TOOL_SCHEMAS);
});

test("resolveTools drops malformed entries rather than passing them to the model", () => {
  const resolved = resolveTools([
    { name: "good", description: "x", input_schema: { type: "object" } },
    { name: "no_schema", description: "x" },
    { description: "nameless", input_schema: { type: "object" } },
    null,
  ]);

  assert.deepEqual(
    resolved.map((tool) => tool.name),
    ["good"],
  );
});

test("toOpenAITools rewraps every tool without losing any", () => {
  const wrapped = toOpenAITools();

  assert.equal(wrapped.length, TOOL_SCHEMAS.length);
  assert.deepEqual(
    wrapped.map((tool) => tool.function.name),
    TOOL_SCHEMAS.map((tool) => tool.name),
  );
  assert.ok(wrapped.every((tool) => tool.type === "function"));
});
