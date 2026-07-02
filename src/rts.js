/**
 * Thin wrapper around assistant.search.context (the RTS API).
 *
 * Key constraint: this method needs an `action_token`, which is short-lived
 * and only obtainable from a live event payload (app_mention, message.im,
 * message.mpim, message.groups, message.channels). There is no way to call
 * this cold with just a bot token - you MUST be reacting to a real event.
 *
 * Do not store/cache the results this returns - Slack's terms prohibit
 * copying or persisting RTS data. Use it in-request and discard.
 */

async function searchWorkspace(client, { query, actionToken, limit = 20 }) {
  // Using apiCall directly instead of client.assistant.search.context(...)
  // because the bundled @slack/web-api version may not have this newer
  // method typed/exposed yet. apiCall works regardless of SDK version.
  const result = await client.apiCall("assistant.search.context", {
    query,
    action_token: actionToken,
    content_types: ["messages"],
    channel_types: ["public_channel", "private_channel", "mpim", "im"],
    include_context_messages: true,
    include_bots: false,
    limit,
  });

  if (!result.ok) {
    if (result.error === "ratelimited") {
      const err = new Error("rate_limited");
      err.isRateLimit = true;
      throw err;
    }
    throw new Error(`RTS search failed: ${result.error}`);
  }

  const messages = result.results?.messages || [];

  // Normalize to just what we need for synthesis + citations
  return messages.map((m) => ({
    content: m.content,
    author: m.author_user_id,
    isBot: m.is_author_bot,
    channelId: m.channel_id,
    ts: m.message_ts,
    permalink: m.permalink,
  }));
}

module.exports = { searchWorkspace };