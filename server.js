const express = require('express');
const cors = require('cors');
const { Pool, types } = require('pg');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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

  await pool.query(`CREATE TABLE IF NOT EXISTS gifts (
    id SERIAL PRIMARY KEY,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

// Helper function to generate verification code
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const CODE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CODE_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between emails
const lastSentAt = new Map();

// Sender MUST be a verified sender in Brevo (Settings > Senders, domains, IPs)
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'archie.swarbrick1@gmail.com';
const SENDER_NAME = process.env.BREVO_SENDER_NAME || 'Christmas SOL Gift';

// Remove secret fields before sending a user to the browser
function publicUser(user) {
  if (!user) return user;
  const { verification_code, code_expires_at, code_attempts, ...safe } = user;
  return safe;
}

// Same, but also hides email (for leaderboard / random recipient / lookups by others)
function listUser(user) {
  if (!user) return user;
  const { email, ...safe } = publicUser(user);
  return safe;
}

function normalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

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
async function issueCode(email, purpose) {
  const last = lastSentAt.get(email) || 0;
  const wait = RESEND_COOLDOWN_MS - (Date.now() - last);
  if (wait > 0) {
    return { ok: false, status: 429, error: `Please wait ${Math.ceil(wait / 1000)}s before requesting another code` };
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

// Helpers for database operations.
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

// Routes

// Join community (with email)
app.post('/api/users', async (req, res) => {
  try {
    const name = (req.body.name || '').toString().trim();
    const email = normalizeEmail(req.body.email);
    const address = (req.body.address || '').toString().trim();

    if (!name || !email || !address) {
      return res.status(400).json({ error: 'Name, email, and address required' });
    }

    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return res.status(400).json({ error: 'Invalid Solana address' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
    const result = await issueCode(email, 'verify');
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    res.json({
      success: true,
      message: 'Check your email for the verification code.',
      email
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
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

    const result = await issueCode(email, user.verified ? 'login' : 'verify');
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    res.json({ success: true, message: 'New code sent! Check your email.' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
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

    res.json({ success: true, message: 'Email verified! 🎉', user: publicUser(updated) });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
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
    const result = await issueCode(email, purpose);
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    res.json({ success: true, codeSent: true, purpose, message: 'Check your email for your code.' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
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

    res.json({ success: true, user: publicUser(updated) });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user by address
app.get('/api/users/:address', async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE address = ?', [req.params.address]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(listUser(user));
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user by email
app.get('/api/users/email/:email', async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [normalizeEmail(req.params.email)]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(publicUser(user));
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update user profile
app.put('/api/users/:address', async (req, res) => {
  try {
    const { name, twitter } = req.body;
    const address = req.params.address;

    // Check if user exists
    const existing = await dbGet('SELECT * FROM users WHERE address = ?', [address]);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update user
    await dbRun(
      'UPDATE users SET name = ?, twitter = ? WHERE address = ?',
      [name || existing.name, twitter || null, address]
    );

    res.json({ success: true, message: 'Profile updated!' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all users (for leaderboard)
app.get('/api/users', async (req, res) => {
  try {
    const users = await dbAll('SELECT * FROM users WHERE verified = 1 ORDER BY total_gifted DESC LIMIT 100');
    res.json(users.map(listUser));
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get random user
app.get('/api/random-user', async (req, res) => {
  try {
    const exclude = (req.query.exclude || '').toString();
    const user = await dbGet('SELECT * FROM users WHERE verified = 1 AND address != ? ORDER BY RANDOM() LIMIT 1', [exclude]);
    if (!user) {
      return res.status(404).json({ error: 'No other verified members yet' });
    }
    res.json(listUser(user));
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send gift
app.post('/api/gifts', async (req, res) => {
  try {
    const { from_address, to_address, amount } = req.body;

    if (!from_address || !to_address || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (from_address === to_address) {
      return res.status(400).json({ error: 'Cannot send gift to yourself!' });
    }

    // Insert gift
    await dbRun(
      'INSERT INTO gifts (from_address, to_address, amount) VALUES (?, ?, ?)',
      [from_address, to_address, amount]
    );

    // Update user total_gifted
    await dbRun(
      'UPDATE users SET total_gifted = total_gifted + ? WHERE address = ?',
      [amount, to_address]
    );

    res.json({ success: true, message: 'Gift sent! 🎉' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all gifts (for feed)
app.get('/api/gifts', async (req, res) => {
  try {
    const gifts = await dbAll(
      `SELECT g.*, u.name as from_name, u.twitter as from_twitter
       FROM gifts g
       LEFT JOIN users u ON g.from_address = u.address
       ORDER BY g.created_at DESC
       LIMIT 50`
    );
    res.json(gifts);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const gifts = await dbAll('SELECT * FROM gifts');
    const users = await dbAll('SELECT COUNT(*) as count FROM users WHERE verified = 1');

    const totalSOL = gifts.reduce((sum, gift) => sum + gift.amount, 0);
    const uniqueGifters = new Set(gifts.map(g => g.from_address)).size;
    const avgGift = gifts.length > 0 ? totalSOL / gifts.length : 0;

    res.json({
      totalSOL: totalSOL.toFixed(2),
      giftCount: gifts.length,
      userCount: users[0]?.count || 0,
      uniqueGifters,
      avgGift: avgGift.toFixed(2)
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Clear all data (reset database)
// Only works if ADMIN_PASSWORD is set in Render > Environment (it is NOT stored in the code,
// because the GitHub repo is public and anyone could read it).
app.post('/api/admin/reset', async (req, res) => {
  try {
    const { password } = req.body;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || password !== adminPassword) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await dbRun('DELETE FROM gifts');
    await dbRun('DELETE FROM users');

    res.json({ success: true, message: 'Database reset! 🔄' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
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
    });
  })
  .catch((error) => {
    console.error('❌ Could not connect to the database:', error.message);
    process.exit(1);
  });
