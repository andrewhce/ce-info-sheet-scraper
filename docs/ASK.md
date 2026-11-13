# The Ask page (AI assistant)

A chat inside the dashboard. You ask a question about the schools in plain English; it looks things up in what is already saved
(the scraper's findings and your sheet) and answers with the source shown. It is a **prototype**: it only reads, and it only
knows the School Info Sheet data (plus the web, if you switch web search on).

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

- It has six tools: how much is scraped, find a school, everything saved about one school, list findings (differs, can fill,
  matches), prepare a scrape button, prepare a Google Sheet file button.
- **Nothing is changed without your click.** There is no tool that writes, sends, publishes or deletes. A scrape or a Google Sheet
  file is only ever offered as a button; the button runs the same dashboard action as the page that already exists.
- Every fact it gives comes from a tool result, with the website page and quote, and the confidence. If a tool finds nothing it
  says so. It is told never to answer a school fact from memory.
- Web page text is treated as data. A school page that says "ignore your instructions" is just text in a quote.
- It cannot see anything else at Cardinal (marketing, leads, tutoring, HR) yet, and it says so.
- It can search the web, but only if you switch that on (see "Web search" below).

## Web search (Claude only, off by default)

In **AI settings**, tick **Let the assistant search the web** and Save. A "Web search on" tag then shows above the chat.

- **What it is for:** a school that has not been scraped yet, or something that is not on a school's own website. If the saved data has
  the fact, the assistant is told to use that, not the web.
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

## What it records

Every question and answer, the tools it used and the estimated cost are appended to `data/agent-log.jsonl`, and every call to
`data/agent-usage.jsonl`. Keys are never written there. Use the log to review mistakes (it is the start of an accuracy test).
Conversations live in memory and start fresh when the dashboard restarts; **New chat** clears one.

## On a server (online)

Keys and the cap are set with environment variables and cannot be changed from the page (anyone who signs in could otherwise
swap the company key): `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `ASK_PROVIDER` (`anthropic` or `groq`), `ASK_MODEL`,
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

`src/agent/`: `index.js` (conversations, settings, one question at a time), `agent.js` (the loop: ask the AI, run the tools it
picks, hand the results back, repeat up to 8 rounds), `tools.js` (the six read-only tools), `providers.js` (Claude and Groq behind one
shape; the conversation is kept in Claude's message format), `prompt.js` (the standing instructions), `settings.js`, `usage.js`.
The server streams a question's progress to the page one JSON line at a time (`POST /api/ask`). `tests/agent.test.js` checks all of
it with stand-ins for the AI services, so it needs no key.

Claude calls use the `claude-opus-5-5` model by default with `output_config.effort: "medium"`, adaptive thinking left on, and the
server-side **fallback** option switched on (if the safety filter declines a request, the API retries it on a substitute model
inside the same call). Switch it off by setting `"fallbacks": false` in `data/agent-settings.json`.
