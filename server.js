const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '20kb' }));

// The creator's donation wallet (the Santa button)
const CREATOR_WALLET = 'C2sMvjiwZJm5vHR7ayDifvPzyuKcpr9isCTCHkwYfuqT';

// ---------------------------------------------------------------------------
// Database: Postgres (Neon). Data is stored permanently, so nothing is lost
// when Render puts the server to sleep.
// ---------------------------------------------------------------------------
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Add your Neon connection string in Render > Environment.');
  process.exit(1);
}

// Return BIGINT and NUMERIC columns as JS numbers instead of strings
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on('error', (err) => console.error('Database pool error:', err.message));

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL UNIQUE,
    twitter TEXT,
    total_gifted DOUBLE PRECISION DEFAULT 0,
    verified INTEGER DEFAULT 0,
    verification_code TEXT,
    code_expires_at BIGINT,
    code_attempts INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden INTEGER DEFAULT 0');

  await pool.query(`CREATE TABLE IF NOT EXISTS gifts (
    id SERIAL PRIMARY KEY,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // The leaderboard ranks people by how much they have GIVEN.
  // Recalculate from the gift history so totals are always correct.
  await pool.query(`UPDATE users u SET total_gifted = COALESCE(
    (SELECT SUM(g.amount) FROM gifts g WHERE g.from_address = u.address), 0)`);
}

// Queries are written with ? placeholders; these convert them to Postgres $1, $2, ...
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function dbRun(sql, params = []) {
  return pool.query(toPg(sql), params);
}

async function dbGet(sql, params = []) {
  const result = await pool.query(toPg(sql), params);
  return result.rows[0];
}

async function dbAll(sql, params = []) {
  const result = await pool.query(toPg(sql), params);
  return result.rows || [];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function clientIp(req) {
  return req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Very small in-memory rate limiter: allow `max` hits per `windowMs` for a key
const rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) {
    if (!hits.some((t) => now - t < 60 * 60 * 1000)) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

function normalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

function generateVerificationCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

// ---------------------------------------------------------------------------
// Name filter: blocks rude/offensive names, links and impersonation
// ---------------------------------------------------------------------------
const LEET = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l', '¡': 'i'
};

function deLeet(text) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split('')
    .map((ch) => LEET[ch] || ch)
    .join('');
}

function collapseRepeats(text) {
  return text.replace(/(.)\1+/g, '$1');
}

// Blocked anywhere inside the name, even with spaces/dots/numbers between letters (f.u.c.k, sh1t)
const BLOCKED_ANYWHERE = [
  'fuck', 'fck', 'cunt', 'bitch', 'biatch', 'whore', 'slut', 'bastard', 'asshole', 'arsehole',
  'dickhead', 'motherf', 'faggot', 'retard', 'pedophile', 'paedophile', 'molest', 'hitler', 'kike',
  'wetback', 'beaner', 'tranny', 'porn', 'penis', 'vagina', 'pussy', 'dildo', 'jizz', 'twat', 'wanker',
  'bollock', 'hentai', 'nsfw', 'onlyfans', 'killyourself'
].map(collapseRepeats);

// Patterns checked on the letters-only name (before repeated letters are squashed)
const BLOCKED_PATTERNS = [/n+[i1]+g{2,}(e+r+|a+h?|r+|u+h+)/, /k{3,}/, /^a+s{2,}(hole)?$/];

// Checked on the squashed name. "shit" is blocked, but names like Matsushita / Yamashita are allowed
const BLOCKED_SQUASHED_PATTERNS = [/shit(?!a[^s]|a$)/];

// Blocked only as a whole word (so names like "Hancock", "Grape", "Sussex" or "Nazim" are fine)
const BLOCKED_WORDS = new Set([
  'ass', 'asses', 'arse', 'cock', 'dick', 'cum', 'tit', 'tits', 'sex', 'rape', 'rapist', 'fag', 'fags',
  'chink', 'spic', 'gook', 'coon', 'paki', 'heil', 'nazi', 'nazis', 'wank', 'prick', 'nude', 'nudes', 'milf',
  'anal', 'boner', 'pedo', 'paedo', 'kys', 'fuk', 'fuq', 'scam', 'scammer'
]);

// Stops people pretending to be staff or the project itself
const IMPERSONATION_WORDS = new Set(['admin', 'administrator', 'mod', 'moderator', 'support', 'official', 'staff', 'dev', 'team', 'helpdesk']);
const IMPERSONATION_ANYWHERE = ['secretshiba', 'christmassolgift'];

function nameProblem(rawName, { label = 'Name', min = 2, max = 24 } = {}) {
  const name = (rawName || '').toString().replace(/\s+/g, ' ').trim();
  if (name.length < min) return `${label} must be at least ${min} characters`;
  if ([...name].length > max) return `${label} must be ${max} characters or less`;
  if (!/^[\p{L}\p{N}\p{M} ._'\-\u200d\ufe0f\p{Extended_Pictographic}]+$/u.test(name)) {
    return `${label} can only use letters, numbers, spaces, emojis and . _ ' -`;
  }
  if (/https?:|www\.|\.(com|io|xyz|net|org|app|gg|link|co|me|fun)\b/i.test(name)) {
    return `${label} can't contain links`;
  }

  const plain = deLeet(name);
  const letters = plain.replace(/[^a-z]/g, '');
  const squashed = collapseRepeats(letters);
  const words = plain.split(/[^a-z]+/).filter(Boolean);

  const rude =
    BLOCKED_ANYWHERE.some((bad) => squashed.includes(bad)) ||
    BLOCKED_PATTERNS.some((re) => re.test(letters)) ||
    BLOCKED_SQUASHED_PATTERNS.some((re) => re.test(squashed)) ||
    words.some((w) => BLOCKED_WORDS.has(w) || BLOCKED_WORDS.has(collapseRepeats(w)) || BLOCKED_PATTERNS.some((re) => re.test(w)));
  if (rude) return `That ${label.toLowerCase()} isn't allowed. Please choose another one.`;

  if (words.some((w) => IMPERSONATION_WORDS.has(w)) || IMPERSONATION_ANYWHERE.some((w) => letters.includes(w))) {
    return `That ${label.toLowerCase()} looks like an official account. Please choose another one.`;
  }
  return null;
}

function cleanName(rawName) {
  return (rawName || '').toString().replace(/\s+/g, ' ').trim();
}

function twitterProblem(rawHandle) {
  const handle = (rawHandle || '').toString().trim().replace(/^@/, '');
  if (!handle) return null;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return 'Twitter handle can only use letters, numbers and _ (max 15)';
  return nameProblem(handle, { label: 'Twitter handle', min: 1, max: 15 });
}

// ---------------------------------------------------------------------------
// What we send to the browser
// ---------------------------------------------------------------------------
function publicUser(user) {
  if (!user) return user;
  const { verification_code, code_expires_at, code_attempts, hidden, token_hash, user_id, expires_at, ...safe } = user;
  return safe;
}

// Same, but also hides email (for leaderboard / random recipient / lookups by others)
function listUser(user) {
  if (!user) return user;
  const { email, ...safe } = publicUser(user);
  return safe;
}

// ---------------------------------------------------------------------------
// Email codes (Brevo)
// ---------------------------------------------------------------------------
const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between emails
const lastSentAt = new Map();

// Sender MUST be a verified sender in Brevo (Settings > Senders, domains, IPs)
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'archie.swarbrick1@gmail.com';
const SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Christmas SOL Gift';

// Send a code email via Brevo. Returns { ok: true } or { ok: false, error }
async function sendCodeEmail(email, code, purpose = 'verify') {
  const brevoApiKey = process.env.BREVO_API_KEY;
  if (!brevoApiKey) {
    console.error('❌ BREVO_API_KEY not set - email not sent');
    return { ok: false, error: 'Email service is not configured' };
  }

  const isLogin = purpose === 'login';
  const subject = isLogin
    ? `Your login code: ${code} - Christmas SOL Gift 🎄`
    : `Your verification code: ${code} - Christmas SOL Gift 🎄`;

  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      to: [{ email }],
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      subject,
      htmlContent: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #0f1b2d; color: #ffffff; border-radius: 8px;">
          <h2 style="color: #ffd700;">${isLogin ? 'Log in to' : 'Welcome to'} Christmas SOL Gift 🎄</h2>
          <p>Your ${isLogin ? 'login' : 'verification'} code is:</p>
          <p style="font-family: monospace; font-size: 32px; letter-spacing: 6px; color: #ffd700; font-weight: bold;">${code}</p>
          <p>Enter this code on the website. It expires in 1 hour.</p>
          <p style="color: #aaaaaa; font-size: 12px;">If you didn't request this, you can ignore this email.</p>
        </div>
      `,
      textContent: `Your Christmas SOL Gift ${isLogin ? 'login' : 'verification'} code is ${code}. It expires in 1 hour.`
    }, {
      headers: { 'api-key': brevoApiKey, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    console.log(`📧 ${purpose} code sent to ${email}`);
    return { ok: true };
  } catch (error) {
    const details = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error(`❌ Brevo error sending to ${email}:`, details);
    return { ok: false, error: 'Could not send the email. Please try again in a minute.' };
  }
}

// Create a fresh code for a user, save it, and email it
async function issueCode(email, purpose, ip) {
  const last = lastSentAt.get(email) || 0;
  const wait = RESEND_COOLDOWN_MS - (Date.now() - last);
  if (wait > 0) {
    return { ok: false, status: 429, error: `Please wait ${Math.ceil(wait / 1000)}s before requesting another code` };
  }
  // Protects the free Brevo quota from someone spamming codes to lots of addresses
  if (rateLimited(`email-ip:${ip}`, 10, 60 * 60 * 1000)) {
    return { ok: false, status: 429, error: 'Too many codes requested. Please try again later.' };
  }

  const code = generateVerificationCode();
  await dbRun(
    'UPDATE users SET verification_code = ?, code_expires_at = ?, code_attempts = 0 WHERE email = ?',
    [code, Date.now() + CODE_TTL_MS, email]
  );

  const sent = await sendCodeEmail(email, code, purpose);
  if (!sent.ok) return { ok: false, status: 502, error: sent.error };

  lastSentAt.set(email, Date.now());
  return { ok: true };
}

// Check a submitted code. Returns null if OK, or an error string
async function checkCode(user, code) {
  if (!user.verification_code || !user.code_expires_at) {
    return 'No active code. Please request a new one.';
  }
  if (Date.now() > user.code_expires_at) {
    return 'Code expired. Please request a new one.';
  }
  if ((user.code_attempts || 0) >= MAX_CODE_ATTEMPTS) {
    return 'Too many wrong attempts. Please request a new code.';
  }
  if (user.verification_code !== code.toString().trim()) {
    await dbRun('UPDATE users SET code_attempts = code_attempts + 1 WHERE email = ?', [user.email]);
    return 'Invalid code';
  }
  await dbRun('UPDATE users SET verification_code = NULL, code_expires_at = NULL, code_attempts = 0 WHERE email = ?', [user.email]);
  lastSentAt.delete(user.email);
  return null;
}

// ---------------------------------------------------------------------------
// Login sessions: after entering a correct email code the browser gets a
// secret token. Only the holder of that token can edit that profile or gift.
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await dbRun('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  await dbRun('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    [sha256(token), userId, Date.now() + SESSION_TTL_MS]);
  return token;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'Please log in first' });

    const tokenHash = sha256(token);
    const user = await dbGet(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.verified = 1`,
      [tokenHash, Date.now()]
    );
    if (!user) return res.status(401).json({ error: 'Your login has expired. Please log in again.' });

    req.user = user;
    req.tokenHash = tokenHash;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

// ---------------------------------------------------------------------------
// Routes: signup and login
// ---------------------------------------------------------------------------

// Join community (with email)
app.post('/api/users', async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const email = normalizeEmail(req.body.email);
    const address = (req.body.address || '').toString().trim();

    if (!name || !email || !address) {
      return res.status(400).json({ error: 'Name, email, and address required' });
    }

    const badName = nameProblem(name);
    if (badName) return res.status(400).json({ error: badName });

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return res.status(400).json({ error: 'Invalid Solana address' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const existingEmail = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    const existingAddress = await dbGet('SELECT * FROM users WHERE address = ?', [address]);

    if (existingEmail && existingEmail.verified) {
      return res.status(400).json({ error: 'This email is already registered. Please login instead.' });
    }
    if (existingAddress && existingAddress.verified) {
      return res.status(400).json({ error: 'This wallet address is already registered' });
    }

    // Clear out unfinished (unverified) signups so people can retry
    if (existingEmail) await dbRun('DELETE FROM users WHERE id = ?', [existingEmail.id]);
    if (existingAddress && (!existingEmail || existingAddress.id !== existingEmail.id)) {
      await dbRun('DELETE FROM users WHERE id = ?', [existingAddress.id]);
    }

    await dbRun('INSERT INTO users (name, email, address, verified) VALUES (?, ?, ?, 0)', [name, email, address]);

    lastSentAt.delete(email);
    const result = await issueCode(email, 'verify', clientIp(req));
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    res.json({ success: true, message: 'Check your email for the verification code.', email });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Resend verification or login code
app.post('/api/resend-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const purpose = req.body.purpose === 'login' ? 'login' : 'verify';
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(404).json({ error: 'User not found. Please sign up first.' });
    if (purpose === 'verify' && user.verified) {
      return res.status(400).json({ error: 'Email already verified. Please login.' });
    }

    const result = await issueCode(email, user.verified ? 'login' : 'verify', clientIp(req));
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    res.json({ success: true, message: 'New code sent! Check your email.' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Verify email with code (after signup) - also logs the user in
app.post('/api/verify-email', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = req.body.code;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code required' });
    }

    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.verified) {
      return res.status(400).json({ error: 'Email already verified. Please login.' });
    }

    const codeError = await checkCode(user, code);
    if (codeError) return res.status(400).json({ error: codeError });

    await dbRun('UPDATE users SET verified = 1 WHERE email = ?', [email]);
    const updated = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    const token = await createSession(updated.id);

    res.json({ success: true, message: 'Email verified! 🎉', user: publicUser(updated), token });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Login step 1: email a login code
app.post('/api/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(404).json({ error: 'User not found. Please join the community first.' });
    }

    const purpose = user.verified ? 'login' : 'verify';
    const result = await issueCode(email, purpose, clientIp(req));
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    res.json({ success: true, codeSent: true, purpose, message: 'Check your email for your code.' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Login step 2: check the login code
app.post('/api/login/verify', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const code = req.body.code;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const codeError = await checkCode(user, code);
    if (codeError) return res.status(400).json({ error: codeError });

    if (!user.verified) await dbRun('UPDATE users SET verified = 1 WHERE email = ?', [email]);
    const updated = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    const token = await createSession(updated.id);

    res.json({ success: true, user: publicUser(updated), token });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Routes: the logged-in user's own account
// ---------------------------------------------------------------------------

// Who am I? (used when the page loads)
app.get('/api/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user));
});

// Update my own profile
app.put('/api/me', requireAuth, async (req, res) => {
  try {
    const name = cleanName(req.body.name) || req.user.name;
    const badName = nameProblem(name);
    if (badName) return res.status(400).json({ error: badName });

    const twitterRaw = (req.body.twitter || '').toString().trim();
    const badTwitter = twitterProblem(twitterRaw);
    if (badTwitter) return res.status(400).json({ error: badTwitter });
    const twitter = twitterRaw.replace(/^@/, '') || null;

    await dbRun('UPDATE users SET name = ?, twitter = ? WHERE id = ?', [name, twitter, req.user.id]);
    const updated = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);

    res.json({ success: true, message: 'Profile updated!', user: publicUser(updated) });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Log out (this browser only)
app.post('/api/logout', requireAuth, async (req, res) => {
  try {
    await dbRun('DELETE FROM sessions WHERE token_hash = ?', [req.tokenHash]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Routes: public data
// ---------------------------------------------------------------------------

// Get a (public) user by wallet address
app.get('/api/users/:address', async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE address = ? AND verified = 1 AND hidden = 0', [req.params.address]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(listUser(user));
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Leaderboard: ranked by how much each person has GIVEN
app.get('/api/users', async (req, res) => {
  try {
    const users = await dbAll(
      'SELECT * FROM users WHERE verified = 1 AND hidden = 0 ORDER BY total_gifted DESC, created_at ASC LIMIT 100'
    );
    res.json(users.map(listUser));
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Get random user
app.get('/api/random-user', async (req, res) => {
  try {
    const exclude = (req.query.exclude || '').toString();
    const user = await dbGet(
      'SELECT * FROM users WHERE verified = 1 AND hidden = 0 AND address != ? ORDER BY RANDOM() LIMIT 1',
      [exclude]
    );
    if (!user) {
      return res.status(404).json({ error: 'No other verified members yet' });
    }
    res.json(listUser(user));
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Send gift (must be logged in; it is always sent FROM your own wallet)
app.post('/api/gifts', requireAuth, async (req, res) => {
  try {
    const fromAddress = req.user.address;
    const toAddress = (req.body.to_address || '').toString().trim();
    const amount = Number(req.body.amount);

    if (!toAddress || !Number.isFinite(amount)) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (amount <= 0 || amount > 1000) {
      return res.status(400).json({ error: 'Amount must be between 0 and 1000 SOL' });
    }
    if (fromAddress === toAddress) {
      return res.status(400).json({ error: 'Cannot send gift to yourself!' });
    }

    const isCreator = toAddress === CREATOR_WALLET;
    if (!isCreator) {
      const recipient = await dbGet('SELECT id FROM users WHERE address = ? AND verified = 1', [toAddress]);
      if (!recipient) return res.status(400).json({ error: 'Recipient is not a community member' });
    }

    if (rateLimited(`gift:${req.user.id}`, 20, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Slow down! Too many gifts in the last hour.' });
    }

    await dbRun('INSERT INTO gifts (from_address, to_address, amount) VALUES (?, ?, ?)', [fromAddress, toAddress, amount]);
    await dbRun('UPDATE users SET total_gifted = total_gifted + ? WHERE id = ?', [amount, req.user.id]);

    res.json({ success: true, message: 'Gift sent! 🎉' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Get recent gifts (for feed)
app.get('/api/gifts', async (req, res) => {
  try {
    const gifts = await dbAll(
      `SELECT g.id, g.amount, g.created_at,
              CASE WHEN u.hidden = 1 THEN NULL ELSE u.name END AS from_name,
              CASE WHEN u.hidden = 1 THEN NULL ELSE u.twitter END AS from_twitter,
              CASE WHEN g.to_address = ? THEN 'the creator 🎅'
                   WHEN r.hidden = 1 THEN NULL ELSE r.name END AS to_name
       FROM gifts g
       LEFT JOIN users u ON g.from_address = u.address
       LEFT JOIN users r ON g.to_address = r.address
       ORDER BY g.created_at DESC
       LIMIT 50`,
      [CREATOR_WALLET]
    );
    res.json(gifts);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const totals = await dbGet(
      `SELECT COALESCE(SUM(amount), 0) AS total_sol, COUNT(*) AS gift_count,
              COUNT(DISTINCT from_address) AS unique_gifters
       FROM gifts`
    );
    const users = await dbGet('SELECT COUNT(*) AS count FROM users WHERE verified = 1 AND hidden = 0');

    const totalSOL = Number(totals.total_sol) || 0;
    const giftCount = Number(totals.gift_count) || 0;

    res.json({
      totalSOL: totalSOL.toFixed(2),
      giftCount,
      userCount: Number(users.count) || 0,
      uniqueGifters: Number(totals.unique_gifters) || 0,
      avgGift: (giftCount > 0 ? totalSOL / giftCount : 0).toFixed(2)
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Admin (only works if ADMIN_PASSWORD is set in Render > Environment).
// The password is NOT stored in the code because the GitHub repo is public.
// ---------------------------------------------------------------------------
function checkAdmin(req, res) {
  const key = `admin-fail:${clientIp(req)}`;
  const now = Date.now();
  const fails = (rateBuckets.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (fails.length >= 10) {
    res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
    return false;
  }
  if (!isAdmin(req.body.password, process.env.ADMIN_PASSWORD)) {
    fails.push(now);
    rateBuckets.set(key, fails);
    res.status(401).json({ error: 'Wrong admin password (or ADMIN_PASSWORD is not set in Render)' });
    return false;
  }
  return true;
}

function isAdmin(given, actual) {
  if (!actual || !given) return false;
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(actual));
  return crypto.timingSafeEqual(a, b);
}

// List every member (including hidden ones)
app.post('/api/admin/users', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const users = await dbAll(
      'SELECT id, name, address, twitter, total_gifted, verified, hidden, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(users);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Hide or unhide a member from the leaderboard, random picks and the feed
app.post('/api/admin/hide', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const id = Number(req.body.id);
    const hidden = req.body.hidden === false ? 0 : 1;
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'User id required' });

    const result = await dbRun('UPDATE users SET hidden = ? WHERE id = ?', [hidden, id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    // Log them out everywhere when hidden
    if (hidden) await dbRun('DELETE FROM sessions WHERE user_id = ?', [id]);

    res.json({ success: true, hidden: !!hidden });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Clear all data (reset database)
app.post('/api/admin/reset', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    await dbRun('DELETE FROM sessions');
    await dbRun('DELETE FROM gifts');
    await dbRun('DELETE FROM users');
    res.json({ success: true, message: 'Database reset! 🔄' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', database: error.message });
  }
});

initDb()
  .then(() => {
    console.log('🗄️  Database connected and tables ready');
    app.listen(port, () => {
      console.log(`✅ Server running on port ${port}`);
      console.log(`📧 Email sender: ${SENDER_EMAIL} | Brevo key ${process.env.BREVO_API_KEY ? 'set' : 'MISSING'}`);
      console.log(`🔐 Admin tools ${process.env.ADMIN_PASSWORD ? 'enabled' : 'disabled (set ADMIN_PASSWORD to enable)'}`);
    });
  })
  .catch((error) => {
    console.error('❌ Could not connect to the database:', error.message);
    process.exit(1);
  });

module.exports = { nameProblem, twitterProblem };
