// Safety net: don't let an unexpected error (like a socket-mode edge case)
// take down the whole process. Log it and keep running - Slack's client
// will handle its own reconnection internally in newer @slack/bolt versions.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (process staying alive):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (process staying alive):", err);
});

require("dotenv").config();
const { App } = require("@slack/bolt");
const { searchWorkspace } = require("./rts");
const { expandQuery, synthesizeAnswer } = require("./synthesize");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

function dedupeResults(resultLists) {
  const seen = new Map();
  for (const list of resultLists) {
    for (const r of list) {
      // Skip messages that are just @mentions of the bot itself - these are
      // your own test questions, not real content, and they pollute results
      if (/<@[A-Z0-9]+>/.test(r.content)) continue;

      const key = `${r.channelId}-${r.ts}`;
      if (!seen.has(key)) seen.set(key, r);
    }
  }
  return [...seen.values()];
}

// Sets the "thinking..." status shown in the Assistant panel / thread.
// Safe to call even outside the native Assistant container - it's a no-op
// error we just swallow if it's not supported in this context.
async function setStatus(client, channel, thread_ts, status) {
  try {
    await client.apiCall("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts,
      status,
    });
  } catch (e) {
    // not fatal - just means status UI isn't available here
  }
}

function buildAnswerBlocks(answer) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: answer },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: "React 👍 or 👎 to help improve future answers" },
      ],
    },
  ];
}

app.event("app_mention", async ({ event, client, say }) => {
  const { channel, ts: thread_ts } = event;

  try {
    const question = event.text.replace(/<@[^>]+>/g, "").trim();

    if (!event.action_token) {
      await say({ text: "No action_token on this event.", thread_ts });
      return;
    }

    if (question.includes("check-search-info")) {
      const info = await client.apiCall("assistant.search.info", {
        action_token: event.action_token,
      });
      await say({ text: "```" + JSON.stringify(info, null, 2) + "```", thread_ts });
      return;
    }

    if (!question) {
      await say({ text: "Ask me something, e.g. `@tribal-bot how do we handle X?`", thread_ts });
      return;
    }

    await setStatus(client, channel, thread_ts, "searching workspace history...");

    // 1. Expand into keyword-style variants since RTS is keyword-only here
    const queries = await expandQuery(question);
    console.log("Expanded queries:", queries);

    // 2. Search RTS with each variant, merge + dedupe
    let merged;
    try {
      const resultLists = await Promise.all(
        queries.map((q) => searchWorkspace(client, { query: q, actionToken: event.action_token }))
      );
      merged = dedupeResults(resultLists);
    } catch (err) {
      if (err.isRateLimit) {
        await setStatus(client, channel, thread_ts, "");
        await say({ text: "Hit a rate limit searching workspace history, give it a moment and try again.", thread_ts });
        return;
      }
      throw err;
    }

    if (merged.length === 0) {
      await setStatus(client, channel, thread_ts, "");
      await say({ text: `No matches found for: "${question}" (tried: ${queries.join(", ")})`, thread_ts });
      return;
    }

    await setStatus(client, channel, thread_ts, "synthesizing an answer...");

    // 3. Synthesize a direct answer with citations
    const answer = await synthesizeAnswer(question, merged);

    await setStatus(client, channel, thread_ts, "");

    const posted = await say({
      text: answer, // fallback text for notifications
      blocks: buildAnswerBlocks(answer),
      thread_ts,
    });

    // Pre-seed reactions so feedback is one tap, not "type an emoji"
    try {
      await client.reactions.add({ channel, timestamp: posted.ts, name: "+1" });
      await client.reactions.add({ channel, timestamp: posted.ts, name: "-1" });
    } catch (e) {
      // non-fatal
    }
  } catch (err) {
    console.error("Agent error:", err);
    await setStatus(client, channel, thread_ts, "");
    await say({ text: `Something broke: ${err.message}`, thread_ts });
  }
});

// Basic feedback logging - swap this for real storage (DB, sheet, etc)
// once past the demo stage.
app.event("reaction_added", async ({ event }) => {
  if (event.reaction === "+1" || event.reaction === "-1") {
    console.log(`Feedback: ${event.reaction} on ${event.item.ts} from ${event.user}`);
  }
});

(async () => {
  await app.start();
  console.log("⚡ Tribal Knowledge Agent is running");
})();
