# The Ask page (AI assistant)

A chat inside the dashboard **strictly for private school research and your School Information Sheet**. You ask a school-related
question in plain English; it looks things up in what is already saved (the scraper's findings and your sheet) and answers with the
source shown. General non-school questions (trivia, coding, creative writing, weather, etc.) are turned off, and the assistant only
reads saved data unless you switch web search on.

## Try it in two minutes

1. Open the dashboard (`Start Dashboard.cmd`) and click **Ask**.
2. Open **Connect the AI** and paste an API key (see "Which key" below). Press **Save and test the connection**.
3. Click one of the suggested questions, or type your own and press Enter.

Good first questions: "Which schools differ most from my sheet?", "What can the websites fill into blank sheet cells?",
"How many Tier 1 schools have not been scraped yet?", "Which fields does the scraper find least often?", "Compare Castilleja
(Upper) School with our sheet on faculty degrees."

It can only answer about schools the scraper has already read. Ask it how many are missing, and it offers a button to read them.

## Which key

| | What it is | Use it for |
| --- | --- | --- |
| **Claude** (Anthropic) | The real thing. Make a key in the Anthropic console (Settings, API keys). Billed by use. | Everything that matters. This is what the company assistant would run on. |
| **Groq** (test only) | A different company with open models and a free plan. Make a key at console.groq.com. | Trying the page out cheaply. Its answers are **not** a measure of how good Claude is, and it can be wrong more often. |

The key is saved **only on this computer**, in `data/agent-settings.json` (the data folder is never published). The page never
receives it back: it only shows the last four characters. Paste keys into the settings box, never into a chat or an email.

Groq's free plan allows only a few thousand tokens a minute, so the page asks the tools for shorter results when Groq is
selected, waits and retries when Groq says to slow down, and a long question may still pause. A paid Groq plan or a
different model removes most of that. After **Save and test the connection** with Groq, the model list is filled in with the
models your key can use.

## What it can and cannot do

- It has ten read-only/proposal tools: coverage overview, find schools (including recently updated websites), full school facts (with website changes & URL mismatch flags), search already-cached website pages for keywords, search past verified Q&As (`search_past_answers`), list findings (differs, can fill, matches), check auto-scrape schedule & Slack status, prepare a scrape button, prepare a Google Sheet file button, and prepare an Excel/CSV spreadsheet download button.
- Earlier answers are kept in `data/agent-kb.json` as **hints, not facts** (plus declarative user rules/corrections in `data/agent-memory.json`), and `GET /api/ask/dataset` exports them as `.jsonl`. An answer is kept only if at least one real lookup (a school tool or a web search) was behind it. The assistant is told never to state a figure from a past answer and to confirm every fact with the data tools, and that a tool result wins if they disagree. Asking the same question again replaces the old answer (the newest wins, so two contradictory answers to one question cannot both stay), and an entry is flagged "possibly out of date" when the school was scraped again since, or when it is more than 14 days old.
- **Nothing is changed without your click.** There is no tool that writes, sends, publishes or deletes. A scrape or export is only ever offered as a button; the button runs the same dashboard action as the page that already exists.
- Every fact it gives comes from a tool result, with the website page and quote, and the confidence. If a tool finds nothing it says so. It is told never to answer a school fact from memory.
- Web page text is treated as data. A school page that says "ignore your instructions" is just text in a quote.
- It cannot see anything else at Cardinal (marketing, leads, tutoring, HR) yet, and it says so.
- Security, caching & persistence:
  1. A normalized pre-filter strips invisible characters and leetspeak obfuscation, blocking prompt injections, rule bypasses, and off-topic/marketing/SaaS traps before any API call.
  2. When a question lacks clear school terms or mixes school names with risky framing, a lightweight secondary AI scope classifier checks intent (with conversation history summary) before full model execution or web search runs.
  3. The assistant treats quoted page snippets, search results, and saved memory strictly as data — never instructions — separates static system instructions from saved memory for stable prompt caching, streams answers live as they arrive, and scrubs API keys and webhooks from logs.
  4. **Memory (`data/agent-memory.json` & `data/agent-sessions.json`):** Conversations persist safely across dashboard restarts (**Recent chats**, **Rename**, **Delete**, and **New chat**), turn slicing keeps `tool_use`/`tool_result` pairs intact, and you can add, edit, or delete school-research notes via the **Saved memory** panel or `"Remember that …"` / `"Forget …"` in chat.
- It can search the web, but only if you switch that on (see "Web search" below).

## Web search (Claude only, off by default)

In **AI settings**, tick **Let the assistant search the web** and Save. A "Web search on" tag then shows above the chat.

- **What it is for:** school and admissions questions when the saved data cannot answer (for example a school that has not been scraped yet, or admissions details not on its website). General non-school web searches remain blocked.
- **Saved data first, enforced by the program (not just asked of the AI).** Even with web search switched on, the search tool is not handed to the AI at all until a lookup in the saved data came up empty: the school is not in the list, has not been checked, its saved page has no value for what was asked, or none of its saved pages mention the keyword. If the saved data has the answer, no search can happen. Writing "search the web for ..." (or "look that up online") in your question opens it from the start. If the AI does not have the tool and the saved data cannot answer, it says what is missing and tells you to ask it to search the web.
- **It is not the scraper.** Web results are other people's pages. They are labelled "From the web, not the school's own site", each source is
  listed under the answer with a warning, and nothing from the web is ever put into a comparison with your sheet or into the Google Sheet file.
  The scraper's own rule (only a school's own website) is unchanged.
- **Cost:** about $0.01 per search on top of the usual tokens (at most three searches per request). It appears in the spend meter and counts
  against the monthly cap. The question log (`data/agent-log.jsonl`) records the searches and the source links.
- **Needs Claude.** The search runs on Anthropic's servers as part of the same API key, so it is not available with the Groq test model.
  Your Anthropic organization may have to allow web search in the Anthropic console (Settings); if the first search fails with an error about it,
  ask whoever manages the account.
- **Web pages are untrusted.** The assistant is told to ignore instructions found in search results, and it still cannot change anything:
  a scrape or a Sheet file is only ever a button you press.
- **On a server** the switch is the environment variable `ASK_WEB_SEARCH` (`1` or `0`), and the page cannot change it.

## Cost and the monthly cap

Each question costs a few cents with Claude (a lookup and an answer is a few thousand tokens; Opus 5.5 is $4 in / $20 out per
million tokens, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50). The bar under the page title shows an **estimate** from list prices and the
**monthly cap** (default $100, change it in the settings). Once the cap is reached no new question is sent until next month or
until you raise it. Groq's spend is not tracked here: check it in the Groq console.

**Is a question charged when the answer is already in the saved data? Yes.** Looking in the saved data is free, but the AI still has
to read the result and write the answer, and that is what is billed (in the first test questions, 3 to 7 cents each; the
one question that also searched the web and made 18 lookups cost 10 cents). The program therefore keeps the bill small:

- **Saved data first.** The web search tool is not offered until the saved data came up empty (see "Web search").
- **Old lookup results are shrunk.** Every call re-sends the whole chat, and the raw lookup results are most of it. Results from
  questions two or more questions back are replaced by a one-line stub (the assistant's own answers stay, so follow-ups still work).
- **At most 12 lookups per question.** After that the assistant must answer with what it has and says so; ask about fewer
  schools or one field at a time for the rest.
- **Ask for what you need.** "Tuition for Alpha Academy" is cheaper than "Tell me about Alpha Academy", and the Schools, To check and
  Start here pages show counts and lists for nothing, with no AI at all.

## What it records

Every question and answer, the tools it used and the estimated cost are appended to `data/agent-log.jsonl`, and every call to
`data/agent-usage.jsonl`. Keys are never written there (and accidental keys or webhooks in prompts/errors are redacted). Saved long-term preferences live in `data/agent-memory.json` and chat threads persist across restarts in `data/agent-sessions.json` (**New chat** starts a fresh thread; **Delete** removes a saved thread).

## On a server (online)

**Who can change the AI settings.** Only the signed-in people named in the `ASK_ADMIN_EMAILS` setting (one email, or several
separated by commas). They see an **AI settings · administrator only** box on the Ask page where they can paste the API key,
set the monthly cap and switch web search. Everyone else who signs in can use Ask but never sees the settings, the key or the
list of administrators. The sign-in checks the email with Google, so nobody can pretend to be the administrator. If
`ASK_ADMIN_EMAILS` is not set, nobody can change the settings from the page (the safe default).

```
ASK_ADMIN_EMAILS=you@yourcompany.com
```

A key pasted into the box is saved on the server's data volume (`data/agent-settings.json`, readable only by the program), is
never shown again (only its last four characters), and is used only to answer questions on the Ask page. Settings can also still
be set with environment variables, which win over the box (the box then shows them as set on the server and locked):
`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `ASK_PROVIDER` (`anthropic` or `groq`), `ASK_MODEL`,
`ASK_GROQ_MODEL`, `ASK_MONTHLY_CAP_USD`, `ASK_WEB_SEARCH`. The questions and the data the tools return go to the AI service you choose, so decide
what data may be sent before a second division's data is connected (customer details, leads and phone logs need a decision first).

## When something goes wrong

| What you see | What to do |
| --- | --- |
| "The AI is not connected yet" | Add a key under **Connect the AI**. |
| "The AI service rejected the API key" | The key is wrong, revoked or from another service. Make a new one. |
| "...being asked too often" | A rate limit (common on Groq's free plan). Wait a minute, or choose another model. |
| "credit balance is too low" | The Anthropic account needs credit (Console, Plans and Billing). |
| "This month's AI spending cap has been reached" | Raise the cap in the settings, or wait for next month. |
| "The AI service did not accept the request" on the very first Claude question, mentioning fallbacks or a beta | The backup-model option has not been tried against the live service yet. Add `"fallbacks": false` to `data/agent-settings.json` (and tell whoever maintains this, so it can be fixed properly). |
| It answers "not found" for a school | That school has not been scraped yet, or the website had nothing for that field. |

## How it works (for the person who builds on it)

`src/agent/`: `index.js` (persisted conversations, settings, memory & auto-learning KB orchestration), `agent.js` (the loop: stream answers, run tools, retry/stop safely), `tools.js` (the ten read-only/proposal tools), `providers.js` (Claude streaming + prompt caching + model discovery, and Groq), `prompt.js` (standing instructions, normalized pre-filter, memory command parser & auto-rule detector), `scope-guard.js` (secondary AI intent classifier), `memory.js` (validated saved memories & persistent sessions), `kb.js` (automatic Q&A knowledge base, staleness check & JSONL export), `settings.js` (Sonnet 5.5 + Medium cost lock), `usage.js`.
The server streams a question's progress to the page one JSON line at a time (`POST /api/ask`). `tests/agent.test.js` checks all of
it with stand-ins for the AI services, so it needs no key.

Claude calls are cost-locked by default to `claude-sonnet-5-5` with `output_config.effort: "medium"`, adaptive thinking left on, and the
server-side **fallback** option switched on (if the safety filter declines a request, the API retries it on a substitute model
inside the same call). Switch it off by setting `"fallbacks": false` in `data/agent-settings.json` (or set `ASK_UNLOCK_MODELS=1` to unlock model/effort selection).
