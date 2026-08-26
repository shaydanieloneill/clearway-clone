# Clearway AI — Retell → SMS Bridge

After every call your Retell voice agent handles, this service texts the
tradesperson the enquiry details (name, number, postcode, job, urgency) and
sends a fuller backup email. It logs every call to `logs/calls.jsonl`.

**How it works:** Retell finishes analysing a call → fires a `call_analyzed`
webhook at this service → the service looks up which tradesperson owns the
dialled Twilio number (`config/customers.json`) → sends the SMS via Twilio and
the email via Resend.

**Building a new trade's agent (electrician, joiner, etc.)?** See
[AGENT_TEMPLATE.md](AGENT_TEMPLATE.md) — the reusable prompt template plus a
step-by-step guide, distilled from everything found and fixed through real
call testing on the plumbing demo agent.

**Editing a live agent's actual prompt?** The current live prompt text for
each agent is mirrored in [`prompts/`](prompts/) (`katie-hartley-plumbing.md`,
`ellie-shays-electrics.md`) — these are plain text files, editable via a
normal PR, so anyone with repo access can propose wording changes without
needing the Retell API key. **They're a mirror, not the source of truth** —
editing the `.md` file alone does NOT change the live agent. Whoever has the
Retell API key needs to push the updated text into Retell (`create-agent-version`
→ `update-retell-llm` → `publish-agent-version`, see AGENT_TEMPLATE.md's
"Known platform gotchas") and then re-save the file here so it matches what's
actually live again.

---

## 1. Environment variables

Copy `.env.example` to `.env` locally, or enter these in your hosting
platform's "Variables" screen when deploying:

| Variable | Where to find it |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Console home page → "Account Info" box (starts `AC`) |
| `TWILIO_AUTH_TOKEN` | Same box, click "Show" |
| `TWILIO_FROM_NUMBER` | Your Twilio UK number in `+44...` format (Console → Phone Numbers → Manage → Active Numbers) |
| `RESEND_API_KEY` | resend.com → API Keys → Create (starts `re_`) |
| `RESEND_FROM_EMAIL` | e.g. `Clearway AI <alerts@aiclearway.com>` — the domain must be verified in Resend (Domains → Add Domain, add the DNS records they show you). Until then, `onboarding@resend.dev` works for testing. |
| `RETELL_API_KEY` | Retell dashboard → API Keys. Used to verify webhooks are genuinely from Retell. Leave blank only for local testing. |
| `TEST_SECRET` | Any random string you invent. Lets the test script bypass signature checks. |
| `DRY_RUN` | `true` = log instead of actually sending (safe testing). `false` for live. |

## 2. Point Retell at this service

1. Log in to the Retell dashboard.
2. Open your agent (the plumber-answering agent).
3. Find the **Webhook** setting (on the agent's settings panel — Retell calls it
   "Webhook URL" at agent level; there is also an account-level webhook under
   account settings, either works).
4. Paste your deployed URL followed by the path:
   `https://YOUR-APP-URL/webhook/retell`
5. Save. Retell will now send `call_started`, `call_ended` and `call_analyzed`
   events to that URL — the service ignores everything except `call_analyzed`.

### Make sure the agent captures the right fields

The SMS is built from your agent's **Post-Call Analysis** fields. In the Retell
dashboard, open your agent → **Post-Call Analysis** tab → add these (names
matter — use exactly these, lowercase with underscores):

| Field name | Type | Description to give Retell |
|---|---|---|
| `customer_name` | Text | The caller's name |
| `job_description` | Text | One-line summary of the job / problem |
| `postcode` | Text | The caller's postcode or address |
| `is_urgent` | Boolean | True if this is an emergency needing immediate call-back |
| `callback_time` | Text | When the caller prefers to be called back |

(The service also accepts common alternatives like `caller_name`, `job_type`,
`urgency` — but the names above are the reliable path.)

## 3. Onboard a new client (their phone setup)

**Never ask a client to give up their existing business number on day one.**
Instead, provision them a new Twilio number + Retell agent (a copy of Katie
with their business name/town swapped in), then have the client turn on
**call forwarding when busy / no answer / unreachable** on their own phone,
pointed at the new Twilio number. If they're out on a job and don't pick up,
the call rolls over to their AI agent automatically — fully reversible, zero
risk to their real number, and it proves the concept before they'd ever
consider a full number port.

(Full replacement — porting their real number into Twilio so it answers
every call — is the eventual "proper" setup once a client trusts the pilot,
but involves brief downtime during the port and is a bigger ask up front.)

## 4. Add a pilot customer to this service

Edit [config/customers.json](config/customers.json). Each entry maps **the
Twilio number the customer's callers dial** to **the tradesperson's contact
details**:

```json
"+441614960000": {
  "businessName": "Manchester Plumbing Co",
  "smsTo": "+447700900123",
  "emailTo": "dave@manchesterplumbing.co.uk"
}
```

- The key is the Twilio number in `+44` format (no spaces).
- `smsTo` accepts `07700 900123` style too — it gets converted automatically.
- You can also use a Retell `agent_id` as the key if a customer has a dedicated agent.
- Keep the `DEFAULT` entry pointed at **your own** phone/email — it catches any
  call from a number you haven't mapped yet, so nothing is ever silently lost.

After editing, redeploy (or restart) the service — the config is read at startup.

## 5. Deploy

**Recommendation: Railway.** This service must stay running to receive webhooks.

- **Railway** (recommended): true always-on server, ~$5/mo, deploys straight
  from a GitHub repo or `railway up` from this folder. Zero config — it detects
  Node and runs `npm start`.
- **Render**: similar, but the free tier *sleeps* after 15 min idle and takes
  ~30s to wake — Retell's webhook times out at 10s, so a sleeping instance can
  miss calls (Retell retries 3×, so it usually recovers, but don't risk it for
  a paid pilot). Fine on the $7/mo starter plan.
- **Vercel**: built for serverless functions, not Express servers — you'd need
  to restructure the code, and the local JSONL log file won't persist. Skip it.

Railway steps:

1. Create a free GitHub repo and push this folder to it (or use Railway's CLI).
2. railway.app → New Project → Deploy from GitHub repo → select the repo.
3. Once created, open the service → **Variables** → add every variable from
   the table above.
4. **Settings → Networking → Generate Domain** — this gives you the public URL
   (e.g. `https://clearway-bridge.up.railway.app`) to paste into Retell (step 2).
5. Check it's alive: open `https://YOUR-URL/health` in a browser — you should
   see `"ok": true` plus flags showing Twilio/email are configured.

**Add a persistent volume** so call history survives redeploys: in the
Railway service → **Settings → Volumes → New Volume** → mount path `/data`.
The service automatically writes `calls.jsonl` there instead of its local
disk if `/data` exists (falls back to a local `logs/` folder if there's no
volume, e.g. when running locally). Without this step, history is wiped on
every redeploy — fine for a quick local test, not fine for a real pilot.

## 6. Test without a real call

With the service running (locally: `npm install` then `npm start`):

```bash
npm run test:webhook
```

Variants: `npm run test:webhook:urgent` (red-flag format) and
`npm run test:webhook:partial` (call cut short → "needs review" flagging).

To fire at the deployed version instead of localhost:

```bash
TARGET_URL=https://YOUR-URL node scripts/send-test.js urgent
```

Each test POSTs a realistic Retell payload. With `DRY_RUN=true` the SMS/email
are printed to the console instead of sent; with `DRY_RUN=false` a real SMS
and email go to whatever `+441234567890` maps to in `customers.json` (or
`DEFAULT`) — point that at your own phone first.

## 7. What the SMS looks like

- Urgent: `🔴 URGENT — Dave Bricker, +447911123456. SW1A 1AA. Burst pipe under kitchen sink. Wants call-back ASAP.`
- Normal: `New enquiry — Sarah Thompson, +447911123456. M20 4WX. Leaking tap in upstairs bathroom. Call back: After 5pm today.`
- Anything missing or a call cut short appends: `⚠️ Needs review — missing name, postcode. Full details in email.`

## 8. Failure behaviour

- SMS fails → waits 2s, retries once → if still failing, the email still sends
  and the failure is logged with `smsSent: false` plus an `⚠️ SMS FAILED` line
  in the console/platform logs.
- Missing captured fields → SMS still sends with what's available + "needs
  review" flag; never fails silently.
- Unmapped Twilio number → falls back to the `DEFAULT` contact.
- `GET /health` → quick liveness check (add it to a free uptime monitor like
  UptimeRobot to get pinged if the service goes down).
