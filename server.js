const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize SQLite database
const db = new sqlite3.Database(':memory:');

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE,
    twitter TEXT,
    total_gifted REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS gifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Helper function for async database operations
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

// Routes

// Join community
app.post('/api/users', async (req, res) => {
  try {
    const { name, address } = req.body;

    if (!name || !address) {
      return res.status(400).json({ error: 'Name and address required' });
    }

    if (address.length !== 44) {
      return res.status(400).json({ error: 'Invalid Solana address' });
    }

    // Check if address already exists
    const existing = await dbGet('SELECT * FROM users WHERE address = ?', [address]);
    if (existing) {
      return res.status(400).json({ error: 'This address is already registered' });
    }

    // Insert new user
    await dbRun('INSERT INTO users (name, address) VALUES (?, ?)', [name, address]);

    res.json({ success: true, message: 'Welcome to the community!' });
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
    res.json(user);
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
    const users = await dbAll('SELECT * FROM users ORDER BY total_gifted DESC LIMIT 100');
    res.json(users);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get random user
app.get('/api/users/random', async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users ORDER BY RANDOM() LIMIT 1');
    if (!user) {
      return res.status(404).json({ error: 'No users found' });
    }
    res.json(user);
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

    res.json({ success: true, message: 'Gift recorded!' });
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
    const users = await dbAll('SELECT COUNT(*) as count FROM users');

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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
