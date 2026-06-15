# Sunrise Interiors — AI Voice Agent with Lead Management

A web page where a visitor enters their details and receives an immediate, human-feeling AI voice call from "Sunrise Interiors" — introducing itself, asking about the visitor's interior design needs, and offering/confirming a designer meeting. Every call's outcome — transcript, summary, recording, and status — is persisted and viewable on an internal ops dashboard.

Built for the AI Engineer Internship take-home assignment, then extended with a backend layer (persistence, rate limiting, auth, observability) to move it from a working demo toward something closer to client-deployable.

## How it works

```
Visitor submits name + phone + project type on web form
        │
        ▼
POST /api/call  →  Node/Express backend (rate-limited)
        │
        ├──▶ Vapi REST API (orchestration layer)
        │         │
        │         ▼
        │    Twilio → dials the visitor's phone
        │         │
        │         ▼
        │    Live conversation:
        │      Deepgram Nova 3       → speech-to-text
        │      Gemini 3.1 Flash Lite → generates the agent's replies
        │      Vapi's Naina voice    → text-to-speech (Indian accent)
        │
        └──▶ Call record saved (status: initiated)

When the call ends:
        │
        ▼
Vapi POSTs an end-of-call-report  →  POST /api/vapi-webhook
        │
        ▼
Transcript, summary, recording URL, and outcome saved to the call record
        │
        ▼
Viewable on /dashboard.html (transcript, recording playback, metrics)
```

Vapi handles real-time audio streaming, turn-taking, and interruption handling — so the assistant's behavior (what it says, when, and how it reacts to interruptions) is fully defined in the Vapi assistant configuration rather than in this codebase. Everything in this codebase is the layer *around* that: intake, persistence, access control, and reporting.

## Stack & why

| Component | Tool | Why |
|---|---|---|
| Frontend | Plain HTML/CSS/JS | Task explicitly says spend time on the call, not the page |
| Backend | Node.js + Express | Lightweight — the custom logic here is intake, persistence, and reporting, not heavy business logic |
| Orchestration | **Vapi** | Bundles STT + LLM + TTS + real-time streaming + interruption handling; building this raw on Twilio Media Streams was rejected given the timeline |
| Telephony | **Twilio** (trial) | Industry standard, only unavoidable paid component after trial credits |
| Speech-to-Text | **Deepgram Nova 3** (multilingual) | Fast, accurate, handles English/Hindi/Hinglish code-switching |
| LLM | **Gemini 3.1 Flash Lite** | Free tier, low latency, cheap enough to keep cost down |
| Text-to-Speech | **Vapi's Naina voice** | Natural Indian-accented voice, no extra third-party TTS cost |
| Persistence | **JSON file store** (`db.js`) | Zero native build dependencies (no node-gyp/Postgres server needed to run this anywhere); isolated behind a small interface so it's a drop-in swap for Postgres later |
| Rate limiting | **express-rate-limit** | Each call has a real per-minute cost — caps abuse on the public-facing call endpoint |
| Admin auth | Shared-secret header (`x-admin-key`) | Lightweight stand-in for real auth (JWT/RBAC) on the internal reporting endpoints |
| Tunneling | **Cloudflared** | Free public tunnel for the local webhook endpoint during development — no signup/account required for quick tunnels |

**Alternatives considered and rejected:**
- Raw Twilio Media Streams (no orchestrator) — full cost/latency control, but too much build time for real-time streaming + interruption handling given the timeline
- ElevenLabs for TTS — higher voice quality, but its Voice Library requires a paid plan for API access (hit this directly — see "Problems solved" below); not worth the cost/complexity jump for this use case
- Bland AI — bundled and simple, but pricier per minute than Vapi with less configurability
- LiveKit (self-hosted) — cheapest at scale, but requires building more of the pipeline yourself
- Postgres/SQLite for persistence — more "real," but adds a DB server or native compilation step; deferred until this needs to run somewhere other than a laptop

## Cost

Per Vapi's own dashboard for this configuration:

| Layer | Cost |
|---|---|
| Deepgram Nova 3 (STT) | $0.01/min |
| Gemini 3.1 Flash Lite (LLM) | $0.01/min |
| Vapi Naina voice (TTS) | $0.02/min |
| Vapi orchestration | $0.05/min |
| **Total** | **~$0.09/min (~₹7–8/min)** |

This is above the ideal ₹2–3/min target but close to the acceptable ₹5–6/min range. The main remaining lever to close the gap is dropping Vapi's orchestration fee by building the pipeline directly on Twilio Media Streams (or a framework like Pipecat) — a meaningfully larger engineering effort than was justified for the initial timeline, but a clear next step (see Roadmap).

## Project structure

```
sunrise-voice-agent/
├── public/
│   ├── index.html         # lead intake form (name, phone, project type)
│   └── dashboard.html      # internal ops dashboard (metrics, call history, transcripts, recordings)
├── server.js               # Express backend — call trigger, webhook, admin API, metrics
├── db.js                   # JSON-file persistence layer for call records
├── calls.json              # generated at runtime — call records (gitignored)
├── assistant-config.json   # Vapi assistant definition (voice, prompt, model)
├── package.json
├── .env.example
└── README.md
```

## Endpoints

| Method | Endpoint | Purpose | Auth |
|---|---|---|---|
| `GET` | `/` | Lead intake form | — |
| `GET` | `/dashboard.html` | Ops dashboard (metrics + call history) | — (data calls require admin key) |
| `POST` | `/api/call` | Triggers an outbound Vapi call | Rate-limited: 3 req / 10 min / IP |
| `POST` | `/api/vapi-webhook` | Receives Vapi's end-of-call report; persists transcript/summary/recording/outcome | — (see Roadmap: webhook signature verification) |
| `GET` | `/api/admin/calls` | Last 100 call records | `x-admin-key` header |
| `GET` | `/metrics` | Aggregate stats: total/completed/failed calls, success rate, avg duration | — |

## Setup

### 1. Accounts (free)
- [Vapi](https://vapi.ai) — sign up, get $10 free credit. Dashboard → API Keys → copy your Private Key.
- [Twilio](https://twilio.com/try-twilio) — free trial ($15.15 credit). Verify your own number under Console → Phone Numbers → Verified Caller IDs (trial accounts can only call verified numbers), and buy a Twilio number to import into Vapi.

### 2. Create the Vapi assistant
In the Vapi dashboard → Assistants → Create Assistant, either paste `assistant-config.json` into the JSON editor or configure manually:
- **Model**: Google Gemini 3.1 Flash Lite
- **Transcriber**: Deepgram Nova 3, multilingual
- **Voice**: Vapi's built-in Naina voice
- **First message**: assistant speaks first (see `assistant-config.json` for the exact opening line and system prompt)
- Max call duration: 120s, silence timeout: 20s

Copy the resulting **Assistant ID**.

### 3. Connect a phone number
In Vapi dashboard → Phone Numbers, import your Twilio trial number (Account SID + Auth Token + number). Copy the resulting **Phone Number ID**. Assign your assistant to this number.

### 4. Configure and run
```bash
cp .env.example .env
# fill in VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, VAPI_ASSISTANT_ID, ADMIN_API_KEY

npm install
npm start
```

Open `http://localhost:3000`, fill in the intake form with your own verified number in E.164 format (e.g. `+919876543210`), and submit.

### 5. (Optional) Receive live transcripts/recordings
Vapi needs a public URL to POST the end-of-call webhook to. Locally, use [Cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (Cloudflare Tunnel):
```bash
cloudflared tunnel --url http://localhost:3000
```
Copy the `https://...trycloudflare.com` URL, append `/api/vapi-webhook`, and set it as the assistant's Server URL in the Vapi dashboard. Without this step, calls still work — you just won't see the transcript/recording populate on the dashboard.

### 6. View the dashboard
Open `http://localhost:3000/dashboard.html`, enter your `ADMIN_API_KEY`, click Load. Each completed call has a **View** button showing the full transcript, AI-generated summary, and an embedded recording player.

## The call

The assistant, "Riya," is scripted (via the Vapi system prompt) to:
1. Introduce itself as calling from Sunrise Interiors and check if it's a good time to talk
2. Ask what interior work the visitor wants done and how soon they want to start
3. Offer a free consultation with a designer, and confirm a specific day/time if the visitor agrees
4. Handle a polite "not interested" gracefully, without pushing
5. Handle interruptions and off-script questions (pricing, timelines) naturally
6. Switch fluidly between English, Hindi, and Hinglish based on how the visitor responds
7. Keep the whole call to roughly 60–90 seconds

## Problems solved along the way

**ElevenLabs voice integration failed silently mid-call.** Calls connected but hung up right as the assistant tried to speak. Vapi's call logs showed a `payment_required` / `paid_plan_required` error — ElevenLabs' Voice Library voices are previewable for free in-browser but blocked from API access without a paid plan. Tested multiple voices (including ones with different UI badge indicators, on the hypothesis that badge color signaled tier) — all failed identically, which ruled out "wrong voice" and confirmed it was an account-tier restriction, not a selection problem. Resolved by switching to Vapi's own built-in voice catalog, which has no additional billing dependency.

## Roadmap (not yet built)

- **Webhook signature verification** — `/api/vapi-webhook` currently has no auth; anyone with the URL could POST fake call data. Vapi supports a shared-secret signature for this.
- **Swap JSON store for Postgres** — the persistence layer (`db.js`) is isolated behind a small interface specifically so this is a drop-in change without touching route logic.
- **Cost reduction via custom pipeline** — migrate off Vapi's managed orchestration to Twilio Media Streams (or a framework like Pipecat) with direct Deepgram/Gemini/TTS calls, to move from ~₹7–8/min toward the ~₹2–4/min range.
- **CRM/WhatsApp follow-up integration** — push declined or "call back later" leads into a CRM or automated WhatsApp follow-up instead of just sitting in the dashboard.
- **Full JWT/RBAC on admin routes** — the current `x-admin-key` header is a lightweight stand-in for this.