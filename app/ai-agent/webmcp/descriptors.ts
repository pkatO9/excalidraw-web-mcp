/**
 * Tool declarations for the canvas, in WebMCP's own shape.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for what the canvas can do. It lives in
 * the browser because that is where WebMCP expects it: under WebMCP the page
 * is the tool provider, so the definitions belong next to the code that runs
 * them, not on a server that happens to talk to a model.
 *
 * The backend no longer owns this list — it receives it from the browser with
 * each request (see server/src/index.js). Its own copy is a labelled fallback
 * for when a client is too old to send one.
 *
 * Generated once from the previous server-side definitions; edit here from now
 * on. Field names are WebMCP's: `inputSchema`, not the Anthropic-style
 * `input_schema` — the adapter for that lives in the provider.
 */

export type ToolDeclaration = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: "get_scene",
    description:
      "Read the current Excalidraw canvas. Returns every visible element with its id, type, exact x/y position, width, height and label, plus what each arrow is bound to. Call this before placing anything so you can position new elements by arithmetic on real coordinates instead of guessing, and call it again after making changes if you need to re-check the layout.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "create_diagram",
    description:
      "Draw a whole diagram in one call from its STRUCTURE — the boxes and what connects to what — and let the layout engine place everything. USE THIS FOR ANY REQUEST THAT MEANS BUILDING A DIAGRAM OR A SUBSYSTEM, even a small one. Do not place boxes one at a time and connect them afterwards: that reliably produces arrows cutting across boxes, because when each box is positioned the connections it will carry are not known yet. This tool sees the whole graph, so it ranks the nodes into layers, orders them to minimise crossings, and routes long arrows around whatever sits between. Keep add_rectangle and bind_arrow for small edits to a diagram that already exists.",
    inputSchema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          description: "Every box in the diagram.",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description:
                  'Short id used only to describe edges, e.g. "db". Never shown to the user.',
              },
              label: {
                type: "string",
                description: "Text shown inside the box.",
              },
              shape: {
                type: "string",
                enum: ["rectangle", "diamond", "ellipse"],
                description:
                  "rectangle for a service, component or store (the default); diamond for a decision or branch; ellipse for a start or end point.",
              },
            },
            required: ["key", "label"],
          },
        },
        edges: {
          type: "array",
          description:
            "Connections, each pointing from the upstream element to the downstream one.",
          items: {
            type: "object",
            properties: {
              from: {
                type: "string",
                description: "key of the source node.",
              },
              to: {
                type: "string",
                description: "key of the target node.",
              },
            },
            required: ["from", "to"],
          },
        },
        direction: {
          type: "string",
          enum: ["TB", "LR"],
          description:
            "TB (default) stacks the flow downward; LR runs it left to right. Prefer TB for architectures, LR for short linear pipelines.",
        },
        replace: {
          type: "boolean",
          description:
            "true clears the canvas first. Use when the user asks to start over or replace what is there.",
        },
      },
      required: ["nodes", "edges"],
    },
  },
  {
    name: "add_rectangle",
    description:
      "Add a labelled rectangle. x/y are the top-left corner. Use this for every box in an architecture diagram (services, load balancers, databases, caches). Collision is handled for you: if the spot you ask for is taken, the box is placed at the nearest free position instead and the response tells you where it actually landed — so boxes can never overlap. ALWAYS use the x/y in the response, not the ones you requested, when positioning anything relative to this box. Returns the new element's id, which you need for bind_arrow.",
    inputSchema: {
      type: "object",
      properties: {
        x: {
          type: "number",
          description: "Top-left x coordinate.",
        },
        y: {
          type: "number",
          description: "Top-left y coordinate.",
        },
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
    inputSchema: {
      type: "object",
      properties: {
        x: {
          type: "number",
          description: "Top-left x coordinate.",
        },
        y: {
          type: "number",
          description: "Top-left y coordinate.",
        },
        text: {
          type: "string",
          description: "The text to render.",
        },
      },
      required: ["x", "y", "text"],
    },
  },
  {
    name: "bind_arrow",
    description:
      "Draw an arrow between two elements that already exist, using Excalidraw's native binding so the arrow snaps cleanly to both shapes' edges and stays attached if they move. Pass element ids (from get_scene or from add_rectangle's return value) — never coordinates. The arrow points from source to target.",
    inputSchema: {
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
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: {
            type: "string",
          },
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
    inputSchema: {
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
    name: "teach_diagram",
    description:
      "Start a spoken walkthrough of the diagram currently on the canvas: the tutor analyses the scene, explains what the system does and how data flows through it out loud, and traces a cursor over each element as it talks about it. Use this whenever the user asks to be taught, or for an explanation or walkthrough of the diagram ('teach me this', 'explain this diagram', 'walk me through it'). Requires a non-empty canvas — draw the diagram first if it is empty. IMPORTANT: this returns as soon as the lesson STARTS, not when it finishes; the narration then plays on its own. Call it once, never poll it or call it again to check progress, and end your turn with one short sentence.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

/** Name lookup, used to validate what an agent asks for. */
export const DECLARED_TOOL_NAMES = new Set(
  TOOL_DECLARATIONS.map((tool) => tool.name),
);
