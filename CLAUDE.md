# Clearway AI — Retell voice agents + SMS bridge

## What this is

AI phone receptionist for tradie businesses, built on Retell. Two live pilot
agents answer real calls, triage emergency vs. routine, and capture
name/problem/postcode. A Node/Express bridge service receives Retell's
post-call webhook and texts/emails the tradesperson the enquiry.

## The two live agents (real testers call these numbers — treat both as production)

| Agent | Trade | Live number | Retell agent_id |
|---|---|---|---|
| Katie | Plumbing (Hartley Plumbing & Heating) | 07898 115981 | `agent_6432fcbb1bbad5b60697ff504d` |
| Ellie | Electrical (Shay's Electrics) | 07575 659157 | `agent_734fa316429c74d8d463c84c27` |

The Retell API key in `.env` is **not scoped to a single agent** — it can
modify both. Always confirm with the user which agent (Katie/Ellie) is being
edited before publishing anything, and show the diff first.

## Repo layout

- `server.js` — Express webhook receiver (`/webhook/retell`), `/health` liveness check
- `lib/enquiry.js` — pure logic: parses Retell's `call_analyzed` payload into SMS/email content (unit tested)
- `lib/customers.js` — pure `findCustomer(customers, toNumber, agentId)` lookup (unit tested)
- `config/customers.json` — maps each Twilio number (or agent_id) → tradesperson's SMS/email contact. `DEFAULT` catches anything unmapped.
- `prompts/katie-hartley-plumbing.md`, `prompts/ellie-shays-electrics.md` — **mirrors** of each agent's live Retell prompt. Editing the `.md` file does NOT change the live agent — it must be pushed into Retell separately (see Publishing below), then the file re-saved to match.
- `AGENT_TEMPLATE.md` — reusable template + platform gotchas for onboarding a new trade's agent.
- `scripts/send-test.js` — posts synthetic `call_analyzed` payloads (`npm run test:webhook[:urgent|:partial]`) to test the bridge without a real call.
- `test/` — `node --test` unit + integration tests (`npm test`).

## Publishing a prompt change to Retell (manual, not scripted yet)

Retell's flow for updating a live agent's prompt:
1. `POST /create-agent-version/{agent_id}` with `{"base_version": N}` — branches a new draft from the currently published version.
2. `update-retell-llm` on that draft's `llm_id` — pushes the new prompt text.
3. `POST /publish-agent-version/{agent_id}` with `{"version": N}` — makes it live.

**Published versions are immutable** — every edit requires branching a new draft first. `/publish-agent` (no version) is deprecated; always use the versioned endpoint. Known `llm_id`s (may change if re-branched): Katie `llm_82cde23122cf4e3ea975bc95a671`, Ellie `llm_f918ca97d075e9cb9a335acc9987` — re-verify via `get-agent` before publishing since these can drift.

Boosted keywords have roughly a 100-word cap — see AGENT_TEMPLATE.md for the full gotcha list.

## Testing approach

1. **Unit/integration tests** (`npm test`) — logic layer only (SMS formatting, postcode/urgency parsing, customer lookup). Fast, safe, no live calls.
2. **Synthetic webhook payloads** (`npm run test:webhook*`) — exercises the bridge end-to-end without a real call.
3. **Pull real call transcripts** via Retell's `list-calls` API (`agent_id` filter) — cheap regression check against calls that already happened; no new call needed.
4. **Real test calls** — the most realistic, but slow and manual. Reserved for verifying conversational/prompt behavior (tone, wrong-trade detection, interruption handling) that can't be tested at the code layer.

Conversation-level bugs (leaking emergency criteria, cutting callers off, wrong-trade handling, tone) live entirely in the Retell prompt/agent config — they are NOT caught by `npm test`. Only real calls or Retell's chat-simulation API can catch those.

## Known non-prompt issues (agent config, not fixable by editing the `.md` files)

- **Interruption sensitivity** — Ellie's `interruption_sensitivity` was 0.8 (high) as of the last check; caller cut-offs were observed on real calls. This is a Retell agent-level setting, not prompt text.
- **Voice/accent drift mid-call** — observed on Ellie (`voice_id: 11labs-Amy`); appears to be voice-model behavior, not something the prompt controls.

## Deployment

Deployed on Railway (`clearway-retell-sms-bridge-production.up.railway.app`, per both agents' `webhook_url`). **As of the last check this URL returned Railway's "Application not found" on every route** — the deployed service was down, meaning no SMS/email would reach the tradesperson regardless of call quality. Re-verify `GET /health` before assuming the bridge is live; this repo has no Railway CLI/config checked in, so redeploying requires dashboard/CLI access outside this session.

## Secrets

`.env` is gitignored — never commit it. Retell API key and agent IDs are stored there (agent IDs aren't secret, just kept local for convenience). Twilio/Resend credentials are placeholder/example values until the user provides real ones.
