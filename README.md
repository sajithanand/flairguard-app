# 🛡️ FlairGuard

> **Automated flair-triggered moderation for Reddit** — built for the Reddit Mod Tools & Migrated Apps Hackathon on the Devvit platform.

---

## What is FlairGuard?

FlairGuard is a Reddit mod tool that **automatically enforces moderation actions the moment a moderator applies a removal flair** to a post. It eliminates the most repetitive part of moderating — typing the same removal reason over and over.

### The Problem

Moderators of large subreddits remove hundreds of posts every day. For each removal they must:
1. Click "Remove"
2. Open a document and copy a removal reason
3. Paste it as a comment
4. Lock the thread (if applicable)
5. Repeat 100+ times per day

### The Solution

FlairGuard turns flair application into a **one-click workflow**:

```
Mod applies "Rule 1 – Spam" flair
        ↓
FlairGuard detects the PostFlairUpdate event
        ↓
✅ Post auto-removed
✅ Templated removal reason posted as comment
✅ Thread optionally locked
✅ Author optionally notified via modmail
✅ Action logged to Redis for mod review
```

---

## Features

| Feature | Description |
|---|---|
| **Flair-triggered removal** | Configurable flair names map to automatic removal actions |
| **Templated comments** | Custom removal reason text per flair, supports Markdown |
| **Thread locking** | Optionally lock the thread when removing |
| **Modmail notification** | Optionally send the author a private message with the reason |
| **Settings dashboard** | Mods configure rules via web UI — no code needed |
| **Action log** | Last 50 actions stored in Redis, viewable from mod menu |
| **Deduplication** | Redis-based dedup prevents duplicate actions |
| **Welcome onboarding** | Modmail sent on first install with setup instructions |

---

## How to Use

### 1. Install FlairGuard on your subreddit
Install from the [Reddit Developer Platform](https://developers.reddit.com).

### 2. Create removal flairs in your subreddit
Go to `r/yoursubreddit` → Mod Tools → Post Flair → create flairs like:
- `Rule 1 - Spam`
- `Rule 2 - Off Topic`
- `Rule 3 - Self Promotion`

### 3. Configure FlairGuard rules
Open the subreddit mod menu → click **⚙️ FlairGuard: Configure Rules**

For each flair, set:
- **Flair text** — must match exactly (case + dash insensitive)
- **Removal reason** — Markdown supported, shown as a comment
- **Auto-remove** — toggle
- **Lock thread** — toggle
- **Notify via modmail** — toggle

### 4. Done!
When any mod applies a configured removal flair, FlairGuard handles everything automatically within seconds.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Platform | Devvit Web (Reddit Developer Platform) |
| Language | TypeScript |
| Persistence | Redis KV |
| API | Reddit Data API |
| Trigger | `onPostFlairUpdate` event |
| UI | Vanilla HTML/CSS/JS settings dashboard |

---

## Architecture

```
Mod applies flair on Reddit UI
        │
        ▼
Devvit Runtime → POST /internal/triggers/post-flair
        │
        ▼
onPostFlair()
    ├── Redis dedup check
    ├── Load rules from Redis
    ├── Match rule (case + dash insensitive)
    ├── reddit.remove(postId)
    ├── reddit.submitComment(removalReason)
    ├── reddit.lock(postId)              ← optional
    ├── reddit.sendPrivateMessage(...)   ← optional modmail
    └── appendLog(entry) → Redis
```

---

## Port Completion

FlairGuard ports the classic **PRAW flair-action bot** pattern to native Devvit.

| Aspect | PRAW Bot | FlairGuard (Devvit) |
|---|---|---|
| **Hosting** | External VPS/server | Zero infrastructure |
| **Auth** | Manual OAuth, token refresh | Handled by Devvit |
| **Rate limiting** | Manual implementation | Devvit runtime |
| **Persistence** | External DB | Built-in Redis KV |
| **Configuration** | Edit Python + redeploy | Web settings dashboard |
| **Installation** | Clone repo + configure .env | One-click install |
| **Monitoring** | External logging | Built-in mod menu log viewer |

---

## Moderator Permissions & Security

To protect community settings and log data, FlairGuard enforces granular, role-based moderator checks:

* **Subreddit Configuration (`config` or `all` permission)**: Only moderators with the `config` or `all` permission are allowed to access and edit FlairGuard rules (`GetRules`, `SaveRules`, `SaveStatus`) or clear audit logs (`ClearLogs`).
* **Moderation Audit (`posts` or `all` permission)**: Viewing audit logs (`GetLogs`) or using the log dashboard requires the `posts`, `config`, or `all` moderator permissions.
* **Menu Restriction**: Menu items are configured using `"forUserType": "moderator"`. The backend additionally verifies permission levels on every request to block unauthorized API access.

---

## Project Status

- ✅ Core flair trigger (confirmed live)
- ✅ Auto-removal
- ✅ Templated removal comments
- ✅ Thread locking
- ✅ Modmail notification
- ✅ Redis action logging
- ✅ Settings dashboard UI
- ✅ Mod menu log viewer
- ✅ Deduplication
- ✅ Welcome onboarding modmail

---

Built by u/Exact-Cut-637 for the [Reddit Mod Tools & Migrated Apps Hackathon](https://mod-tools-migration.devpost.com/) (May 2026).
