// -----------------------------------------------------------------------------
// Lightweight JSON-file-backed data store.
//
// Why not a "real" database (Postgres/SQLite) here: this project needs to run
// on any machine with zero native build tools and zero setup (no DB server,
// no node-gyp compilation issues on Windows). A JSON file gives the same
// shape as a real persistence layer -- create, update, query, aggregate --
// without that friction. In a production version I'd swap this module for
// Postgres (as I've done in Nexora/NexGate) without touching any of the
// route code in server.js, since it's isolated behind this same interface.
// -----------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'calls.json');

function readAll() {
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('Failed to read calls.json, starting fresh:', err.message);
    return [];
  }
}

function writeAll(records) {
  fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2));
}

function createCall({ vapiCallId, phoneNumber, name, projectType }) {
  const records = readAll();
  records.unshift({
    vapi_call_id: vapiCallId,
    phone_number: phoneNumber,
    name: name || null,
    project_type: projectType || null,
    status: 'initiated',
    ended_reason: null,
    transcript: null,
    summary: null,
    recording_url: null,
    duration_seconds: null,
    created_at: new Date().toISOString(),
    ended_at: null
  });
  writeAll(records);
}

function updateCallOutcome({ vapiCallId, endedReason, transcript, summary, recordingUrl, durationSeconds }) {
  const records = readAll();
  const record = records.find(r => r.vapi_call_id === vapiCallId);
  if (!record) return false;
  record.status = 'completed';
  record.ended_reason = endedReason;
  record.transcript = transcript;
  record.summary = summary;
  record.recording_url = recordingUrl || null;
  record.duration_seconds = durationSeconds;
  record.ended_at = new Date().toISOString();
  writeAll(records);
  return true;
}

function markCallFailed(vapiCallId, reason) {
  const records = readAll();
  const record = records.find(r => r.vapi_call_id === vapiCallId);
  if (!record) return false;
  record.status = 'failed';
  record.ended_reason = reason;
  record.ended_at = new Date().toISOString();
  writeAll(records);
  return true;
}

function getAllCalls() {
  return readAll().slice(0, 100);
}

function getMetrics() {
  const records = readAll();
  const total = records.length;
  const completed = records.filter(r => r.status === 'completed').length;
  const failed = records.filter(r => r.status === 'failed').length;
  const durations = records.filter(r => typeof r.duration_seconds === 'number').map(r => r.duration_seconds);
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  return {
    total_calls: total,
    completed_calls: completed,
    failed_calls: failed,
    success_rate: total > 0 ? ((completed / total) * 100).toFixed(1) + '%' : 'N/A',
    avg_call_duration_seconds: avgDuration
  };
}

module.exports = { createCall, updateCallOutcome, markCallFailed, getAllCalls, getMetrics };