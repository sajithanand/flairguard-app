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
const LOG_KEY = "flairguard:log";
const SETTINGS_POST_KEY = "flairguard:settings_post_id_v2";
const STATUS_POST_KEY = "flairguard:status_post_id";
const MAX_LOG = 500; // keep last 500 actions

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
  // Use robust URL parsing to handle both relative and absolute URLs
  const urlStr = req.url ?? "";
  let endpoint: string;
  try {
    // If it's a full URL, extract the pathname. If not, treat as relative.
    const parsed = new URL(urlStr, "http://localhost");
    endpoint = parsed.pathname;
  } catch (e) {
    endpoint = urlStr.split("?")[0] ?? "";
  }
  
  // Clean up trailing slash
  if (endpoint.endsWith("/") && endpoint.length > 1) {
    endpoint = endpoint.slice(0, -1);
  }

  console.log(`[BACKEND] Request: ${endpoint} (Original: ${urlStr})`);

  switch (endpoint as ApiEndpoint) {
    // ── Devvit trigger endpoints ──────────────────────────────────────────────
    case ApiEndpoint.OnAppInstall:
      writeJSON(200, await onAppInstall(), rsp);
      break;

    case ApiEndpoint.OnPostFlair:
      writeJSON(200, await onPostFlair(req), rsp);
      break;

    // ── Mod menu endpoints ────────────────────────────────────────────────────
    case ApiEndpoint.OnMenuOpenSettings:
      writeJSON(200, await onMenuOpenSettings(), rsp);
      break;

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

    case ApiEndpoint.SaveStatus:
      writeJSON(200, await saveStatus(req), rsp);
      break;

    case ApiEndpoint.ClearLogs:
      await redis.del(LOG_KEY);
      writeJSON(200, { ok: true }, rsp);
      break;

    default:
      writeJSON(404, { error: "not found", status: 404 }, rsp);
  }
}

// ─── Trigger: App Install ─────────────────────────────────────────────────────

async function onAppInstall(): Promise<TriggerResponse> {
  const existing = await redis.get(RULES_KEY);
  if (!existing) {
    const defaults: FlairRule[] = [
      {
        flairText: "Rule 1 - Spam",
        isRegex: false,
        removalReason:
          "Your post has been removed because it violates **Rule 1 — No Spam**.\n\n" +
          "Please review the community rules before posting again.",
        removePost: true,
        lockThread: false,
        notifyModmail: false,
        banDurationDays: 0,
      },
      {
        flairText: "Rule 2 - Off Topic",
        isRegex: false,
        removalReason:
          "Your post has been removed because it is **off-topic** for this community.\n\n" +
          "Please check the sidebar for what types of posts are allowed.",
        removePost: true,
        lockThread: false,
        notifyModmail: false,
        banDurationDays: 0,
      },
    ];
    await redis.set(RULES_KEY, JSON.stringify(defaults));
    console.log("[FlairGuard] Installed with default rules.");

    // Send a welcome modmail to guide the mod team
    try {
      await reddit.sendPrivateMessageAsSubreddit({
        fromSubredditName: context.subredditName ?? "",
        to: context.userId ?? "",
        subject: "🛡️ FlairGuard is installed — here’s how to set it up",
        text:
          "## Welcome to FlairGuard!\n\n" +
          "FlairGuard automatically removes posts and posts removal reasons when you apply a removal flair.\n\n" +
          "**Default rules loaded:**\n" +
          "- `Rule 1 - Spam` → auto-removes post + posts removal reason\n" +
          "- `Rule 2 - Off Topic` → auto-removes post + posts removal reason\n\n" +
          "**To configure your own rules:** Go to your subreddit mod menu and click **⚙️ FlairGuard: Configure Rules**.\n\n" +
          "*Powered by the Reddit Developer Platform.*",
      });
    } catch (e) {
      // Modmail on install is nice-to-have, don’t fail install if it errors
      console.warn(`[FlairGuard] Could not send welcome modmail: ${e}`);
    }

    // Automatically spawn the settings post so the user doesn't have to find the mod menu!
    try {
      const post = await reddit.submitCustomPost({
        title: "⚙️ FlairGuard — Rules Dashboard (Mods Only)",
        subredditName: context.subredditName ?? "",
        entry: "default",
      });
      await redis.set(SETTINGS_POST_KEY, post.id);
      console.log(`[FlairGuard] Automatically generated settings post: ${post.url}`);
    } catch (e) {
      console.error(`[FlairGuard] Failed to auto-generate settings post:`, e);
    }
  }
  return {};
}

// ─── Trigger: Post Flair Updated ─────────────────────────────────────────────

async function onPostFlair(req: IncomingMessage): Promise<TriggerResponse> {
  const body = await readJSON<any>(req).catch(() => ({}));

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

  // ── Deduplication: skip if we already handled this exact post+flair recently ─
  const dedupKey = `flairguard:dedup:${postId}:${flairText.replace(/\s+/g, "_")}`;
  const alreadyHandled = await redis.get(dedupKey);
  if (alreadyHandled) {
    console.log(`[FlairGuard] Already handled post ${postId} for flair "${flairText}" — skipping duplicate.`);
    return {};
  }
  // Mark as handled for 120 seconds to absorb any repeated triggers
  await redis.set(dedupKey, "1");
  await redis.expire(dedupKey, 120);

  console.log(`[FlairGuard] Flair "${flairText}" applied to post ${postId}`);

  // Load rules from Redis
  const rulesRaw = await redis.get(RULES_KEY);
  const rules: FlairRule[] = rulesRaw ? JSON.parse(rulesRaw) : [];

  // Find matching rule — check regex first, then exact match
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[–—]/g, "-").trim();

  const rule = rules.find((r) => {
    if (r.isRegex) {
      try {
        const regex = new RegExp(r.flairText, 'i');
        return regex.test(flairText);
      } catch (e) {
        return false;
      }
    }
    return normalize(r.flairText) === normalize(flairText);
  });

  if (!rule) {
    console.log(`[FlairGuard] No rule configured for flair "${flairText}" — skipping.`);
    return {};
  }

  const actionsTaken: string[] = [];

  // ── 1. Remove the post ───────────────────────────────────────────────────
  if (rule.removePost) {
    try {
      await reddit.remove(postId as `t3_${string}`, false);
      actionsTaken.push("removed");
      console.log(`[FlairGuard] Post ${postId} removed.`);
    } catch (e) {
      console.error(`[FlairGuard] Failed to remove post: ${e}`);
    }
  }

  // ── 2. Post removal reason comment ──────────────────────────────────────
  try {
    const comment = await reddit.submitComment({
      id: postId as `t3_${string}`,
      text: buildRemovalComment(rule.removalReason, flairText, postTitle, authorName),
    });
    // Note: reddit.distinguish() is not available in Devvit Web SDK
    // The comment still appears clearly as posted by the app account
    actionsTaken.push("commented");
    console.log(`[FlairGuard] Removal comment posted: ${comment.id}`);
  } catch (e) {
    console.error(`[FlairGuard] Failed to post comment: ${e}`);
  }

  // ── 3. Lock the thread ───────────────────────────────────────────────────
  if (rule.lockThread) {
    try {
      const postToLock = await reddit.getPostById(postId as `t3_${string}`);
      await postToLock.lock();
      actionsTaken.push("locked");
      console.log(`[FlairGuard] Post ${postId} locked.`);
    } catch (e) {
      console.error(`[FlairGuard] Failed to lock post: ${e}`);
    }
  }

  // ── 4. Notify via modmail ─────────────────────────────────────────────────
  if (rule.notifyModmail) {
    try {
      const postUrl = `https://reddit.com/r/${context.subredditName ?? ""}/comments/${postId.replace("t3_", "")}`;
      await reddit.sendPrivateMessageAsSubreddit({
        fromSubredditName: context.subredditName ?? "",
        to: authorName,
        subject: `[FlairGuard] Post removed — ${flairText}`,
        text:
          `Your post **"${postTitle}"** in r/${context.subredditName ?? ""} has been removed.\n\n` +
          `**Reason:** ${rule.removalReason}\n\n` +
          `**Post link:** ${postUrl}\n\n` +
          `---\n*This message was sent automatically by FlairGuard. ` +
          `If you believe this was a mistake, please [contact the moderators](https://www.reddit.com/message/compose?to=%2Fr%2F${encodeURIComponent(context.subredditName ?? "")}).*`,
      });
      actionsTaken.push("modmail");
      console.log(`[FlairGuard] Modmail sent to u/${authorName}.`);
    } catch (e) {
      console.error(`[FlairGuard] Failed to send modmail: ${e}`);
    }
  }

  // ── 5. Auto-Ban ──────────────────────────────────────────────────────────
  if (rule.banDurationDays && rule.banDurationDays > 0) {
    try {
      await reddit.banUser({
        subredditName: context.subredditName ?? "",
        username: authorName,
        duration: rule.banDurationDays,
        message: `You have been temporarily banned for violating community rules.\n\nReason: ${rule.removalReason}`,
        reason: `FlairGuard automated ban: ${flairText}`,
      });
      actionsTaken.push(`banned(${rule.banDurationDays}d)`);
      console.log(`[FlairGuard] Banned u/${authorName} for ${rule.banDurationDays} days.`);
    } catch (e) {
      console.error(`[FlairGuard] Failed to ban user: ${e}`);
    }
  }



  console.log(`[FlairGuard] Done. Actions taken: ${actionsTaken.join(", ")}`);

  // ── 6. Log the action ────────────────────────────────────────────────────
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

  return {};
}

// ─── Menu: Open Settings Dashboard ───────────────────────────────────────────────

async function onMenuOpenSettings(): Promise<UiResponse> {
  // Check if we already have an active settings post
  const existingPostId = await redis.get(SETTINGS_POST_KEY);
  if (existingPostId) {
    try {
      const existingPost = await reddit.getPostById(existingPostId as `t3_${string}`);
      if (existingPost && existingPost.url) {
        return {
          showToast: { text: "⚙️ Opening FlairGuard settings...", appearance: "success" },
          navigateTo: existingPost.url,
        };
      }
    } catch (e) {
      // Post might have been deleted, continue to create a new one
      console.log(`[FlairGuard] Existing settings post not found, creating a new one.`);
    }
  }

  // To render a custom HTML WebView in Devvit, we must spawn a Custom Post
  // This post serves as our "Settings Dashboard" interface for mods.
  try {
    const post = await reddit.submitCustomPost({
      title: "⚙️ FlairGuard — Rules Dashboard (Mods Only)",
      subredditName: context.subredditName ?? "",
      entry: "default",
    });

    // Store the ID so we can reuse it next time
    await redis.set(SETTINGS_POST_KEY, post.id);

    return {
      showToast: { text: "⚙️ Opening FlairGuard settings...", appearance: "success" },
      navigateTo: post.url,
    };
  } catch (e) {
    console.error(`[FlairGuard] Failed to spawn settings post: ${e}`);
    return {
      showToast: { text: "❌ Failed to open settings. Check permissions." },
    };
  }
}

// ─── Menu: View Recent Logs ───────────────────────────────────────────────────

async function onMenuViewLogs(): Promise<UiResponse> {
  const entries = await readLog();
  if (entries.length === 0) {
    return {
      showToast: { text: "📋 FlairGuard: No actions logged yet. Apply a removal flair to get started!", appearance: "neutral" },
    };
  }

  const fmt = (ts: number) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const recent = entries.slice(0, 5);
  const lines = recent
    .map((e) => {
      const actions = e.actionsTaken.join("+");
      const title = e.postTitle.length > 35 ? e.postTitle.slice(0, 35) + "…" : e.postTitle;
      return `[${fmt(e.timestamp)}] ${actions} • "${title}" → ${e.flairText}`;
    })
    .join("\n");

  return {
    showToast: {
      text: `🛡️ FlairGuard — Last ${recent.length} actions:\n${lines}`,
      appearance: "success",
    },
  };
}

// ─── API: Get Rules ───────────────────────────────────────────────────────────

async function getRules(): Promise<GetRulesResponse> {
  console.log(`[BACKEND] getRules() started`);
  try {
    const raw = await redis.get(RULES_KEY);
    console.log(`[BACKEND] getRules() redis returned:`, raw);
    const rules: FlairRule[] = raw ? JSON.parse(raw) : [];
    return { type: "getRules", rules };
  } catch (e) {
    console.error(`[BACKEND] getRules() threw error:`, e);
    throw e;
  }
}

// ─── API: Save Rules ──────────────────────────────────────────────────────────

async function saveRules(req: IncomingMessage): Promise<SaveRulesResponse> {
  const { rules } = await readJSON<SaveRulesRequest>(req);
  await redis.set(RULES_KEY, JSON.stringify(rules));
  console.log(`[FlairGuard] Saved ${rules.length} rules.`);
  return { type: "saveRules", ok: true };
}

async function saveStatus(req: IncomingMessage): Promise<any> {
  const { text } = await readJSON<any>(req);
  
  let postId = await redis.get(STATUS_POST_KEY);
  if (postId) {
    try {
      const post = await reddit.getPostById(postId as `t3_${string}`);
      await post.edit({ text });
      console.log(`[FlairGuard] Updated status post: ${postId}`);
    } catch (e) {
      console.error(`[FlairGuard] Failed to edit status post, creating new one:`, e);
      postId = null;
    }
  }

  if (!postId) {
    const post = await reddit.submitCustomPost({
      title: "📢 Community Status & Announcements",
      subredditName: context.subredditName ?? "",
      entry: "default", // We'll just use the same dashboard UI but it will show the status
    });
    // For a text post, we would use submitPost, but user asked for a status post.
    // Let's use a standard text post for maximum visibility
    const textPost = await reddit.submitPost({
      title: "📢 Community Status & Announcements",
      subredditName: context.subredditName ?? "",
      text: text || "Welcome to our community! Status updates will appear here.",
    });
    await textPost.sticky();
    postId = textPost.id;
    await redis.set(STATUS_POST_KEY, postId);
    console.log(`[FlairGuard] Created and stickied new status post: ${postId}`);
  }

  return { ok: true, postId };
}

// ─── API: Get Logs ────────────────────────────────────────────────────────────



async function getLogs(): Promise<GetLogsResponse> {
  return {
    type: "getLogs",
    entries: await readLog(),
  };
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function interpolateTemplate(
  template: string,
  vars: { author: string; subreddit: string; title: string; flair: string }
): string {
  return template
    .replace(/\{\{author\}\}/g, vars.author)
    .replace(/\{\{subreddit\}\}/g, vars.subreddit)
    .replace(/\{\{title\}\}/g, vars.title)
    .replace(/\{\{flair\}\}/g, vars.flair);
}

function buildRemovalComment(
  reason: string,
  flairText: string,
  postTitle: string,
  authorName: string,
): string {
  const subreddit = context.subredditName ?? "";
  // Replace template variables in the removal reason
  const interpolated = interpolateTemplate(reason, {
    author: authorName,
    subreddit,
    title: postTitle,
    flair: flairText,
  });
  return (
    `**[Removed by FlairGuard — ${flairText}]**\n\n` +
    `${interpolated}\n\n` +
    `---\n*This action was performed automatically. If you believe this was a mistake, please [message the moderators](https://www.reddit.com/message/compose?to=%2Fr%2F${encodeURIComponent(subreddit)}).*`
  );
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
