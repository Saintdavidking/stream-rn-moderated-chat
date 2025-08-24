import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { StreamChat } from 'stream-chat';

const app = express();

// Keep raw for webhook verification (optional)
app.use('/webhook', express.raw({ type: '*/*' }));
app.use(cors());
app.use(express.json());

if (!process.env.STREAM_KEY || !process.env.STREAM_SECRET) {
  console.error('Missing STREAM_KEY or STREAM_SECRET in .env');
  process.exit(1);
}

const serverClient = StreamChat.getInstance(
  process.env.STREAM_KEY,
  process.env.STREAM_SECRET
);

const CHANNEL_TYPE = process.env.CHANNEL_TYPE || 'messaging';
const DESIRED_BLOCKLIST = process.env.BLOCKLIST_NAME || 'profanity_en_2020_v1';
const FALLBACK_BLOCKLIST = 'profanity_en_2020_v1';

// Simple profanity matcher as a fallback (not exhaustive)
const PROFANITY_RE = /\b(fuck|shit|bitch|asshole|dick|bastard|cunt)\b/i;

// ---- flag dedupe + sanitization helpers ----
const flaggedCache = new Set();                 // message IDs we've already announced
const cacheTimes = new Map();
const FLAG_TTL_MS = 5 * 60 * 1000;              // 5 minutes window

const REDACT_RE = /\b(fuck|shit|bitch|asshole|dick|bastard|cunt)\b/gi;
const redact = (s = '') => s.replace(REDACT_RE, (m) => m[0] + '***');

function rememberFlagged(id) {
  flaggedCache.add(id);
  cacheTimes.set(id, Date.now());
}
function wasFlaggedRecently(id) {
  const t = cacheTimes.get(id);
  if (!t) return false;
  if (Date.now() - t > FLAG_TTL_MS) {
    flaggedCache.delete(id);
    cacheTimes.delete(id);
    return false;
  }
  return true;
}

async function ensureChannelTypeWithBlocklist() {
  try {
    await serverClient.updateChannelType(CHANNEL_TYPE, {
      blocklist: DESIRED_BLOCKLIST,
      blocklist_behavior: 'flag', // store & flag, don't block
    });
    console.log(`[init] ${CHANNEL_TYPE} blocklist="${DESIRED_BLOCKLIST}" behavior=flag`);
  } catch (err) {
    const msg = err?.message || '';
    if (/invalid block list name/i.test(msg) || err?.code === 4) {
      console.warn(`[init] "${DESIRED_BLOCKLIST}" invalid. Falling back to "${FALLBACK_BLOCKLIST}".`);
      await serverClient.updateChannelType(CHANNEL_TYPE, {
        blocklist: FALLBACK_BLOCKLIST,
        blocklist_behavior: 'flag',
      });
      console.log(`[init] ${CHANNEL_TYPE} blocklist="${FALLBACK_BLOCKLIST}" behavior=flag`);
    } else {
      console.error('[init] failed to update channel type:', msg);
    }
  }

  try {
    const t = await serverClient.getChannelType(CHANNEL_TYPE);
    console.log('[init] Effective channel type:', {
      type: t?.channel_type || CHANNEL_TYPE,
      blocklist: t?.blocklist,
      blocklist_behavior: t?.blocklist_behavior,
    });
  } catch (e) {
    console.warn('[init] Could not fetch channel type details:', e?.message);
  }
}

(async () => {
  await ensureChannelTypeWithBlocklist();
  await serverClient.upsertUser({ id: 'system-bot', name: 'System' }).catch(() => {});
})();

// Tokens for client
app.get('/token', (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  return res.json({
    token: serverClient.createToken(String(user_id)),
    apiKey: process.env.STREAM_KEY,
  });
});

// Ensure a channel exists
app.post('/channel', async (req, res) => {
  const { channelId, members = [] } = req.body || {};
  if (!channelId || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'channelId and members[] required' });
  }

  const createdById = members[0] || 'system-bot';
  try {
    const unique = Array.from(new Set([...members, createdById, 'system-bot']));
    await serverClient.upsertUsers(unique.map((id) => ({ id, name: id })));

    const channel = serverClient.channel(CHANNEL_TYPE, channelId, {
      created_by_id: createdById,
      members: unique,
    });

    try { await channel.create(); } catch (e) { if (e?.code !== 16) throw e; }
    if (members.length) { try { await channel.addMembers(members); } catch {} }

    return res.json({ cid: channel.cid });
  } catch (err) {
    console.error('[POST /channel] error:', err);
    return res.status(500).json({ error: err?.message || 'failed to create/ensure channel' });
  }
});

// Webhook: single source of “flagged” truth (deduped, sanitized, ignore system-bot)
app.post('/webhook', async (req, res) => {
  let payload;
  try {
    payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
  } catch (e) {
    console.error('[webhook] parse error', e);
    return res.status(200).send('ignored');
  }

  const type = payload?.type;
  const msg  = payload?.message;

  // Never react to messages authored by the notice bot; prevents loops
  if (msg?.user?.id === 'system-bot') return res.status(200).send('ignored');

  // Stream’s official flag event
  if (type === 'message.flagged' && msg?.id) {
    await postNotice(msg).catch(() => {});
    return res.status(200).send('ok');
  }

  // Optional fallback: if Stream didn’t flag but regex hits, flag + notice once
  if (type === 'message.new' && msg?.id && typeof msg?.text === 'string') {
    if (PROFANITY_RE.test(msg.text) && !wasFlaggedRecently(msg.id)) {
      try {
        await serverClient.flagMessage(msg.id, { user_id: 'system-bot' });
        await postNotice(msg);
      } catch (e) {
        console.warn('[webhook] fallback flag failed:', e?.message);
      }
    }
    return res.status(200).send('ok');
  }

  // AI moderation queue — still sanitize + dedupe
  const it = payload?.item;
  if (it && (it.recommended_action === 'flag' || it.recommended_action === 'remove') && it.message_id) {
    try {
      const got = await serverClient.getMessage(it.message_id);
      if (got?.message && got.message.user?.id !== 'system-bot') {
        await postNotice(got.message);
      }
    } catch {}
    return res.status(200).send('ok');
  }

  return res.status(200).send('ignored');
});

async function postNotice(msg) {
  const id = msg?.id, cid = msg?.cid;
  if (!id || !cid) return;

  // avoid duplicate notices for the same original message
  if (wasFlaggedRecently(id)) return;
  rememberFlagged(id);

  const [type, chId] = String(cid).split(':');
  const ch = serverClient.channel(type, chId);

  const author = msg?.user?.id || 'someone';
  const preview = redact((msg?.text || '').slice(0, 120));

  await ch.sendMessage({
    text: `⚠️ A message from @${author} was flagged by moderation.\n“${preview}”`,
    type: 'system',
    user_id: 'system-bot',
  });
}

// Allow client to request a flag if it detected profanity locally (kept)
app.post('/flag/:messageId', async (req, res) => {
  try {
    const out = await serverClient.flagMessage(req.params.messageId, { user_id: 'system-bot' });
    return res.json({ ok: true, out });
  } catch (e) {
    return res.status(500).json({ error: e?.message });
  }
});

// Debug: send a profane test message server-side (optional)
app.post('/debug/flag', async (_req, res) => {
  try {
    const channel = serverClient.channel(CHANNEL_TYPE, 'debug-room', {
      created_by_id: 'system-bot',
      members: ['system-bot', 'alice', 'bob', 'charlie'],
    });
    try { await channel.create(); } catch (e) { if (e?.code !== 16) throw e; }
    const resp = await channel.sendMessage({
      user_id: 'alice',
      text: 'this is a test with badword: fuck',
    });
    const t = await serverClient.getChannelType(CHANNEL_TYPE).catch(() => ({}));
    return res.json({
      sent_message_id: resp.message?.id,
      cid: channel.cid,
      channel_type_settings: { blocklist: t?.blocklist, blocklist_behavior: t?.blocklist_behavior },
    });
  } catch (err) {
    console.error('/debug/flag error', err);
    return res.status(500).json({ error: err?.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 5050);
app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  console.log(`Webhook endpoint: POST http://localhost:${port}/webhook`);
  console.log('Debug: POST /debug/flag  (sends a profane test message)');
});
