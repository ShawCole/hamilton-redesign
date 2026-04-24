// Receives proposal feedback. Fires build hooks on all four HMS sites, stores a
// copy in Netlify Blobs (best-effort), and notifies Shaw on Telegram.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8622076376:AAFyaf3NMxhwAr15MMYKic6vcvcCIw3vU4w';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6046524812';

const BUILD_HOOKS = {
  proposal: 'https://api.netlify.com/build_hooks/69ebb9b48f99d77a512712d9',
  intent:   'https://api.netlify.com/build_hooks/69ebb9b56187ab78f1dfb640',
  agents:   'https://api.netlify.com/build_hooks/69ebb9b543cd2672bb4608eb',
  quote:    'https://api.netlify.com/build_hooks/69ebb9b5e975148194df16fe',
};
const SITE_URLS = {
  proposal: 'https://hamilton-proposal.netlify.app',
  intent:   'https://hamilton-fe-intent.netlify.app',
  agents:   'https://hamilton-fe-agents.netlify.app',
  quote:    'https://hamilton-fe-quote.netlify.app',
};

function truncate(s, n) { if (!s) return ''; return s.length > n ? s.slice(0, n-1) + '…' : s; }

function formatTelegram(payload, triggered) {
  const lines = [];
  lines.push('📬 *HMS feedback received*');
  lines.push(`ID: \`${payload.submission_id}\``);
  lines.push(`At: ${payload.submitted_at}`);
  lines.push('');

  if (payload.proposed_changes?.length) {
    lines.push('*Section comments:*');
    for (const c of payload.proposed_changes) {
      lines.push(`• _${c.scope || ''}/${c.id || ''}_: ${truncate(c.comment, 240)}`);
    }
    lines.push('');
  }
  const edited = (payload.assumptions || []).filter(a => a.edited && a.edited.length);
  if (edited.length) {
    lines.push('*Edited assumptions:*');
    for (const a of edited) lines.push(`• _${a.id}_: ${truncate(a.edited, 240)}`);
    lines.push('');
  }
  if (payload.additional_notes) {
    lines.push('*Notes:*');
    lines.push(truncate(payload.additional_notes, 1500));
    lines.push('');
  }
  if (!payload.proposed_changes?.length && !edited.length && !payload.additional_notes) {
    lines.push('_(Proposal accepted as-is — no edits or comments.)_');
    lines.push('');
  }

  lines.push('*Rebuilds triggered:*');
  for (const [k, res] of Object.entries(triggered)) {
    const status = res.ok ? '✅' : '⚠️';
    lines.push(`${status} ${k}: ${SITE_URLS[k]}`);
  }
  return lines.join('\n');
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

async function fireHook(url) {
  try {
    const r = await fetch(url, { method: 'POST' });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function tryStoreBlob(payload) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('hamilton-feedback');
    await store.setJSON(payload.submission_id, payload);
    await store.setJSON('latest', payload);
    return true;
  } catch (e) { console.error('Blob store failed (non-fatal):', e.message); return false; }
}

export async function handler(event) {
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, msg: 'HMS feedback endpoint live', sites: SITE_URLS }) };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  payload.submitted_at = payload.submitted_at || new Date().toISOString();
  payload.submission_id = payload.submission_id || 'hamilton-' + Date.now().toString(36);
  payload.received_at = new Date().toISOString();
  payload.user_agent = event.headers?.['user-agent'] || '';
  payload.ip = event.headers?.['x-nf-client-connection-ip'] || '';

  const stored = await tryStoreBlob(payload);

  // Fire build hooks in parallel.
  const hookEntries = Object.entries(BUILD_HOOKS);
  const triggered = {};
  const results = await Promise.all(hookEntries.map(async ([k, url]) => [k, await fireHook(url)]));
  for (const [k, r] of results) triggered[k] = r;

  try {
    await sendTelegram(formatTelegram(payload, triggered));
    await sendTelegram('```json\n' + JSON.stringify(payload, null, 2).slice(0, 3500) + '\n```');
  } catch (err) {
    console.error('Telegram failed:', err);
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'telegram_failed', stored, triggered }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, submission_id: payload.submission_id, stored, triggered, urls: SITE_URLS }),
  };
}
