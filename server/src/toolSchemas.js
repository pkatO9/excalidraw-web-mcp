/**
 * Canonical Claude `tool_use` definitions for every tool the agent can call.
 *
 * These are the definitions actually sent to the model. The matching browser-side
 * implementations live in `excalidraw/excalidraw-app/ai-agent/toolLayer.ts`, which
 * repeats each schema in a JSDoc block for reference.
 */
export const TOOL_SCHEMAS = [
  {
    name: "get_scene",
    description:
      "Read the current Excalidraw canvas. Returns every visible element with its id, type, exact x/y position, width, height and label, plus what each arrow is bound to. Call this before placing anything so you can position new elements by arithmetic on real coordinates instead of guessing, and call it again after making changes if you need to re-check the layout.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "add_rectangle",
    description:
      "Add a labelled rectangle. x/y are the top-left corner. Use this for every box in an architecture diagram (services, load balancers, databases, caches). Collision is handled for you: if the spot you ask for is taken, the box is placed at the nearest free position instead and the response tells you where it actually landed — so boxes can never overlap. ALWAYS use the x/y in the response, not the ones you requested, when positioning anything relative to this box. Returns the new element's id, which you need for bind_arrow.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Top-left x coordinate." },
        y: { type: "number", description: "Top-left y coordinate." },
        width: {
          type: "number",
          description: "Width in pixels. Use 180 unless the label needs more.",
        },
        height: {
          type: "number",
          description: "Height in pixels. Use 80 unless the label needs more.",
        },
        label: {
          type: "string",
          description: "Text shown centred inside the rectangle.",
        },
        backgroundColor: {
          type: "string",
          description:
            "OPTIONAL fill colour as a hex string. Omit it unless the user asked for colour — an uncoloured diagram must stay uncoloured.",
        },
        strokeColor: {
          type: "string",
          description:
            "OPTIONAL border colour as a hex string. Omit unless the user asked for colour.",
        },
        fillStyle: {
          type: "string",
          enum: ["solid", "hachure", "cross-hatch"],
          description:
            "OPTIONAL fill rendering. Defaults to 'hachure' (single-line sketchy shading) — leave it out unless the user asks for a 'solid' filled look or 'cross-hatch'.",
        },
      },
      required: ["x", "y", "width", "height", "label"],
    },
  },
  {
    name: "add_text",
    description:
      "Add a standalone text element at exact coordinates, for diagram titles, captions or notes that are NOT attached to a shape. To put text inside a box, pass `label` to add_rectangle instead.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Top-left x coordinate." },
        y: { type: "number", description: "Top-left y coordinate." },
        text: { type: "string", description: "The text to render." },
      },
      required: ["x", "y", "text"],
    },
  },
  {
    name: "bind_arrow",
    description:
      "Draw an arrow between two elements that already exist, using Excalidraw's native binding so the arrow snaps cleanly to both shapes' edges and stays attached if they move. Pass element ids (from get_scene or from add_rectangle's return value) — never coordinates. The arrow points from source to target.",
    input_schema: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description: "id of the element the arrow starts at.",
        },
        target_id: {
          type: "string",
          description: "id of the element the arrow points to.",
        },
      },
      required: ["source_id", "target_id"],
    },
  },
  {
    name: "set_style",
    description:
      "Apply colours to elements that are ALREADY on the canvas. Use this when the user asks to colour, highlight or restyle an existing diagram — it edits in place, so positions, labels and arrow bindings are all preserved. Pass several ids in one call to give a whole tier the same colour.",
    input_schema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Element ids from get_scene to restyle.",
        },
        backgroundColor: {
          type: "string",
          description:
            'Fill colour as a hex string, or "transparent" to clear it.',
        },
        strokeColor: {
          type: "string",
          description: "Border/line colour as a hex string.",
        },
        fillStyle: {
          type: "string",
          enum: ["solid", "hachure", "cross-hatch"],
          description:
            "How the fill is drawn. Defaults to 'hachure' (single-line sketchy shading).",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "remove_element",
    description:
      "Delete an element by id. Deleting a shape also removes its label and any arrows bound to it, so those arrows disappear automatically — do NOT also call remove_element for them. When the user asks to delete several elements, issue one call per shape and leave the connecting arrows out. Calling it for something that has already gone is a harmless no-op. Use this to correct a mistake.",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "id of the element to delete, from get_scene.",
        },
      },
      required: ["id"],
    },
  },
  {
    /**
     * The tutor. Note the "returns when it STARTS" wording: the browser cannot
     * block its agent loop for a minute of narration, so the tool result means
     * the lesson began, not that it finished.
     */
    name: "teach_diagram",
    description:
      "Start a spoken walkthrough of the diagram currently on the canvas: the tutor analyses the scene, explains what the system does and how data flows through it out loud, and traces a cursor over each element as it talks about it. Use this whenever the user asks to be taught, or for an explanation or walkthrough of the diagram ('teach me this', 'explain this diagram', 'walk me through it'). Requires a non-empty canvas — draw the diagram first if it is empty. IMPORTANT: this returns as soon as the lesson STARTS, not when it finishes; the narration then plays on its own. Call it once, never poll it or call it again to check progress, and end your turn with one short sentence.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

/** Azure OpenAI / OpenAI expect the same JSON Schema under a different envelope. */
export const toOpenAITools = (schemas = TOOL_SCHEMAS) =>
  schemas.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
