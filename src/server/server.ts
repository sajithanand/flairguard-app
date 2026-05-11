import type { IncomingMessage, ServerResponse } from "node:http";
import { context, reddit, redis } from "@devvit/web/server";
import type { TriggerResponse, UiResponse } from "@devvit/web/shared";
import { once } from "node:events";
import {
  ApiEndpoint,
  type ActionLogEntry,
  type FlairRule,
  type GetLogsResponse,
  type GetRulesResponse,
  type SaveRulesRequest,
  type SaveRulesResponse,
} from "../shared/api.ts";

// ─── Redis key helpers ────────────────────────────────────────────────────────

const RULES_KEY = "flairguard:rules";
const LOG_KEY   = "flairguard:log";
const MAX_LOG   = 50; // keep last 50 actions

// ─── Request router ───────────────────────────────────────────────────────────

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    const msg = `FlairGuard server error: ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON(500, { error: msg, status: 500 }, rsp);
  }
}

async function onRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  const endpoint = (req.url ?? "") as ApiEndpoint;

  switch (endpoint) {
    // ── Devvit trigger endpoints ──────────────────────────────────────────────
    case ApiEndpoint.OnAppInstall:
      writeJSON(200, await onAppInstall(), rsp);
      break;

    case ApiEndpoint.OnPostFlair:
      writeJSON(200, await onPostFlair(req), rsp);
      break;

    // ── Mod menu endpoints ────────────────────────────────────────────────────
    case ApiEndpoint.OnMenuViewLogs:
      writeJSON(200, await onMenuViewLogs(), rsp);
      break;

    // ── Dashboard API endpoints ───────────────────────────────────────────────
    case ApiEndpoint.GetRules:
      writeJSON(200, await getRules(), rsp);
      break;

    case ApiEndpoint.SaveRules:
      writeJSON(200, await saveRules(req), rsp);
      break;

    case ApiEndpoint.GetLogs:
      writeJSON(200, await getLogs(), rsp);
      break;

    default:
      writeJSON(404, { error: "not found", status: 404 }, rsp);
  }
}

// ─── Trigger: App Install ─────────────────────────────────────────────────────

async function onAppInstall(): Promise<TriggerResponse> {
  // Seed with sensible default rules so mods have a starting point
  const existing = await redis.get(RULES_KEY);
  if (!existing) {
    const defaults: FlairRule[] = [
      {
        flairText: "Rule 1 - Spam",
        removalReason:
          "Your post has been removed because it violates **Rule 1 — No Spam**.\n\n" +
          "Please review the community rules before posting again.",
        removePost: true,
        lockThread: false,
        notifyModmail: false,
      },
      {
        flairText: "Rule 2 - Off Topic",
        removalReason:
          "Your post has been removed because it is **off-topic** for this community.\n\n" +
          "Please check the sidebar for what types of posts are allowed.",
        removePost: true,
        lockThread: false,
        notifyModmail: false,
      },
    ];
    await redis.set(RULES_KEY, JSON.stringify(defaults));
    console.log("[FlairGuard] Installed with default rules.");
  }
  return {};
}

// ─── Trigger: Post Flair Updated ─────────────────────────────────────────────

async function onPostFlair(req: IncomingMessage): Promise<TriggerResponse> {
  const body = await readJSON<Record<string, unknown>>(req).catch(() => ({}));

  // Confirmed Devvit Web PostFlairUpdate shape:
  // body.post.id, body.post.linkFlair.text, body.post.title, body.author.name
  const post = (body.post ?? {}) as Record<string, unknown>;
  const linkFlair = (post.linkFlair ?? {}) as Record<string, string>;

  const postId: string = (post.id as string) ?? context.postId ?? "";
  const flairText: string = linkFlair.text ?? "";
  const postTitle: string = (post.title as string) ?? "(unknown)";
  const authorName: string =
    ((body.author ?? {}) as Record<string, string>).name ?? "(unknown)";

  if (!postId || !flairText) {
    console.log(`[FlairGuard] Missing postId="${postId}" or flairText="${flairText}" — skipping.`);
    return {};
  }

  console.log(`[FlairGuard] Flair "${flairText}" applied to post ${postId}`);

  // Load rules from Redis
  const rulesRaw = await redis.get(RULES_KEY);
  const rules: FlairRule[] = rulesRaw ? JSON.parse(rulesRaw) : [];

  // Find matching rule — normalize dashes and case for robust matching
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[–—]/g, "-").trim();

  const rule = rules.find(
    (r) => normalize(r.flairText) === normalize(flairText)
  );

  if (!rule) {
    console.log(`[FlairGuard] No rule configured for flair "${flairText}" — skipping.`);
    return {};
  }

  const actionsTaken: string[] = [];

  // ── 1. Remove the post ───────────────────────────────────────────────────
  if (rule.removePost) {
    try {
      await reddit.remove(postId, false);
      actionsTaken.push("removed");
      console.log(`[FlairGuard] Post ${postId} removed.`);
    } catch (e) {
      console.error(`[FlairGuard] Failed to remove post: ${e}`);
    }
  }

  // ── 2. Post a sticky removal reason comment ──────────────────────────────
  try {
    const comment = await reddit.submitComment({
      id: postId,
      text: buildRemovalComment(rule.removalReason, flairText),
    });
    // Distinguish (pin) the comment as a moderator comment
    await reddit.distinguish(comment.id, true);
    actionsTaken.push("commented");
    console.log(`[FlairGuard] Removal comment posted: ${comment.id}`);
  } catch (e) {
    console.error(`[FlairGuard] Failed to post comment: ${e}`);
  }

  // ── 3. Lock the thread ───────────────────────────────────────────────────
  if (rule.lockThread) {
    try {
      await reddit.lock(postId);
      actionsTaken.push("locked");
      console.log(`[FlairGuard] Post ${postId} locked.`);
    } catch (e) {
      console.error(`[FlairGuard] Failed to lock post: ${e}`);
    }
  }

  // ── 4. Log the action ────────────────────────────────────────────────────
  try {
    await appendLog({
      timestamp: Date.now(),
      postId,
      postTitle,
      authorName,
      flairText,
      actionsTaken,
    });
  } catch (e) {
    console.error(`[FlairGuard] Failed to log action: ${e}`);
  }

  console.log(`[FlairGuard] Done. Actions taken: ${actionsTaken.join(", ")}`);
  return {};
}

// ─── Menu: View Recent Logs ───────────────────────────────────────────────────

async function onMenuViewLogs(): Promise<UiResponse> {
  const entries = await readLog();
  if (entries.length === 0) {
    return { showToast: { text: "FlairGuard: No actions logged yet.", appearance: "neutral" } };
  }
  const lines = entries
    .slice(0, 5)
    .map(
      (e) =>
        `• "${e.flairText}" on "${e.postTitle.slice(0, 40)}" by u/${e.authorName}`
    )
    .join("\n");
  return { showToast: { text: `Recent FlairGuard Actions:\n${lines}`, appearance: "success" } };
}

// ─── API: Get Rules ───────────────────────────────────────────────────────────

async function getRules(): Promise<GetRulesResponse> {
  const raw = await redis.get(RULES_KEY);
  const rules: FlairRule[] = raw ? JSON.parse(raw) : [];
  return { type: "getRules", rules };
}

// ─── API: Save Rules ──────────────────────────────────────────────────────────

async function saveRules(req: IncomingMessage): Promise<SaveRulesResponse> {
  const { rules } = await readJSON<SaveRulesRequest>(req);
  await redis.set(RULES_KEY, JSON.stringify(rules));
  console.log(`[FlairGuard] Saved ${rules.length} rules.`);
  return { type: "saveRules", ok: true };
}

// ─── API: Get Logs ────────────────────────────────────────────────────────────

async function getLogs(): Promise<GetLogsResponse> {
  const entries = await readLog();
  return { type: "getLogs", entries };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRemovalComment(reason: string, flairText: string): string {
  return (
    `**[Removed by FlairGuard — ${flairText}]**\n\n` +
    `${reason}\n\n` +
    `---\n*This action was performed automatically. If you believe this was a mistake, please [message the moderators](https://www.reddit.com/message/compose?to=%2Fr%2F${encodeURIComponent(context.subredditName ?? "")}).*`
  );
}

async function appendLog(entry: ActionLogEntry): Promise<void> {
  const existing = await readLog();
  const updated = [entry, ...existing].slice(0, MAX_LOG);
  await redis.set(LOG_KEY, JSON.stringify(updated));
}

async function readLog(): Promise<ActionLogEntry[]> {
  const raw = await redis.get(LOG_KEY);
  return raw ? JSON.parse(raw) : [];
}

function writeJSON<T>(status: number, json: T, rsp: ServerResponse): void {
  const body = JSON.stringify(json);
  rsp.writeHead(status, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json",
  });
  rsp.end(body);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  await once(req, "end");
  return JSON.parse(`${Buffer.concat(chunks)}`);
}
