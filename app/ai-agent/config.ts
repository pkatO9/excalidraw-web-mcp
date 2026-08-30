/**
 * Where the agent backend lives. Shared by the chat loop (ChatSidebar) and the
 * tutor (TutorControls / tutorPlayer) so the override travels with one env var.
 */
export const API_BASE =
  (import.meta as any).env?.VITE_AGENT_API || "http://localhost:8787";
