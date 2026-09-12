# Call & issue tracking log

Living record of test calls investigated, the issues they surfaced, and
current fix status. Updated as we go — not a static reference like
CLAUDE.md. Call IDs/transcripts are pulled from Retell's `list-calls` API
(see CLAUDE.md's Testing approach) rather than re-typed from memory.

## Status key
🔴 open — not yet addressed · 🟡 drafted — prompt/code change made, not published/tested live · 🟢 verified — confirmed fixed on a real call

---

## Ellie (electrical, 07575 659157 / `agent_734fa316429c74d8d463c84c27`)

### Issues, by source

| Issue | First seen | Status | Notes |
|---|---|---|---|
| Took plumbing job details instead of redirecting | User's call notes (undated) | 🟡 drafted | Wrong-trade check strengthened in `prompts/ellie-shays-electrics.md` — not yet published |
| Revealed emergency-criteria list under pressure | User's call notes | 🟡 drafted | Deflection hardened in prompt — not yet published |
| Sounded annoyed on postcode repeat | User's call notes | 🟡 drafted | Tone guidance added to prompt — not yet published |
| Cuts caller off mid-sentence | User's call notes; reproduced in `call_571bd783e3f58555eff38cc6441` | 🔴 open | Agent-config issue (`interruption_sensitivity` was 0.8), not prompt-fixable. Awaiting user decision to lower it. |
| Accent changes mid-call | User's call notes | 🔴 open | Voice-model behavior (`11labs-Amy`), no clear fix path identified yet |
| Ended call while caller was correcting a bad postcode read-back | `call_571bd783e3f58555eff38cc6441` (149s, most recent as of pull) | 🔴 open | New finding, not yet folded into prompt edits. Caller said "894432" (invalid), agent read it back and closed the call while caller was saying "that's not a real postcode" |
| Possible SMS confirmation-to-caller feature | User's call notes ("potential text reminder?") | 🔴 open — needs scoping | Not a bug; a feature idea, undecided whether in scope |

### Calls reviewed
- Pulled last 10 calls via `list-calls` filtered to Ellie's agent_id — full transcripts saved to `ellie_call_transcripts.txt` and sent to user (not committed to git — contains real caller phone numbers/PII, keep out of the repo).
- Most recent (`call_571bd783e3f58555eff38cc6441`) reviewed in detail above; other 9 not yet individually triaged.

## Katie (plumbing, 07898 115981 / `agent_6432fcbb1bbad5b60697ff504d`)

No issues reported yet. No prompt edits made. Calls not yet pulled/reviewed.

---

## Bridge service / infra

| Issue | First seen | Status | Notes |
|---|---|---|---|
| Deployed Railway service unreachable (`Application not found` on all routes) | This session, checked via direct curl | 🔴 open | Blocks all SMS/email delivery regardless of call quality. Needs user/Luke to check Railway dashboard — see CLAUDE.md Deployment section |

---

## How to update this file

When a new test call happens or a fix gets published: pull the relevant
call transcript, add/update the row, move status forward (🔴→🟡→🟢), and
note the call_id it was verified against. Keep PII (phone numbers,
transcripts) out of git — reference call_ids and summaries only, send full
transcripts to the user as files instead of committing them.
