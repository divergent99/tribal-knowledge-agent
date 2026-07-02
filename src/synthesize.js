const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

async function callClaude({ system, messages, maxTokens = 1024 }) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/**
 * RTS is keyword-only on most sandboxes (no semantic search), so a natural
 * question like "how do we handle rate limiting?" won't match messages that
 * say "429s" or "backoff" - no literal overlap. This expands one question
 * into several keyword-style search queries that are more likely to hit.
 */
async function expandQuery(question) {
  const system = `You turn a natural-language question into 3 short keyword search queries
for a literal keyword search engine (no semantic matching, only stemming).
Think about the different words people might actually use when discussing this topic in chat.
Respond with ONLY a JSON array of 3 strings, nothing else. No markdown, no preamble.
Example: ["payments API rate limiting", "429 backoff retry", "queue rate limiter"]`;

  const raw = await callClaude({
    system,
    messages: [{ role: "user", content: question }],
    maxTokens: 200,
  });

  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch (e) {
    console.error("Failed to parse query expansion, falling back to raw question:", raw);
  }
  return [question]; // fallback: just use the original question
}

/**
 * Synthesizes a direct answer from merged RTS results, with citations back
 * to permalinks, and flags conflicting/stale info instead of picking one
 * answer silently.
 */
async function synthesizeAnswer(question, results) {
  if (results.length === 0) {
    return `No relevant messages found for: "${question}"`;
  }

  const context = results
    .map(
      (r, i) =>
        `[${i + 1}] (${new Date(parseFloat(r.ts) * 1000).toISOString().slice(0, 10)}) ${r.content}\npermalink: ${r.permalink}`
    )
    .join("\n\n");

  const system = `You answer questions using only the Slack messages provided as context.
Rules:
- Cite sources inline using [1], [2] etc matching the numbered context.
- If sources conflict or the answer changed over time, say so explicitly - don't silently pick one.
- Each context message has a date. If the most recent relevant message is more than 60 days old relative to today (${new Date().toISOString().slice(0, 10)}), explicitly flag it as potentially outdated and suggest confirming with the team.
- If the context doesn't actually answer the question, say that plainly.
- Be concise. This is a Slack reply, not a report.`;

  const answer = await callClaude({
    system,
    messages: [
      {
        role: "user",
        content: `Question: ${question}\n\nContext:\n${context}`,
      },
    ],
    maxTokens: 500,
  });

  // Renumber citations sequentially in order of first appearance (1, 2, 3...)
  // instead of using raw context-list index, which can jump around (e.g. [1]
  // then [17]) once the merged result list grows across many test queries.
  const citedInOrder = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = parseInt(m[1], 10);
    if (!citedInOrder.includes(n)) citedInOrder.push(n);
  }
  const renumberMap = new Map(citedInOrder.map((old, i) => [old, i + 1]));

  const renumberedAnswer = answer.replace(/\[(\d+)\]/g, (full, num) => {
    const n = parseInt(num, 10);
    return renumberMap.has(n) ? `[${renumberMap.get(n)}]` : full;
  });

  const sourceList = citedInOrder
    .filter((n) => results[n - 1])
    .map((n) => `[${renumberMap.get(n)}] <${results[n - 1].permalink}|source>`)
    .join("  ");

  return `${renumberedAnswer}\n\n${sourceList}`;
}

module.exports = { expandQuery, synthesizeAnswer };