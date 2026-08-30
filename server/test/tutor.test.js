/**
 * Unit tests for the tutor's pure logic: request/output validation and lesson
 * sanitation. No network, no model — the model's output is treated as untrusted
 * input and everything here must hold no matter what it returns.
 *
 * Run with: npm test (node --test).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  lessonRequestSchema,
  walkthroughSchema,
} from "../src/tutorSchema.js";
import { runTutorLesson, sanitizeLesson } from "../src/tutor.js";

const scene = [
  { id: "lb", type: "rectangle", x: 0, y: 0, width: 180, height: 80 },
  { id: "db", type: "rectangle", x: 0, y: 200, width: 180, height: 80 },
];

/** Fake provider module: returns whatever turn result the test supplies. */
const providerReturning = (result) => async () => ({
  runTurn: async () => result,
});

const lesson = (overrides = {}) => ({
  intro: "Let's walk through this diagram.",
  segments: [
    { elementIds: ["lb"], narration: "This is the load balancer." },
    { elementIds: ["db"], narration: "Requests end up in the database." },
  ],
  closing: "That's the whole flow.",
  ...overrides,
});

describe("lessonRequestSchema", () => {
  it("accepts a scene of element summaries", () => {
    const parsed = lessonRequestSchema.parse({ scene });
    assert.equal(parsed.scene.length, 2);
  });

  it("rejects an empty scene — nothing to teach", () => {
    assert.throws(() => lessonRequestSchema.parse({ scene: [] }));
  });

  it("rejects an unknown provider", () => {
    assert.throws(() =>
      lessonRequestSchema.parse({ scene, provider: "gemini" }),
    );
  });
});

describe("walkthroughSchema", () => {
  it("accepts a well-formed walkthrough", () => {
    assert.deepEqual(walkthroughSchema.parse(lesson()), lesson());
  });

  it("rejects a walkthrough with no segments", () => {
    assert.throws(() => walkthroughSchema.parse(lesson({ segments: [] })));
  });

  it("rejects a segment with empty narration", () => {
    assert.throws(() =>
      walkthroughSchema.parse(
        lesson({ segments: [{ elementIds: ["lb"], narration: "" }] }),
      ),
    );
  });
});

describe("runTutorLesson", () => {
  it("returns the sanitized lesson from the model's forced tool call", async () => {
    const result = await runTutorLesson(
      scene,
      providerReturning({
        type: "tool_calls",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "1",
              name: "present_walkthrough",
              // Includes an invented id, to prove sanitation runs on the way out.
              input: lesson({
                segments: [
                  { elementIds: ["lb", "ghost"], narration: "The entry point." },
                ],
              }),
            },
          ],
        },
      }),
    );

    assert.deepEqual(result.segments[0].elementIds, ["lb"]);
  });

  it("throws when the model answers with prose instead of the tool call", async () => {
    await assert.rejects(
      runTutorLesson(
        scene,
        providerReturning({
          type: "final",
          message: { role: "assistant", content: "Nice diagram!" },
        }),
      ),
      /did not produce a walkthrough/i,
    );
  });
});

describe("sanitizeLesson", () => {
  it("passes a lesson whose ids all exist in the scene", () => {
    assert.deepEqual(sanitizeLesson(lesson(), scene), lesson());
  });

  it("drops ids the model invented, keeping the segment if any id survives", () => {
    const dirty = lesson({
      segments: [
        { elementIds: ["lb", "ghost"], narration: "The load balancer." },
      ],
    });
    const clean = sanitizeLesson(dirty, scene);
    assert.deepEqual(clean.segments[0].elementIds, ["lb"]);
  });

  it("drops segments whose ids are all invented", () => {
    const dirty = lesson({
      segments: [
        { elementIds: ["ghost"], narration: "A box that does not exist." },
        { elementIds: ["db"], narration: "The database." },
      ],
    });
    const clean = sanitizeLesson(dirty, scene);
    assert.equal(clean.segments.length, 1);
    assert.deepEqual(clean.segments[0].elementIds, ["db"]);
  });

  it("throws when nothing survives — the model hallucinated the whole scene", () => {
    const dirty = lesson({
      segments: [{ elementIds: ["ghost"], narration: "Nope." }],
    });
    assert.throws(() => sanitizeLesson(dirty, scene), /referenced no known/i);
  });

  it("does not mutate its input", () => {
    const dirty = lesson({
      segments: [{ elementIds: ["lb", "ghost"], narration: "Mixed." }],
    });
    const snapshot = structuredClone(dirty);
    sanitizeLesson(dirty, scene);
    assert.deepEqual(dirty, snapshot);
  });
});
