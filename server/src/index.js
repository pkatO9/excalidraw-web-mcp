import cors from "cors";
import "dotenv/config";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

import { attachRealtime } from "./realtime.js";
import { resolveTools } from "./toolSchemas.js";
import { formatReferences, formatSceneContext } from "./systemPrompt.js";
import { runTutorLesson } from "./tutor.js";
import { lessonRequestSchema } from "./tutorSchema.js";

/**
 * Chat-to-tool-call backend for the Excalidraw AI diagramming agent.
 *
 * ── Why the agent loop is driven from the browser ──────────────────────────
 * The tool layer has to run in the frontend, because `excalidrawAPI` is an
 * in-memory handle on the mounted editor — there is no way to reach the live
 * scene from a separate Node process. That leaves the question of how the
 * backend tells the frontend "run this tool call" and gets the answer back.
 *
 * The options were: (a) a socket / SSE channel, (b) the frontend polling a
 * queue endpoint, or (c) making each HTTP request one *step* of the loop, with
 * the browser driving the iteration.
 *
 * We picked (c). Each POST /api/chat is a single model turn: the server either
 * answers with the final text, or with the tool calls it wants run. The browser
 * executes them against excalidrawAPI, appends the results, and posts again.
 * That means no sockets, no polling, no server-side session state — the server
 * is a pure function of the history it is handed, so it restarts cleanly and
 * scales trivially on Azure App Service. The API key never leaves the server.
 *
 * The cost is one HTTP round trip per model turn, which is irrelevant next to
 * model latency.
 */

const app = express();
app.use(helmet());
app.use(cors(process.env.FRONTEND_ORIGIN ? { origin: process.env.FRONTEND_ORIGIN } : undefined));
app.use(express.json({ limit: "5mb" }));

/**
 * Generating a lesson is a model turn, and the route carries no auth, so a
 * per-IP budget is the only thing standing between an open CORS policy and an
 * unbounded provider bill. (Narration itself is free — the browser speaks it.)
 */
const tutorLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many tutor requests. Wait a moment and try again." },
});
app.use("/api/tutor", tutorLimiter);

/** Client-facing 500 text. Provider errors name endpoints, deployments and
 * quota state, so the detail stays in the server log. */
const GENERIC_FAILURE = "The request failed. Check the server logs.";

const PROVIDERS = {
  anthropic: () => import("./providers/anthropic.js"),
  azure: () => import("./providers/azureOpenAI.js"),
};

const DEFAULT_PROVIDER = process.env.LLM_PROVIDER || "azure";

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    defaultProvider: DEFAULT_PROVIDER,
    providers: {
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      azure: Boolean(
        process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY,
      ),
    },
  });
});

/**
 * The tutor's lesson: scene in, structured walkthrough out.
 * Body: { scene: [...get_scene output], provider?: "anthropic" | "azure" }
 * Response: { lesson: { intro, segments: [{elementIds, narration}], closing } }
 */
app.post("/api/tutor/lesson", async (req, res) => {
  try {
    const parsed = lessonRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error:
          "`scene` must be a non-empty array of elements — an empty canvas has nothing to teach.",
      });
    }

    const key = parsed.data.provider || DEFAULT_PROVIDER;
    const load = PROVIDERS[key];
    if (!load) {
      return res.status(400).json({ error: `Unknown provider "${key}".` });
    }

    const lesson = await runTutorLesson(parsed.data.scene, load);
    return res.json({ lesson });
  } catch (error) {
    console.error("[/api/tutor/lesson]", error);
    return res.status(500).json({ error: GENERIC_FAILURE });
  }
});

/**
 * One step of the agent loop.
 *
 * Request body:
 *   {
 *     provider?: "anthropic" | "azure",
 *     scene?:    [...],   // get_scene output, injected on the first turn
 *     messages:  [...]    // full neutral-format history
 *   }
 *
 * Response body:
 *   { type: "tool_calls", message: { role, content, toolCalls, raw? } }
 *   { type: "final",      message: { role, content } }
 */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, provider, scene, references, tools } = req.body ?? {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "`messages` must be a non-empty array." });
    }

    const key = provider || DEFAULT_PROVIDER;
    const load = PROVIDERS[key];
    if (!load) {
      return res.status(400).json({
        error: `Unknown provider "${key}". Use "anthropic" or "azure".`,
      });
    }

    // The scene is injected as context on the latest user turn, so the model is
    // given the real canvas every single turn rather than relying on a stale
    // get_scene from earlier in the conversation.
    const prepared = [...messages];
    if (scene !== undefined || references !== undefined) {
      const lastUserIndex = prepared.map((m) => m.role).lastIndexOf("user");
      if (lastUserIndex !== -1) {
        const original = prepared[lastUserIndex];
        const blocks = [];
        if (scene !== undefined) {
          blocks.push(formatSceneContext(scene));
        }
        const referenceBlock = formatReferences(references);
        if (referenceBlock) {
          blocks.push(referenceBlock);
        }
        blocks.push(original.content);
        prepared[lastUserIndex] = {
          ...original,
          content: blocks.join("\n\n---\n\n"),
        };
      }
    }

    const { runTurn } = await load();
    // The browser is the WebMCP tool provider, so it sends what the canvas can
    // do. Falling back to the bundled list only covers a client too old to say.
    const result = await runTurn(prepared, { tools: resolveTools(tools) });
    return res.json(result);
  } catch (error) {
    console.error("[/api/chat]", error);
    return res.status(500).json({
      error: error?.message || "The model request failed.",
    });
  }
});

const PORT = process.env.PORT || 8787;
const server = app.listen(PORT, () => {
  console.log(
    `[excalidraw-web-mcp] listening on :${PORT} (default provider: ${DEFAULT_PROVIDER})`,
  );
});

// The live voice agent shares this HTTP server, upgrading to a WebSocket on
// /api/realtime. Same process, same credentials, no extra port to configure.
attachRealtime(server);
