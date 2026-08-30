/**
 * Chat wire and transcript shapes, shared by the sidebar and the tutor.
 */

/** Message shape the backend speaks (see server/src/index.js). */
export type AgentMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      raw?: unknown;
      toolCalls?: { id: string; name: string; input: unknown }[];
    }
  | {
      role: "tool";
      results: {
        id: string;
        name: string;
        content: string;
        isError?: boolean;
      }[];
    };

/** What the user actually sees in the transcript. */
export type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string; failed: boolean }
  | { kind: "error"; text: string };
