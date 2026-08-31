import { AzureOpenAI } from "openai";

/**
 * The voice agent's escape hatch to a stronger model.
 *
 * `gpt-realtime-2` is tuned for low-latency conversation, and on the things
 * measured here — multi-step tool sequencing and positional arithmetic — it
 * matched the typed agent. Where a realtime model is generally weaker is
 * sustained reasoning: a large one-shot build, a genuine design critique, a
 * tradeoff with no obvious answer. Rather than move the whole voice session to
 * a slower model to cover the minority of turns that need it, the agent can
 * hand just those turns to the chat deployment and keep talking at full speed
 * the rest of the time.
 *
 * The result comes back as TEXT advice, not actions. The realtime agent stays
 * the only thing that issues drawing tool calls, so canvas mutation keeps
 * running through the browser exactly as before.
 */

const DEPLOYMENT =
  process.env.AZURE_OPENAI_THINK_DEPLOYMENT ||
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  "gpt-4.1";
const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";
const THINK_TIMEOUT_MS = 30000;

let client;
const getClient = () => {
  if (!client) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!endpoint || !apiKey) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY must be set to use the think tool.",
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

/** Realtime tool definition. Flat shape, like the rest of the realtime tools. */
export const THINK_TOOL = {
  type: "function",
  name: "think",
  description:
    "Hand a genuinely hard question to a slower, stronger model and get an answer back. Use it ONLY when a request needs real reasoning that you cannot do well on the fly: designing a large system from scratch, critiquing or reviewing a diagram on its merits, weighing an architectural tradeoff, or untangling a vague requirement. Do NOT use it for ordinary drawing work — placing boxes, computing positions, connecting elements and picking colours are all things you already do well, and calling this for them just makes the user wait. Two rules when you do call it: say a short phrase out loud first, such as 'let me think this through for a second', so the user knows why there is a pause; and call it ALONE, as the only tool call in that turn, then act on the answer afterwards.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The question to think about, written so it stands on its own. Include the relevant context — what the user asked for, and what is already on the canvas if it matters — because the model answering this cannot see the conversation or the diagram.",
      },
    },
    required: ["question"],
  },
};

const THINK_SYSTEM_PROMPT = `You advise a live voice agent that draws architecture diagrams on a shared canvas. It has handed you a question it could not answer well while talking in real time.

Give it something it can act on immediately:
- Commit to a reasonable interpretation. Never ask a clarifying question back — the agent cannot relay one to you.
- Answer the substance: which components are needed, how they connect, what the tradeoff actually is, what is wrong with the design. That is the part the agent cannot work out on its own.
- Do NOT specify coordinates, pixel positions or layout. The agent handles placement itself and its tooling prevents overlap.
- Be compact. A short paragraph, or a handful of terse bullets. The agent has to speak this aloud in a sentence or two, so give it substance to compress, not prose to wade through.
- If the question is a review, name concrete problems and what to do about each. No generic advice.`;

/** Question -> considered answer, as plain text. */
export const runThink = async (question) => {
  const response = await getClient().chat.completions.create(
    {
      model: DEPLOYMENT,
      max_tokens: 700,
      temperature: 0.2,
      messages: [
        { role: "system", content: THINK_SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
    },
    { timeout: THINK_TIMEOUT_MS },
  );

  return (
    response.choices[0]?.message?.content?.trim() ||
    "No useful answer came back — use your own judgement."
  );
};

export const thinkDeployment = () => DEPLOYMENT;
