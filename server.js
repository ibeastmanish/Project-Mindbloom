/**
 * MindBloom — Story Wall Backend (Vercel Ready)
 * Express + Neon/Vercel Postgres | Bad-word filter | Rate limiting | Polling
 */
require('dotenv').config();
const express  = require('express');
const { neon } = require('@neondatabase/serverless');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

// Initialize Neon SQL
const sql = neon(process.env.DATABASE_URL || 'postgres://dummy');

/* ── Database Init ───────────────────────────────────────── */
async function initDB() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS stories (
        id            SERIAL PRIMARY KEY,
        feeling       VARCHAR(255) NOT NULL,
        text          TEXT NOT NULL,
        emoji         VARCHAR(255) NOT NULL DEFAULT '🌸',
        sticker_color VARCHAR(255) NOT NULL DEFAULT 'sn-y',
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
  } catch (err) {
    console.error('DB Init error (make sure DATABASE_URL is set):', err);
  }
}
// Vercel Serverless functions can execute this on cold start
initDB();

/* ── Bad-word list (server-side, English + common slang) ── */
const BAD_WORDS = [
  'fuck','fucked','fucker','fucking','fucks','f u c k',
  'shit','shitting','shitter','shits',
  'bitch','bitches','bitching',
  'ass','asses','asshole','assholes',
  'bastard','bastards',
  'cunt','cunts',
  'damn','dammit',
  'dick','dicks',
  'cock','cocks',
  'piss','pissing','pissed',
  'pussy','pussies',
  'slut','sluts',
  'whore','whores',
  'nigger','niggers','nigga','niggas',
  'faggot','faggots','fag','fags',
  'retard','retarded','retards',
  'twat','twats',
  'wank','wanker','wankers',
  'bollocks',
  'motherfucker','motherfuckers','mf',
  'wtf','stfu','gtfo',
  'kike','kikes','spic','spics','chink','chinks','gook','gooks','tranny','trannies','dyke','dykes',
  'kill yourself','kys','end yourself','go die','should die','hang yourself','slit your',
  'rape','raping','rapist','molest','molested','molester','porn','porno','pornography',
  'sex','sexy','sexting','nude','nudes','naked','boobs','boob','tits','tit'
];

function normaliseLeet(str) {
  return str.toLowerCase()
    .replace(/4|@/g, 'a').replace(/3/g, 'e').replace(/1|!|\|/g, 'i')
    .replace(/0/g, 'o').replace(/5|\$/g, 's').replace(/7/g, 't')
    .replace(/\+/g, 't').replace(/8/g, 'b').replace(/9/g, 'g')
    .replace(/\s+/g, ' ').trim();
}

function filterContent(text) {
  const raw        = text.toLowerCase();
  const normalised = normaliseLeet(text);
  const compact    = raw.replace(/[^a-z0-9]/g, '');

  for (const word of BAD_WORDS) {
    const w   = word.toLowerCase();
    const wRe = new RegExp('\\b' + w.replace(/\s+/g, '\\s+') + '\\b', 'i');

    if (wRe.test(raw) || wRe.test(normalised) || compact.includes(w.replace(/\s+/g,''))) {
      return { clean: false, reason: 'inappropriate language' };
    }
  }
  return { clean: true };
}

/* ── Simple in-memory rate limiter (5 posts / 10 min / IP) ─ */
// Note: In Vercel, this resets per serverless instance cold-boot.
// For true edge rate limiting, you would use Vercel KV or Upstash.
const RATE_WINDOW_MS  = 10 * 60 * 1000;
const RATE_MAX_POSTS  = 5;
const rateLimitMap    = new Map();

function checkRateLimit(ip) {
  const now    = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (record.count >= RATE_MAX_POSTS) return false;
  record.count++;
  return true;
}

/* ── Middleware ──────────────────────────────────────────── */
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname)));

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

/* ════════════════════════════════════════════════════════════
   ROUTES
════════════════════════════════════════════════════════════ */

app.post('/api/stories', async (req, res) => {
  const ip = getIP(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: '🌸 Slow down! You can share up to 5 stories every 10 minutes.' });
  }

  const { feeling, text } = req.body || {};
  if (!feeling || typeof feeling !== 'string') return res.status(400).json({ error: 'Please select how you are feeling.' });
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Please write your story.' });

  const trimmed = text.trim();
  if (trimmed.length < 8) return res.status(400).json({ error: 'Your story is too short — say a little more 🌱' });
  if (trimmed.length > 280) return res.status(400).json({ error: 'Please keep your story under 280 characters.' });

  const filter = filterContent(trimmed);
  if (!filter.clean) {
    return res.status(422).json({ error: '🌸 Please keep it kind — this is a safe space. Your message contains inappropriate language.' });
  }

  const emojiMap = { anxious:'😰', lonely:'😔', 'burned-out':'🥱', angry:'😤', hopeful:'🌱', okay:'😊' };
  if (!emojiMap[feeling]) return res.status(400).json({ error: 'Invalid feeling selection.' });

  const colors = ['sn-y','sn-m','sn-l','sn-p','sn-b','sn-k'];
  const color  = colors[Math.floor(Math.random() * colors.length)];
  const emoji  = emojiMap[feeling];

  try {
    const result = await sql`
      INSERT INTO stories (feeling, text, emoji, sticker_color) 
      VALUES (${feeling}, ${trimmed}, ${emoji}, ${color}) 
      RETURNING *;
    `;
    const story = result[0];
    
    // Instead of WebSockets, clients will poll GET /api/stories
    return res.status(201).json({ success: true, story });
  } catch (err) {
    console.error('DB insert error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('/api/stories', async (_req, res) => {
  try {
    const stories = await sql`SELECT * FROM stories ORDER BY created_at DESC LIMIT 60`;
    return res.json(stories);
  } catch (err) {
    console.error('DB read error:', err);
    return res.status(500).json({ error: 'Could not load stories.' });
  }
});

app.get('/api/stories/count', async (_req, res) => {
  try {
    const result = await sql`SELECT COUNT(*) as total FROM stories`;
    return res.json({ total: parseInt(result[0].total) });
  } catch (err) {
    return res.status(500).json({ error: 'Could not count stories.' });
  }
});

/* ── Start / Export ──────────────────────────────────────── */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('  🌸 MindBloom Story Wall Backend (Vercel Ready)');
    console.log(`  ✅ Server running at http://localhost:${PORT}`);
    console.log('');
  });
}

// Export for Vercel Serverless Functions
module.exports = app;
