# Excalidraw AI Diagramming Agent (WebMCP-style MVP)

A forked [Excalidraw](https://github.com/excalidraw/excalidraw) with a chat sidebar.
You type *"draw a 3-tier architecture with a load balancer, two app servers, and a
database"* and the shapes appear on the live canvas — correctly positioned and
connected with natively-bound arrows.

The point of this approach over a browser-clicking agent is **exact, non-guessed
positioning**: the model is handed the real scene JSON every turn and told to derive
coordinates arithmetically from the elements that already exist.

```
┌─────────────────────────────┐        ┌──────────────────────┐
│ Browser (forked Excalidraw) │        │ Node backend (:8787) │
│                             │        │                      │
│  ChatSidebar ──────────────────POST /api/chat──────────────► │
│       │                     │        │   ├─ Azure OpenAI    │
│       │  ◄──── tool_calls ──────────────┤   └─ Anthropic     │
│       ▼                     │        │                      │
│  toolLayer.ts               │        │  (holds the API key) │
│   ├─ excalidrawAPI ─► canvas│        │                      │
│   └─ teach_diagram ─┐       │        │  /api/tutor/lesson   │
│                     ▼       │        │   └─ walkthrough JSON│
│  tutorSession ──────────────────────►└──────────────────────┘
│   └─ speaks + traces cursor │
└─────────────────────────────┘
```

## Repository layout

Upstream Excalidraw is **not vendored** here — `setup.sh` clones it and copies our
additions in. That keeps this repo small and keeps the diff that actually belongs to
this project visible.

```
app/ai-agent/     the fork's additions: toolLayer, ChatSidebar, the tutor
                  (tutorSession, tutorPlayer, tutorSpeech, tutorCursor,
                  TutorControls), hooks, types/
app/tests/        unit + end-to-end tests
server/           the chat-to-tool-call backend + the tutor lesson route
setup.sh          clones Excalidraw and wires the sidebar into App.tsx
excalidraw/       created by setup.sh — gitignored
```

## Setup

Requires Node >= 20, yarn 1.x, git and python3.

```bash
git clone https://github.com/<you>/excalidraw-web-mcp.git
cd excalidraw-web-mcp
./setup.sh                      # clones Excalidraw + applies our changes

# 1. frontend (the forked editor)
cd excalidraw && yarn install && yarn start     # http://localhost:3001

# 2. backend (separate terminal)
cd server && npm install
cp .env.example .env            # fill in your provider credentials
npm start                       # http://localhost:8787
```

`setup.sh` is idempotent — re-run it after editing anything in `app/` to push the
change into the checkout.

Then open the editor and click the **AI** button, top-right, next to Excalidraw+ and share, to open the chat sidebar.

If you run the backend somewhere other than `localhost:8787`, point the frontend at
it with `VITE_AGENT_API=https://... yarn start`.

### Providers

Both are implemented behind one interface (`server/src/providers/`). Pick the default
with `LLM_PROVIDER` in `server/.env`; a request may also override it per call with
`{"provider": "anthropic"}`.

| Provider | Env | Notes |
|---|---|---|
| **Azure OpenAI** (production path) | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` | Default. Chat Completions + function calling. Verified against a `gpt-4.1` deployment. |
| **Anthropic** | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Messages API + `tool_use`. Implemented but **not live-tested** — no Anthropic key was available in this environment. |

`GET /api/health` reports which providers are actually configured.

## Tools

All of them run in the browser, in `excalidraw/excalidraw-app/ai-agent/toolLayer.ts`.
Each function carries its exact Claude `tool_use` schema in a JSDoc block; the copy
actually sent to the model lives in `server/src/toolSchemas.js`.

| Tool | What it does |
|---|---|
| `get_scene()` | Returns every visible element as plain JSON — `id`, `type`, `x`, `y`, `width`, `height`, `label`, plus what each arrow is bound to. |
| `add_rectangle(x, y, width, height, label)` | Labelled rectangle at exact coordinates. Returns the new id. |
| `add_text(x, y, text)` | Standalone text element for titles and notes. |
| `bind_arrow(source_id, target_id)` | Arrow between two existing elements using Excalidraw's **native binding**, so it snaps to shape edges and follows them when moved. |
| `set_style(ids[], backgroundColor?, strokeColor?, fillStyle?)` | Recolours elements **already on the canvas**, in place. |
| `remove_element(id)` | Deletes an element, its label, and any arrows bound to it. |
| `teach_diagram()` | Starts a spoken walkthrough of the canvas (see [the tutor](#the-agentic-tutor)). Returns when the lesson *starts*, not when it ends. |

`add_rectangle` also takes optional `backgroundColor` / `strokeColor` / `fillStyle`.

**House style.** Every box is created with **rounded corners**
(`roundness: ROUNDNESS.ADAPTIVE_RADIUS`) and a **`hachure`** fill — the single-line
diagonal shading that keeps Excalidraw's hand-drawn character once a colour is applied.
Both are set in the tool layer rather than left to the prompt, so they hold on every box
regardless of what the model does. Passing an explicit `fillStyle` (`solid` /
`cross-hatch`) still overrides it.

## Overlap is prevented by the tool layer, not the prompt

`add_rectangle` resolves a **non-overlapping position before creating anything**. If the
requested spot is taken it searches outward on a 20px grid and takes the nearest opening
(40px minimum clearance), then reports where the box actually landed.

This has to live in the tool layer rather than the system prompt. The model issues a
whole batch of `add_rectangle` calls in a single turn, so it cannot see any of them
before choosing coordinates — asking it to collision-check a canvas with thirty elements
is asking it to do the one thing it is worst at. Making the tool hold the invariant means
it holds at any scale, deterministically. It matches what the MCP survey found: the tool
layer owns spatial reasoning, the model owns semantics.

Arrows and lines are excluded from collision checks — they route *between* shapes, so
treating them as obstacles would wall off the canvas. The model is told to read x/y back
out of the response, since a box may not be where it asked.

## Resizing the panel

Drag the panel's inner edge to widen it, or double-click that edge to reset. The width
persists across reloads. It works by overriding `--right-sidebar-width` — the same
variable the editor uses to reserve canvas space, so the panel and the canvas reflow
together. The override is written as a stylesheet rule with `!important` rather than an
inline style, because React owns the inline style on that container and would otherwise
clobber it on the next render.

## Live voice agent

Click **Talk** in the panel and hold a spoken conversation with the agent while it draws.
It listens continuously, answers out loud, asks clarifying questions, pushes back when a
design looks wrong, and calls the same tools the typed agent uses. You can talk over it
to cut it off mid-sentence.

**Architecture.** One WebSocket carries everything — microphone audio up, spoken audio
and tool calls down — via the Azure OpenAI **Realtime** API (`gpt-realtime-2`):

```
browser ──ws──► server /api/realtime ──wss (api-key)──► Azure Realtime
  mic PCM16 24k                                          speech-to-speech
  speaker ◄── audio deltas                               + function calling
  tools ──► excalidrawAPI
```

Three decisions worth stating:

- **Speech-to-speech, not STT + LLM + TTS.** One model hears audio and answers with audio
  and function calls on the same stream, so there are no three hops to keep in sync and
  no transcription round trip before it can start replying. Separate STT/TTS services
  (OpenAI or Sarvam) would each add a leg of latency for no gain here.
- **The server proxies the socket** rather than minting a client token. The Azure key
  never reaches the browser, and because the server is the only thing that sends
  `session.update`, a tampered client cannot swap the instructions or widen the tool
  list — it can only speak and listen.
- **Server-side VAD with `interrupt_response`** makes it hands-free and interruptible.
  Barge-in is most of what separates a live agent from a turn-based one.

### Borrowing a stronger model when it matters

`gpt-realtime-2` is tuned for low-latency conversation. On what was measured here —
multi-step tool sequencing and the positional arithmetic — it matched the typed agent
exactly. Where realtime models are generally weaker is sustained reasoning: a large
one-shot build, a real design critique, a tradeoff with no obvious answer.

Rather than move the whole session to a slower model to cover the minority of turns that
need it, the agent has a **`think` tool** that hands just those turns to the chat
deployment (`AZURE_OPENAI_THINK_DEPLOYMENT`, defaulting to `gpt-4.1`) and keeps talking
at full speed the rest of the time. Measured behaviour:

| Prompt | Tools called | Thought? |
|---|---|---|
| "Draw a box labelled Payments Service and one labelled Postgres, connect them" | `get_scene, add_rectangle ×2, bind_arrow` | no |
| "40M events/day, Postgres melting — shard, CQRS, or a queue?" | `think` | yes, then answered |

Three things make it work:

- **It speaks before it thinks.** A single realtime response can carry both audio and a
  tool call, so "let me think this through for a second" and the call happen in one turn
  — the pause is explained rather than silent. The sidebar shows the step too.
- **It is handled server-side and never reaches the browser.** The tool needs another
  model, not the canvas, so routing it to the client would add a hop for nothing. The
  server answers it and relays a custom `app.thinking` event purely for the transcript —
  deliberately not a protocol event, so the browser can never answer the same call twice.
- **It returns advice, not actions.** The realtime agent stays the only thing issuing
  drawing tool calls, so canvas mutation keeps running through the browser as before.

The voice agent deliberately does **not** get the `teach_diagram` tool: the tutor narrates
through a separate mp3 pipeline, and two voices at once is never what anyone wants — a
live agent explaining the diagram conversationally is the better answer anyway.

Spoken turns are mirrored into the same transcript and the same history as typed ones, so
switching between talking and typing continues one conversation.

Configure with `AZURE_OPENAI_REALTIME_DEPLOYMENT` / `_API_VERSION` / `_VOICE`; it reuses
the existing endpoint and key.

## Selecting shapes as chat references

Select anything on the canvas and it appears as a **pill** above the chat input — the
same idea as selecting code in an editor before asking a question about it. Those
elements are sent alongside the message, so demonstratives resolve to real ids:

| You select | You type | What happens |
|---|---|---|
| the Database box | "make this blue" | `set_style(["<db id>"], …)` — only that box |
| Load Balancer + Database | "connect these" | `bind_arrow(lb, db)`, in the order listed |

Pills track the live selection and each has an `×` to drop it; deselecting and
reselecting brings it back. A large selection collapses to the first few pills behind a
`+N` chip — select-all on a busy canvas would otherwise bury the composer under thirty
of them. Collapsing is purely visual: **every** selected element is still sent as a
reference, and the transcript echo summarises as "A, B, C and 27 more". They are snapshotted at send time, so they stay correct
while the agent redraws the canvas. The system prompt tells the model to resolve
"this"/"these"/"it" to those ids and never to guess from labels.

## Dictation

A mic button sits beside **Send**, using the browser's built-in
`SpeechRecognition` (Chrome's standard STT — no API key, no audio leaves the browser).
Dictation appends to whatever is already typed. The button is hidden entirely in
browsers without the API, so Firefox users just see **Send**.

## The agentic tutor

Ask to be taught and the agent analyzes the whole canvas and delivers a full spoken
walkthrough of the diagram — while a **"Tutor" cursor traces the canvas**, gliding to
each element as it is being explained, like a teacher at a whiteboard. Stop ends the
lesson instantly. The finished walkthrough also lands in the chat history, so a
follow-up like *"why is there a load balancer?"* has the lesson as context.

**Teaching is a tool, not a side channel.** `teach_diagram` sits in the same registry as
the drawing tools, so the model decides when to teach from ordinary language — "explain
this diagram", "walk me through it" — and can compose it with drawing in a single turn
("draw a 3-tier architecture and then explain it to me" draws, binds, then teaches).
There is no keyword matching in the UI. The **Teach** button is a second entry point into
the same session, so the model and the button can never start two lessons at once, and
Stop ends whichever is playing.

The one way this tool differs from the others: it starts a *process* rather than editing
the scene. `executeTool` is synchronous and a lesson runs for a minute or more, so
`teach_diagram` returns as soon as the lesson **starts** — blocking would freeze the
agent loop for the whole narration. Its tool description says so explicitly, so the model
does not sit and poll it. Because the session lives outside React (tools have no access
to component state), it is a small external store that `TutorControls` reads with
`useSyncExternalStore`.

The design hinges on one idea: **the lesson is data, not prose.** The scene is sent to
`POST /api/tutor/lesson`, where the chat model runs with a teaching prompt and a single
*forced* tool call, `present_walkthrough`, returning
`{ intro, segments: [{ elementIds, narration }], closing }`. Because every narration
chunk names the element ids it is about, the frontend can point the cursor at exactly
those elements for exactly as long as that chunk's audio plays.

The model's output is treated as untrusted input: zod checks the shape, then
`sanitizeLesson` verifies every element id against the real scene — invented ids are
dropped, and a lesson about nothing real is rejected (`server/src/tutor.js`, unit-tested
in `server/test/tutor.test.js`).

**Voice** is the browser's own `speechSynthesis` — the mirror image of the mic in
`useDictation`, same Web Speech API family. No key, no cost, no audio over the network,
and it works the moment the page loads. `tutorSpeech.ts` wraps the three Chrome
behaviours that bite: voices load asynchronously (so the first `getVoices()` is empty),
long utterances are silently truncated after ~15s without a `resume()` ping, and
`cancel()` surfaces as an `interrupted` error that is us stopping it rather than a
failure. Browsers without the API simply never show the Teach button.

The trade against a hosted model is that you get the OS voice rather than a tuned one,
and that an utterance has no knowable duration up front — so the cursor is paced by a
words-per-minute estimate and cut short the instant speech actually ends, which keeps it
in step even when the estimate is wrong.

**The tracing cursor** is Excalidraw's own machinery, not custom drawing: "Tutor" is a
synthetic entry in the `collaborators` map — the same mechanism that renders a
teammate's named pointer in a collab room — whose `pointer` is tweened (rAF, eased)
between the narrated elements' top-centre anchors, dwelling on each for its share of the
audio. It pans and zooms with the scene for free, and `setViewport` brings off-screen
elements into view before they are spoken about. If a real collab session owns the
collaborators map, the cursor stands down and the lesson plays voice-only.

**Playback** (`tutorPlayer.ts`) prefetches each next chunk's audio while the current one
plays, so narration is gapless; the per-chunk scene is re-read so the cursor points where
elements are *now*, even if the user drags things mid-lesson. Stopping is a user action,
not an error: the AbortController path pauses audio, removes the cursor, and revokes
every object URL.

Out of scope for this pass: interrupting by voice, per-segment pause/resume, other TTS
providers, and teaching during a live collab session.

## Colour is opt-in

Diagrams render black-and-white unless the user asks for colour — the prompt forbids
volunteering it. When colour *is* requested:

- On an existing diagram the agent uses **`set_style`**, editing in place rather than
  deleting and redrawing, so layout and arrow bindings survive.
- Colours are assigned **by role, not per box** — every element playing the same part
  gets the same pair, so two app servers in a tier always match. The palette is
  Excalidraw's own, with light fills that stay readable behind the default dark label:

  | Role | background | stroke |
  |---|---|---|
  | entry point / load balancer | `#a5d8ff` | `#1971c2` |
  | compute / app server | `#b2f2bb` | `#2f9e44` |
  | data store / database | `#ffec99` | `#f08c00` |
  | cache / queue / broker | `#d0bfff` | `#6741d9` |
  | external / client | `#ffc9c9` | `#e03131` |

- `get_scene` reports colours **only for elements that have them**, so an uncoloured
  diagram stays terse while a coloured one hands the model its palette to match when
  adding new elements. A user-named colour always wins over the table.

### Tools planned for next pass

Explicitly **out of scope** here: diamond/ellipse shapes, freehand drawing, image
elements, multi-select and grouping, undo/redo history control, collaboration and
multiplayer rooms, fonts and stroke width/style, and persistence beyond Excalidraw's
own local storage. (Colour was added after the first pass, on request.)

## How positioning is kept exact

1. **The scene is re-injected every user turn.** `ChatSidebar` calls `get_scene()`
   before each request and the server prepends it to the user message, so the model
   never works from a remembered layout. `get_scene` is *also* exposed as a tool so
   it can re-read mid-turn after making changes.
2. **The system prompt forbids invented coordinates** (`server/src/systemPrompt.js`).
   It specifies default box size, minimum 40px clearance, the exact arithmetic for
   left-to-right flow (`x = prev.x + prev.width + 80`), vertical tiers
   (`y = above.y + above.height + 100`, centred), sibling spacing, and what user
   wording like *"next to"* vs *"below"* means geometrically.
3. **Arrows are never coordinate-guessed.** `bind_arrow` hands the two existing
   elements plus an arrow skeleton to Excalidraw's own `convertToExcalidrawElements`
   with `regenerateIds: false`, which runs the editor's real binding code
   (`bindBindingElement`). The result has genuine `startBinding`/`endBinding` and both
   shapes get the arrow added to their `boundElements`.

## Research: how Excalidraw MCP servers build good diagrams

Surveyed the existing Excalidraw MCP ecosystem before fixing arrow rendering. The
consistent architectural principle across them:

> MCP servers make Excalidraw diagrams a first-class data type for LLMs by handling
> all **spatial reasoning — coordinate math, element bindings, text measurement and
> overlap detection** — so the model works purely at the semantic level of nodes and
> edges.

Concrete learnings, and what this project does with each:

| Learning from the ecosystem | Applied here |
|---|---|
| Modern Excalidraw binds with **`fixedPoint` + `mode: "orbit"`**, *not* the legacy `focus`/`gap`. A binding looks like `{ elementId, mode: "orbit", fixedPoint: [1.0, 0.5] }`. | Confirmed against the vendored source. `bind_arrow` now produces boundary `fixedPoint`s. |
| Anchors must sit **on the shape boundary** so arrows meet edges based on relative position. | `edgeAnchor()` picks bottom/top/left/right from the dominant axis between centres. |
| A **binding integrity engine** keeps arrow↔shape references bidirectional and repairs orphans after each mutation. | `convertToExcalidrawElements` maintains `boundElements` both ways; `remove_element` deletes arrows bound to a removed shape so nothing dangles. |
| **Overlap detection** belongs in the tool layer, not the prompt. | `add_rectangle` returns a `warning` naming the elements it collides with, so the agent self-corrects. |
| **Text measurement** (over-estimated ~15%) stops labels clipping. | Not adopted — Excalidraw measures bound text itself on the client, so the container grows natively. Noted as a next-pass item if labels ever clip. |
| Some servers own layout entirely via a **graph layout algorithm** (the model supplies only structure). | Deliberately *not* adopted: this project's brief requires the model to compute positions arithmetically from `get_scene`. The tool layer owns pixel-accuracy (edges, bindings, overlap reporting); the model owns semantics and layout. |

### The arrow bug this research fixed

Arrows were drawn from one box's **centre** to the other's, skewering both shapes.
The bindings were real — `startBinding`/`endBinding` had correct `elementId`s — but the
geometry was wrong, because `fixedPoint` is derived from the endpoint you hand the
binding code:

```
fixedPoint = [(px - box.x) / box.width, (py - box.y) / box.height]
```

Seeding the arrow centre-to-centre therefore recorded `[0.5, 0.5]` — literally "anchor
at the centre". Seeding it between the two outlines yields `[0.5, 1]` (bottom centre)
and `[0.5, 0]` (top centre) instead.

A second, subtler bug surfaced while fixing it: Excalidraw computes an arrow's default
points as `element.width || 100`, so a perfectly **vertical** arrow (width `0`, which is
falsy) silently gained a 100px horizontal kink. `bind_arrow` now passes `points`
explicitly.

Both are covered by regression tests that assert on the actual geometry, not merely
that a binding object exists — which is what let the original bug through.

## Design decision: where the agent loop runs

The tool layer *must* live in the frontend — `excalidrawAPI` is an in-memory handle on
the mounted editor and cannot be reached from Node. So the backend needs a way to say
"run this tool call" and get the result.

The options were a socket/SSE channel, frontend polling of a queue, or making each
HTTP request **one step** of the loop. This project does the last one: each
`POST /api/chat` is a single model turn returning either final text or the tool calls
to run; the browser executes them against `excalidrawAPI`, appends the results, and
posts again.

That means no sockets, no polling, and **no server-side session state** — the server
is a pure function of the history it is handed, so it restarts cleanly and scales
trivially. The API key never reaches the browser. The cost is one HTTP round trip per
model turn, which is negligible next to model latency. Rationale is also recorded in
the header comment of `server/src/index.js`.

## Tests

```bash
cd excalidraw
yarn vitest run excalidraw-app/tests/aiToolLayer.test.tsx   # tool-layer unit tests, no network
yarn vitest run excalidraw-app/tests/aiTutor.test.tsx       # tutor playback/cursor unit tests, no network
yarn vitest run excalidraw-app/tests/aiChatToggle.test.tsx  # 1 render test, no network
yarn vitest run excalidraw-app/tests/aiAgent.e2e.test.tsx   # end-to-end, needs the backend

cd ../server && npm test    # lesson validation/sanitation unit tests, no network
```

`aiTutor.test.tsx` installs a fake `speechSynthesis` (jsdom has none) whose `speak`
parks a resolver instead of talking, so each test decides exactly when an utterance
"finishes" and can assert on state *during* narration: chunk order, the Tutor cursor
appearing and being removed, abort cleanup mid-lesson, an `interrupted` utterance
treated as a stop rather than an error, and stale element ids not crashing the tracer.
The tutor's live e2e case (every segment's ids exist in the scene) sits in
`aiAgent.e2e.test.tsx` and self-skips unless the backend is up.

`aiToolLayer.test.tsx` mounts a real Excalidraw and exercises the scene-editing tools,
including asserting that `bind_arrow` produces real bindings on both ends and that
`remove_element` cleans up labels and dangling arrows.

`aiAgent.e2e.test.tsx` asserts on live model output. It was initially flaky (1 failure
in 6 runs — the model placed a "cache next to the database" in a new row *below* it
instead of beside it). Two changes fixed that: `temperature: 0` on the Azure provider,
since layout is rule-following rather than creative work, and hardening the wording
rules in the system prompt from suggestions into explicit hard rules. It has passed
every run since (4/4). `aiToolLayer.test.tsx` is fully deterministic and is the one to
trust in CI.

`aiAgent.e2e.test.tsx` runs the actual demo scenario against the live backend and
model: it draws the 3-tier architecture, asserts every arrow is bound at both ends and
that no two boxes overlap, then issues *"now add a cache next to the database"* and
asserts the cache lands in the same row as the database and adjacent to it. It skips
itself automatically if the backend is not running.

## Assumptions made about Excalidraw's current API surface

Checked against the cloned `master`, not the published docs — several of these differ
from older versions.

- **`excalidrawAPI` is obtained via the `useExcalidrawAPI()` hook**, available anywhere
  under `<ExcalidrawAPIProvider>` (which `excalidraw-app` already mounts). The older
  `ref`/`excalidrawAPI` prop still exists as `onExcalidrawAPI`.
- **`updateScene({ elements, captureUpdate })`** is the supported write path.
  `captureUpdate: CaptureUpdateAction.IMMEDIATELY` makes agent edits undoable, matching
  what the app does for local changes. There is no `scrollToContent` on the current
  API (it is now `setViewport`); the agent does not move the viewport.
- **Mutations are built on `getSceneElementsIncludingDeleted()`** so tombstoned
  elements are preserved; `get_scene` reports only `getSceneElements()` (live ones).
- **A container's label is a separate `text` element** linked by `containerId`.
  `get_scene` folds it into the container so the model sees one shape, and
  `remove_element` deletes it alongside its container.
- **`convertToExcalidrawElements(skeletons, { regenerateIds: false })`** preserves
  caller-supplied ids. This is what makes `bind_arrow` able to bind to elements that
  are *already* on the canvas rather than only to ones created in the same call.
- **Deletion is a soft delete** (`isDeleted: true` via `newElementWith`), which is how
  Excalidraw itself handles it for history and collaboration.
- Styling is left at Excalidraw's defaults, per scope. Default box is 180×80.
- The dev server binds **port 3001** here because 3000 was occupied.

## Deploying the backend to Azure

Not deployed as part of this MVP — the frontend runs locally, so the backend does too.
When it is deployed it goes to Azure, per project constraint. The backend is a
stateless Express app with no session state, so App Service is enough:

```bash
cd server
az webapp up \
  --name excalidraw-web-mcp-api \
  --resource-group <your-resource-group> \
  --runtime "NODE:20-lts" \
  --sku B1

az webapp config appsettings set \
  --name excalidraw-web-mcp-api \
  --resource-group <your-resource-group> \
  --settings \
    LLM_PROVIDER=azure \
    AZURE_OPENAI_ENDPOINT="https://<your-resource>.openai.azure.com/" \
    AZURE_OPENAI_DEPLOYMENT=gpt-4.1 \
    AZURE_OPENAI_API_KEY="<key>"
```

Then run the frontend with `VITE_AGENT_API=https://excalidraw-web-mcp-api.azurewebsites.net`.
For production, prefer a managed identity or Key Vault reference over a literal key,
and restrict CORS to the frontend's origin (it is currently open).

## Security notes

- `server/.env` is gitignored and holds the only copy of the credentials.
- The Claude / Azure OpenAI call happens server-side only; no key is ever shipped to
  the browser. Narration needs no key at all — the browser speaks it locally, so no
  audio and no text ever leaves the machine for that.
- CORS is wide open for local development — lock it down before deploying.
- `/api/tutor/lesson` spends money per call (one model turn) and has no auth, and open
  CORS means any page visited while the server runs can reach it. So it is **rate
  limited** (60/min per IP), the scene is capped at 300 elements and parsed against an
  explicit field allowlist rather than passed through, and the upstream call carries a
  timeout. These bound the bill; they are not a substitute for auth if this ever leaves
  localhost.
- 500s return a generic message — provider errors name endpoints, deployments and quota
  state, so the detail stays in the server log. `helmet()` sets baseline headers.
- **Security invariant worth preserving:** the tutor gets exactly one tool and it mutates
  nothing. Element labels reach the model prompt unescaped, so a malicious diagram can
  steer *what the tutor says* — harmless while the narration is only spoken and rendered
  as inert text. Giving the tutor any tool with side effects would turn that into a real
  vulnerability. There is a note to this effect on `runTutorLesson`.

## Attribution

Built on [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT, © 2020 Excalidraw).
This repo contains only the agent additions; `setup.sh` clones upstream Excalidraw at
build time rather than vendoring it.

No `LICENSE` file is included yet — add one before treating this as reusable by others.
