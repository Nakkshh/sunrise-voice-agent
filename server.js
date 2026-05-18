require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY; // simple shared-secret auth for the admin endpoints

// ---------------------------------------------------------------------------
// Rate limiting: prevents abuse/cost blowout on the outbound call endpoint.
// Each call has a real cost (Twilio + Vapi), so we cap how often the same
// IP can trigger calls. Same pattern as the Redis sliding-window limiter
// I built for NexGate, just in-memory here since this is a single-instance
// demo rather than a distributed gateway.
// ---------------------------------------------------------------------------
const callLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3,                   // max 3 call attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many call requests. Please wait a few minutes before trying again.' }
});

// ---------------------------------------------------------------------------
// Simple API-key auth middleware for admin/reporting endpoints.
// Not full JWT/RBAC (out of scope for this demo's timeline), but the same
// shape: a protected route that requires a credential before returning data.
// ---------------------------------------------------------------------------
function requireAdminKey(req, res, next) {
  const key = req.header('x-admin-key');
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Missing or invalid x-admin-key header.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// POST /api/call — trigger an outbound Vapi call, rate-limited, and persist
// the attempt to the database immediately so we have a record even if the
// webhook never arrives (e.g. call fails before connecting).
// ---------------------------------------------------------------------------
app.post('/api/call', callLimiter, async (req, res) => {
  const { phone, name, projectType } = req.body;

  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid number in E.164 format, e.g. +919876543210' });
  }
  if (!VAPI_API_KEY || !VAPI_PHONE_NUMBER_ID || !VAPI_ASSISTANT_ID) {
    return res.status(500).json({ error: 'Missing Vapi credentials in .env' });
  }

  try {
    const response = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: { number: phone, name: name || undefined },
        metadata: { name: name || null, projectType: projectType || null }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Vapi error:', data);
      return res.status(response.status).json({ error: data.message || 'Vapi call failed.' });
    }

    // Persist the call attempt immediately (status defaults to 'initiated')
    db.createCall({ vapiCallId: data.id, phoneNumber: phone, name, projectType });

    console.log('Call triggered:', data.id);
    return res.json({ success: true, callId: data.id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to reach Vapi API.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/vapi-webhook — Vapi calls this when a call ends. We persist the
// transcript, summary, and outcome so this data doesn't just vanish into
// console logs — it becomes queryable lead data, like a real CRM would need.
// ---------------------------------------------------------------------------
app.post('/api/vapi-webhook', (req, res) => {
  const msg = req.body.message;

  if (msg?.type === 'end-of-call-report') {
    console.log('--- CALL SUMMARY ---');
    console.log('Call ID:', msg.call?.id);
    console.log('Ended reason:', msg.endedReason);

    // Vapi has carried the recording URL under different keys across API
    // versions -- check both the top-level field and the newer `artifact`
    // wrapper so this doesn't silently break if the payload shape changes.
    const recordingUrl = msg.recordingUrl || msg.artifact?.recordingUrl || null;

    try {
      db.updateCallOutcome({
        vapiCallId: msg.call?.id,
        endedReason: msg.endedReason,
        transcript: msg.transcript || null,
        summary: msg.summary || null,
        recordingUrl,
        durationSeconds: msg.durationSeconds || null
      });
    } catch (err) {
      console.error('Failed to persist call outcome:', err);
    }
  }

  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// GET /api/admin/calls — protected endpoint to view recent call history.
// Requires x-admin-key header. This is the "reporting layer" a real CRM
// integration would read from.
// ---------------------------------------------------------------------------
app.get('/api/admin/calls', requireAdminKey, (req, res) => {
  try {
    const calls = db.getAllCalls();
    res.json({ calls });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch call history.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics — lightweight observability endpoint. Not a full Prometheus
// setup, but the same instinct: expose counters for total calls, success/
// failure rate, and average call duration, so this is monitorable rather
// than a black box.
// ---------------------------------------------------------------------------
app.get('/metrics', (req, res) => {
  try {
    res.json(db.getMetrics());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute metrics.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));