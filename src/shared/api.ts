// ──────────────────────────────────────────────────────────────
// FlairGuard – Shared API types & endpoint constants
// ──────────────────────────────────────────────────────────────

/** A single flair-to-action mapping configured by a moderator */
export type FlairRule = {
  /** Exact flair text to match (case-insensitive) */
  flairText: string;
  /** Human-readable removal reason posted as a sticky comment */
  removalReason: string;
  /** Whether to remove the post automatically */
  removePost: boolean;
  /** Whether to lock the thread after removal */
  lockThread: boolean;
  /** Whether to notify modmail when this rule fires */
  notifyModmail: boolean;
};

/** Stored entry in the action log */
export type ActionLogEntry = {
  timestamp: number;
  postId: string;
  postTitle: string;
  authorName: string;
  flairText: string;
  actionsTaken: string[];
};

// ── API response shapes ─────────────────────────────────────────

export type GetRulesResponse = {
  type: "getRules";
  rules: FlairRule[];
};

export type SaveRulesResponse = {
  type: "saveRules";
  ok: boolean;
};

export type GetLogsResponse = {
  type: "getLogs";
  entries: ActionLogEntry[];
};

export type GetRulesRequest = Record<string, never>;

export type SaveRulesRequest = {
  rules: FlairRule[];
};

// ── Endpoint map ────────────────────────────────────────────────

export const ApiEndpoint = {
  // Trigger endpoints (called by Devvit runtime)
  OnAppInstall:    "/internal/on-app-install",
  OnPostFlair:     "/internal/triggers/post-flair",

  // Menu action endpoints
  OnMenuViewLogs:  "/internal/menu/view-logs",

  // UI API endpoints (called by the webview dashboard)
  GetRules:        "/api/get-rules",
  SaveRules:       "/api/save-rules",
  GetLogs:         "/api/get-logs",
} as const;

export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];
