import cors from "cors";
import "dotenv/config";
import express from "express";

import { formatReferences, formatSceneContext } from "./systemPrompt.js";

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
app.use(cors());
app.use(express.json({ limit: "5mb" }));

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
    const { messages, provider, scene, references } = req.body ?? {};

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
    const result = await runTurn(prepared);
    return res.json(result);
  } catch (error) {
    console.error("[/api/chat]", error);
    return res.status(500).json({
      error: error?.message || "The model request failed.",
    });
  }
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(
    `[excalidraw-web-mcp] listening on :${PORT} (default provider: ${DEFAULT_PROVIDER})`,
  );
});
