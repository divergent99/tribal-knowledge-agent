# Tribal Knowledge Agent

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Slack Bolt](https://img.shields.io/badge/Slack-Bolt%20SDK-4A154B?logo=slack&logoColor=white)](https://slack.dev/bolt-js)
[![Claude API](https://img.shields.io/badge/Claude-API-D97757?logo=anthropic&logoColor=white)](https://www.anthropic.com)
[![Socket Mode](https://img.shields.io/badge/Slack-Socket%20Mode-4A154B?logo=slack&logoColor=white)](https://api.slack.com/apis/socket-mode)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Ask a question in Slack, get a synthesized answer pulled from your team's own message history, with citations, conflict detection, and honesty when there's no answer at all.

Built for the [Slack Agent Builder Challenge](https://slackhack.devpost.com/).

## What it does

Mention the bot with a natural-language question and it:

1. Searches the workspace's message history using Slack's **Real-Time Search API**
2. Synthesizes a direct answer with **Claude**, citing exactly which messages it used
3. **Flags conflicts** explicitly instead of silently picking one version if the answer changed over time
4. **Flags stale info** if the most relevant source is over 60 days old
5. Says **"no answer found"** honestly instead of hallucinating one, if the workspace genuinely doesn't have it

```
@tribal-bot how do we handle rate limiting on the payments API?

> The approach evolved: initially handled with exponential backoff + retry
> as a stopgap [1], but that was replaced after retries made throttling
> worse — the team switched to a queue-based approach with a rate limiter
> in front, which has proven more stable [2].
> [1] source  [2] source
```

## Why query expansion exists

Slack's Real-Time Search API supports semantic search, but only on workspaces with Slack AI Search enabled. Most dev sandboxes default to **keyword-only search**, which means a natural question like *"how do we handle rate limiting?"* won't match a message that says *"seeing 429s, going with exponential backoff"* — there's no literal word overlap.

To work around this, every question first goes through Claude to generate 2-3 keyword-style search variants before hitting RTS. Results are merged and deduped across all variants. This is the difference between the bot actually finding relevant history and returning nothing.

## Architecture

```
Slack mention
     │
     ▼
Bolt app (Socket Mode) — captures action_token from the event
     │
     ▼
Claude: expand question into keyword search variants
     │
     ▼
RTS search (assistant.search.context) — one call per variant, parallel
     │
     ▼
Merge + dedupe results, filter out bot's own test mentions
     │
     ▼
Claude: synthesize answer — citations, conflict detection, staleness check
     │
     ▼
Reply to Slack — Block Kit formatting, thinking-status indicator, 👍/👎 reactions
```

## Setup

### 1. Create the Slack app
Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → paste `manifest.json` from this repo → pick your dev workspace.

### 2. Enable Agents & AI Apps
RTS (`assistant.search.context`) requires this feature flag. Find **"Agents & AI Apps"** in your app config sidebar and turn it on. If it's missing, your workspace/plan may not support it — figure this out on day 1, not day 10.

### 3. Install the app and grab tokens
- **Bot token** (`xoxb-...`) from OAuth & Permissions → `SLACK_BOT_TOKEN`
- **App-level token** (`xapp-...`, needs `connections:write` scope, generated under Basic Information → App-Level Tokens) → `SLACK_APP_TOKEN`

### 4. Configure environment
```bash
cp .env.example .env
# fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ANTHROPIC_API_KEY
```

### 5. Install and run
```bash
npm install
npm run dev
```

### 6. Test it
Invite the bot to a channel with some message history, then:
```
@tribal-bot how do we handle rate limiting on the payments API?
```

## Debugging

**No `action_token` on the event** → Agents & AI Apps feature isn't enabled, or event subscriptions aren't wired right.

**Empty results for a reasonable question** → check if your workspace has semantic search:
```
@tribal-bot check-search-info
```
If `is_ai_search_enabled` is `false`, you're in keyword-only mode — this is expected and exactly what query expansion is built to handle.

**Rate limited mid-testing** → RTS has usage limits; the bot handles this gracefully now with a friendly retry message instead of a stack trace.

## Project structure

```
src/
  app.js         # Bolt app, event handling, orchestration
  rts.js         # RTS API wrapper (assistant.search.context)
  synthesize.js  # Query expansion + answer synthesis via Claude
manifest.json    # Slack app manifest (scopes, events)
.env.example     # Token template
```

## Tech stack

- **Node.js** + **Slack Bolt SDK** (Socket Mode)
- **Slack Real-Time Search API** (`assistant.search.context`)
- **Slack Block Kit** for formatted replies
- **Claude API** for query expansion and answer synthesis

## What's next

- Persistent feedback storage (👍/👎 reactions currently just log to console)
- Native Slack Assistant panel UI (`assistant.threads.setSuggestedPrompts`)
- Testing query expansion against a larger, messier real workspace