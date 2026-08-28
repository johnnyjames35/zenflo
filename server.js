const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use(session({
  store: new PgSession({ pool }),
  secret: process.env.SESSION_SECRET || 'zenflo-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// ── ADMIN AUTH ─────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'callback-admin-2024';

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(401).json({ error: 'Not authorized' });
  next();
}

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password.' });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

app.get('/admin/dashboard', (req, res) => {
  if (!req.session.isAdmin) return res.redirect('/admin/login');
  res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
});

app.get('/admin/data', requireAdmin, async (req, res) => {
  try {
    const usersResult = await pool.query(`
      SELECT u.id, u.name, u.email, u.plan, u.trial_start, u.created_at,
        (SELECT COUNT(*) FROM brain_dumps b WHERE b.user_id = u.id) as brain_dump_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.user_id = u.id) as task_count,
        (SELECT COUNT(*) FROM checkins c WHERE c.user_id = u.id) as checkin_count
      FROM users u
      ORDER BY u.created_at DESC
    `);
    const users = usersResult.rows;
    const total = users.length;
    const free = users.filter(u => u.plan === 'free').length;
    const pro = users.filter(u => u.plan === 'pro').length;
    const active = users.filter(u => u.brain_dump_count > 0 || u.task_count > 0 || u.checkin_count > 0).length;
    res.json({ users, totals: { total, free, pro, active } });
  } catch (e) {
    console.error('Admin data error:', e);
    res.status(500).json({ error: 'Failed to load admin data' });
  }
});

// ── DB INIT ──────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid varchar NOT NULL COLLATE "default",
      sess json NOT NULL,
      expire timestamp(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid)
    );
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session(expire);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      trial_start TIMESTAMP DEFAULT NOW(),
      stripe_customer_id TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS brain_dumps (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      steps JSONB DEFAULT '[]',
      completed BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      mood TEXT,
      energy TEXT,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('✅ Database ready');
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function isPro(user) {
  if (user.plan === 'pro') return true;
  // 14-day free trial
  const trialStart = new Date(user.trial_start);
  const now = new Date();
  const daysDiff = (now - trialStart) / (1000 * 60 * 60 * 24);
  return daysDiff <= 14;
}

// ── ROUTES: AUTH ─────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.json({ error: 'All fields required' });
  if (password.length < 6) return res.json({ error: 'Password must be at least 6 characters' });

  try {
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (exists.rows.length) return res.json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email, plan, trial_start',
      [name.trim(), email.toLowerCase(), hash]
    );
    const user = result.rows[0];
    req.session.userId = user.id;
    req.session.userName = user.name;
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, isPro: isPro(user) } });
  } catch (e) {
    console.error(e);
    res.json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!result.rows.length) return res.json({ error: 'Email not found' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.json({ error: 'Incorrect password' });
    req.session.userId = user.id;
    req.session.userName = user.name;
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, isPro: isPro(user) } });
  } catch (e) {
    res.json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const result = await pool.query('SELECT id, name, email, plan, trial_start FROM users WHERE id=$1', [req.session.userId]);
    if (!result.rows.length) return res.json({ loggedIn: false });
    const user = result.rows[0];
    res.json({ loggedIn: true, user: { id: user.id, name: user.name, email: user.email, plan: user.plan, isPro: isPro(user) } });
  } catch (e) {
    res.json({ loggedIn: false });
  }
});

// ── ROUTES: BRAIN DUMP ────────────────────────────────────
app.post('/api/braindump', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.json({ error: 'Nothing to save' });
  try {
    const result = await pool.query(
      'INSERT INTO brain_dumps (user_id, content) VALUES ($1,$2) RETURNING *',
      [req.session.userId, content.trim()]
    );
    res.json({ success: true, dump: result.rows[0] });
  } catch (e) {
    res.json({ error: 'Save failed' });
  }
});

app.get('/api/braindump', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM brain_dumps WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.session.userId]
    );
    res.json({ dumps: result.rows });
  } catch (e) {
    res.json({ dumps: [] });
  }
});

app.delete('/api/braindump/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM brain_dumps WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    res.json({ success: true });
  } catch (e) {
    res.json({ error: 'Delete failed' });
  }
});

// ── ROUTES: TASKS ─────────────────────────────────────────
app.post('/api/tasks', requireAuth, async (req, res) => {
  const { title, steps } = req.body;
  if (!title) return res.json({ error: 'Task title required' });
  try {
    const result = await pool.query(
      'INSERT INTO tasks (user_id, title, steps) VALUES ($1,$2,$3) RETURNING *',
      [req.session.userId, title.trim(), JSON.stringify(steps || [])]
    );
    res.json({ success: true, task: result.rows[0] });
  } catch (e) {
    res.json({ error: 'Save failed' });
  }
});

app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tasks WHERE user_id=$1 ORDER BY created_at DESC',
      [req.session.userId]
    );
    res.json({ tasks: result.rows });
  } catch (e) {
    res.json({ tasks: [] });
  }
});

app.patch('/api/tasks/:id', requireAuth, async (req, res) => {
  const { completed } = req.body;
  try {
    await pool.query(
      'UPDATE tasks SET completed=$1 WHERE id=$2 AND user_id=$3',
      [completed, req.params.id, req.session.userId]
    );
    res.json({ success: true });
  } catch (e) {
    res.json({ error: 'Update failed' });
  }
});

app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
    res.json({ success: true });
  } catch (e) {
    res.json({ error: 'Delete failed' });
  }
});

// ── ROUTES: CHECK-IN ──────────────────────────────────────
app.post('/api/checkin', requireAuth, async (req, res) => {
  const { mood, energy, note } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO checkins (user_id, mood, energy, note) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.session.userId, mood, energy, note]
    );
    res.json({ success: true, checkin: result.rows[0] });
  } catch (e) {
    res.json({ error: 'Check-in failed' });
  }
});

app.get('/api/checkin/today', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM checkins WHERE user_id=$1 AND created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 1",
      [req.session.userId]
    );
    res.json({ checkin: result.rows[0] || null });
  } catch (e) {
    res.json({ checkin: null });
  }
});

// ── ROUTES: ACCOUNT DELETION ──────────────────────────────
app.delete('/api/account', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });

  const client = await pool.connect();
  try {
    const result = await client.query('SELECT password_hash FROM users WHERE id=$1', [req.session.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Account not found' });
    const matches = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!matches) return res.status(403).json({ error: 'Incorrect password' });

    await client.query('BEGIN');
    await client.query('DELETE FROM session WHERE sid <> $1 AND sess->>\'userId\' = $2', [req.sessionID, String(req.session.userId)]);
    await client.query('DELETE FROM users WHERE id=$1', [req.session.userId]);
    await client.query('COMMIT');
    req.session.destroy(() => res.json({ success: true }));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Account deletion failed', error);
    res.status(500).json({ error: 'Account deletion failed' });
  } finally {
    client.release();
  }
});

// ── ROUTES: STRIPE PAYMENT LINKS ─────────────────────────
app.get('/api/upgrade/monthly', requireAuth, (req, res) => {
  const link = process.env.STRIPE_MONTHLY_LINK;
  if (!link) return res.status(500).json({ error: 'Payment link not configured' });
  res.redirect(link);
});

app.get('/api/upgrade/annual', requireAuth, (req, res) => {
  const link = process.env.STRIPE_ANNUAL_LINK;
  if (!link) return res.status(500).json({ error: 'Payment link not configured' });
  res.redirect(link);
});
// ── FOUNDER ACCESS (personal bookmark login) ──────────────
app.get('/founder-access', async (req, res) => {
  const key = req.query.key;
  if (!key || key !== process.env.FOUNDER_ACCESS_KEY) {
    return res.status(401).send('Not authorized');
  }
  try {
    const existing = await pool.query('SELECT id, name FROM users WHERE email=$1', ['founder@zenflo.co.uk']);
    let userId, userName;
    if (existing.rows.length) {
      userId = existing.rows[0].id;
      userName = existing.rows[0].name;
    } else {
      const randomPassword = require('crypto').randomBytes(16).toString('hex');
      const hash = await bcrypt.hash(randomPassword, 10);
      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, plan) VALUES ($1,$2,$3,$4) RETURNING id, name`,
        ['John', 'founder@zenflo.co.uk', hash, 'pro']
      );
      userId = result.rows[0].id;
      userName = result.rows[0].name;
    }
    req.session.userId = userId;
    req.session.userName = userName;
    res.redirect('/');
  } catch (e) {
    console.error('Founder access error:', e);
    res.status(500).send('Something went wrong');
  }
});

// ── SERVE APP ─────────────────────────────────────────────
app.get('*', (req, res) => {
  const host = req.headers.host || '';
  if (host === 'zenflo.co.uk' || host === 'www.zenflo.co.uk') {
    return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🌿 ZenFlo running on port ${PORT}`));
}).catch(e => {
  console.error('DB init failed:', e);
  process.exit(1);
});
