/**
 * MindBloom — Story Wall Backend
 * Express + SQLite | Bad-word filter | Rate limiting | Real-time WebSockets
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite');
const cors     = require('cors');
const path     = require('path');

const app  = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = 3001;

/* ── Database ────────────────────────────────────────────── */
const db = new DatabaseSync(path.join(__dirname, 'mindbloom.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    feeling    TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    emoji      TEXT    NOT NULL DEFAULT '🌸',
    sticker_color TEXT NOT NULL DEFAULT 'sn-y',
    created_at DATETIME DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    ip         TEXT PRIMARY KEY,
    count      INTEGER DEFAULT 1,
    window_start INTEGER
  );
`);

/* ── Bad-word list (server-side, English + common slang) ── */
const BAD_WORDS = [
  /* Tier 1 — explicit profanity */
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
  /* Tier 2 — hateful / discriminatory */
  'kike','kikes',
  'spic','spics',
  'chink','chinks',
  'gook','gooks',
  'tranny','trannies',
  'dyke','dykes',
  /* Tier 3 — self-harm / dangerous content */
  'kill yourself','kys','end yourself',
  'go die','should die',
  'hang yourself','slit your',
  /* Tier 4 — sexual / NSFW */
  'rape','raping','rapist',
  'molest','molested','molester',
  'porn','porno','pornography',
  'sex','sexy','sexting',        // context-allowed but filtered for safety
  'nude','nudes','naked',
  'boobs','boob','tits','tit',
];

/* Normalise leet-speak before matching */
function normaliseLeet(str) {
  return str.toLowerCase()
    .replace(/4|@/g, 'a')
    .replace(/3/g, 'e')
    .replace(/1|!|\|/g, 'i')
    .replace(/0/g, 'o')
    .replace(/5|\$/g, 's')
    .replace(/7/g, 't')
    .replace(/\+/g, 't')
    .replace(/8/g, 'b')
    .replace(/9/g, 'g')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns { clean: true } if safe, or { clean: false, reason: string }
 */
function filterContent(text) {
  const raw        = text.toLowerCase();
  const normalised = normaliseLeet(text);
  const compact    = raw.replace(/[^a-z0-9]/g, '');

  for (const word of BAD_WORDS) {
    const w   = word.toLowerCase();
    const wRe = new RegExp('\\b' + w.replace(/\s+/g, '\\s+') + '\\b', 'i');

    if (
      wRe.test(raw)             ||   // plain text match
      wRe.test(normalised)      ||   // leet-normalised
      compact.includes(w.replace(/\s+/g,''))  // compact check
    ) {
      return { clean: false, reason: 'inappropriate language' };
    }
  }
  return { clean: true };
}

/* ── Simple in-memory rate limiter (5 posts / 10 min / IP) ─ */
const RATE_WINDOW_MS  = 10 * 60 * 1000;   // 10 minutes
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
app.use(express.static(path.join(__dirname)));   // serve index.html

/* ── Helper: get client IP ──────────────────────────────── */
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

/* POST /api/stories — submit a new story */
app.post('/api/stories', (req, res) => {
  const ip = getIP(req);

  /* Rate limit */
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: '🌸 Slow down! You can share up to 5 stories every 10 minutes.'
    });
  }

  const { feeling, text } = req.body || {};

  /* Basic validation */
  if (!feeling || typeof feeling !== 'string') {
    return res.status(400).json({ error: 'Please select how you are feeling.' });
  }
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Please write your story.' });
  }

  const trimmed = text.trim();

  if (trimmed.length < 8) {
    return res.status(400).json({ error: 'Your story is too short — say a little more 🌱' });
  }
  if (trimmed.length > 280) {
    return res.status(400).json({ error: 'Please keep your story under 280 characters.' });
  }

  /* Bad-word filter */
  const filter = filterContent(trimmed);
  if (!filter.clean) {
    return res.status(422).json({
      error: '🌸 Please keep it kind — this is a safe space. Your message contains inappropriate language.'
    });
  }

  /* Allowed feelings */
  const emojiMap = {
    anxious:     '😰',
    lonely:      '😔',
    'burned-out':'🥱',
    angry:       '😤',
    hopeful:     '🌱',
    okay:        '😊',
  };
  if (!emojiMap[feeling]) {
    return res.status(400).json({ error: 'Invalid feeling selection.' });
  }

  const colors = ['sn-y','sn-m','sn-l','sn-p','sn-b','sn-k'];
  const color  = colors[Math.floor(Math.random() * colors.length)];
  const emoji  = emojiMap[feeling];

  /* Insert */
  try {
    const stmt   = db.prepare(
      'INSERT INTO stories (feeling, text, emoji, sticker_color) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(feeling, trimmed, emoji, color);
    const story  = db.prepare('SELECT * FROM stories WHERE id = ?').get(result.lastInsertRowid);
    
    /* 🔴 Emit real-time event to all connected clients! */
    io.emit('new_story', story);
    
    return res.status(201).json({ success: true, story });
  } catch (err) {
    console.error('DB insert error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/* GET /api/stories — fetch latest 60 stories */
app.get('/api/stories', (_req, res) => {
  try {
    const stories = db
      .prepare('SELECT * FROM stories ORDER BY created_at DESC LIMIT 60')
      .all();
    return res.json(stories);
  } catch (err) {
    console.error('DB read error:', err);
    return res.status(500).json({ error: 'Could not load stories.' });
  }
});

/* GET /api/stories/count */
app.get('/api/stories/count', (_req, res) => {
  try {
    const row = db.prepare('SELECT COUNT(*) as total FROM stories').get();
    return res.json({ total: row.total });
  } catch (err) {
    return res.status(500).json({ error: 'Could not count stories.' });
  }
});

/* ── WebSockets ──────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log(`[Socket] A user connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Socket] User disconnected: ${socket.id}`);
  });
});

/* ── Start ───────────────────────────────────────────────── */
server.listen(PORT, () => {
  console.log('');
  console.log('  🌸 MindBloom Story Wall Backend (with WebSockets)');
  console.log(`  ✅ Server running at http://localhost:${PORT}`);
  console.log(`  📂 Open: http://localhost:${PORT}/index.html`);
  console.log('');
});
