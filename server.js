const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');
const { getTrafficSummary } = require('./lib/admin-traffic.cjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ── STRIPE WEBHOOK ────────────────────────────────────────
// Must be registered BEFORE express.json(), because Stripe needs the raw,
// unparsed request body to verify the signature.
// Marks a user as Pro once Stripe confirms their payment, and back to Free
// if their subscription is cancelled.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Stripe webhook: STRIPE_WEBHOOK_SECRET not set');
    return res.status(500).send('Webhook not configured');
  }

  let event;
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_not_used_for_verification');
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (e) {
    console.error('Stripe webhook signature check failed:', e.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
        const customerId = session.customer || null;
        let result = { rowCount: 0 };
        const userId = parseInt(session.client_reference_id, 10);
        if (Number.isInteger(userId)) {
          result = await pool.query(
            "UPDATE users SET plan='pro', stripe_customer_id=COALESCE($2, stripe_customer_id) WHERE id=$1",
            [userId, customerId]
          );
        }
        if (!result.rowCount) {
          const email = ((session.customer_details && session.customer_details.email) || session.customer_email || '').toLowerCase();
          if (email) {
            result = await pool.query(
              "UPDATE users SET plan='pro', stripe_customer_id=COALESCE($2, stripe_customer_id) WHERE email=$1",
              [email, customerId]
            );
          }
        }
        if (!result.rowCount) {
          console.error('Stripe webhook: payment received but no matching ZenFlo user', session.id);
        } else {
          console.log('Stripe webhook: user upgraded to Pro');
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const customerId = event.data.object.customer;
      if (customerId) {
        await pool.query("UPDATE users SET plan='free' WHERE stripe_customer_id=$1 AND plan='pro'", [customerId]);
        console.log('Stripe webhook: subscription ended, user set back to Free');
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook handler error:', e);
    res.status(500).send('Webhook handler failed');
  }
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

app.get('/admin/traffic', requireAdmin, async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await getTrafficSummary({ hosts: ['zenflo.co.uk', 'www.zenflo.co.uk', 'app.zenflo.co.uk'] }));
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
app.post('/admin/recover', (req, res) => {
  const { recoveryKey } = req.body;
  if (recoveryKey && recoveryKey === process.env.ADMIN_RECOVERY_KEY) {
    res.json({ success: true, password: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Invalid recovery key' });
  }
});

app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('Admin delete user error:', e);
    res.status(500).json({ error: 'Delete failed' });
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

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nudge_stage INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_optout BOOLEAN DEFAULT false;
  `);

  console.log('✅ Database ready');
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

const TRIAL_DAYS = 14;
const FREE_TASKS_PER_DAY = 3;

function isPro(user) {
  if (user.plan === 'pro') return true;
  // 14-day free trial
  const trialStart = new Date(user.trial_start);
  const now = new Date();
  const daysDiff = (now - trialStart) / (1000 * 60 * 60 * 24);
  return daysDiff <= TRIAL_DAYS;
}

// Whole days left in the free trial (0 once it has ended or for paid users)
function trialDaysLeft(user) {
  if (user.plan === 'pro') return 0;
  const daysDiff = (new Date() - new Date(user.trial_start)) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.ceil(TRIAL_DAYS - daysDiff));
}

function userPayload(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    plan: user.plan,
    isPro: isPro(user),
    trialDaysLeft: trialDaysLeft(user)
  };
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
    res.json({ success: true, user: userPayload(user) });
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
    res.json({ success: true, user: userPayload(user) });
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
    res.json({ loggedIn: true, user: userPayload(user) });
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
    // Free plan (trial ended, not paid): limited to 3 new tasks per day
    const userResult = await pool.query('SELECT id, plan, trial_start FROM users WHERE id=$1', [req.session.userId]);
    if (!userResult.rows.length) return res.json({ error: 'Not logged in' });
    if (!isPro(userResult.rows[0])) {
      const countResult = await pool.query(
        "SELECT COUNT(*)::int AS n FROM tasks WHERE user_id=$1 AND created_at >= date_trunc('day', NOW())",
        [req.session.userId]
      );
      if (countResult.rows[0].n >= FREE_TASKS_PER_DAY) {
        return res.json({
          error: `Free plan includes ${FREE_TASKS_PER_DAY} new tasks a day. Upgrade to Pro for unlimited tasks.`,
          limitReached: true
        });
      }
    }
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
// The user's ZenFlo id and email are attached to the Stripe link so the
// webhook above knows which account to upgrade once payment completes.
async function sendToPaymentLink(req, res, link) {
  if (!link) return res.status(500).json({ error: 'Payment link not configured' });
  try {
    const result = await pool.query('SELECT id, email FROM users WHERE id=$1', [req.session.userId]);
    if (!result.rows.length) return res.status(401).json({ error: 'Not logged in' });
    const url = new URL(link);
    url.searchParams.set('client_reference_id', String(result.rows[0].id));
    url.searchParams.set('prefilled_email', result.rows[0].email);
    res.redirect(url.toString());
  } catch (e) {
    console.error('Upgrade link error:', e);
    res.redirect(link);
  }
}

app.get('/api/upgrade/monthly', requireAuth, (req, res) => sendToPaymentLink(req, res, process.env.STRIPE_MONTHLY_LINK));

app.get('/api/upgrade/annual', requireAuth, (req, res) => sendToPaymentLink(req, res, process.env.STRIPE_ANNUAL_LINK));

// ── ROUTES: AI CHAT WIDGET ────────────────────────────────
// Public-facing support bot for zenflo.co.uk and app.zenflo.co.uk.
// Answers using only the ZENFLO_KNOWLEDGE text below — kept deliberately
// narrow so it can't invent claims about the app. Costs pay-per-use
// (Anthropic API), no monthly subscription.

const ZENFLO_KNOWLEDGE = `
ABOUT ZENFLO
ZenFlo is a web-based ADHD workplace app (app.zenflo.co.uk) built by Cambrian Digital / Big Bulldog UK Ltd.
It is a productivity and structure tool — it does not diagnose, treat or manage ADHD as a medical condition,
and should never be described as doing so.

PRICING
- Free plan (£0): brain dump, 3 tasks/day, 10 workplace scripts, focus timer, daily check-in.
- Pro plan: £9.99/month or £99/year, includes a 14-day free trial, no card required to start.
  Pro unlocks unlimited tasks, all 25 workplace scripts, and the wind-down tool.
- Sign up at https://app.zenflo.co.uk

THE SIX CORE FEATURES
1. Brain Dump — type or paste everything on your mind, in any order. ZenFlo automatically sorts it into
   tasks, worries and ideas. Best used first thing in the morning or whenever your head feels too full.
2. Break It Down — splits any task into small, timed steps, with a "Start here, right now" prompt so you
   always know the very next action. Best for tasks that feel too big to start.
3. Workplace Scripts — 25 ready-made scripts for emails, meetings, deadline extensions and tricky
   conversations, for when the right words won't come. Free plan includes 10, Pro unlocks all 25.
4. Focus Timer — structured focus sessions in manageable bursts with built-in rest, designed for the
   ADHD brain, so tasks actually get finished.
5. Daily Check-in — log mood and energy at the start of the day; ZenFlo adapts the day's plan around how
   the user actually feels rather than a fixed plan.
6. Wind Down (Pro) — an end-of-day routine to note what got done, park unfinished items for tomorrow, and
   close the day without a guilt spiral.

SUPPORT
For anything the bot can't answer, or to request account/data deletion, contact hello@zenflo.co.uk.
Full guide: https://zenflo.co.uk/how-to-use.html — ADHD articles: https://zenflo.co.uk/knowledge-centre.html
`;

// Scoped CORS - only for the chat endpoint, so the rest of the app's
// session-cookie-protected routes are completely unaffected.
const CHAT_ALLOWED_ORIGINS = [
  'https://zenflo.co.uk',
  'https://www.zenflo.co.uk',
  'https://app.zenflo.co.uk'
];

function chatCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && CHAT_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// Very simple in-memory rate limit: 20 messages per IP per hour.
// Resets on redeploy - fine for a v1 at ZenFlo's current traffic level.
const chatRateLimit = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const entry = chatRateLimit.get(ip) || { count: 0, resetAt: now + hour };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + hour;
  }
  entry.count += 1;
  chatRateLimit.set(ip, entry);
  return entry.count <= 20;
}

app.options('/api/chat', chatCors);

app.post('/api/chat', chatCors, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 800) return res.status(400).json({ error: 'Message is too long' });

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "You've sent a lot of messages — please try again in a bit, or email hello@zenflo.co.uk" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Chat error: ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'Chat is not configured yet. Please email hello@zenflo.co.uk' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        system: `You are the friendly support assistant on the ZenFlo website. Answer ONLY using the information below. If the answer isn't in this information, say you're not sure and point the person to hello@zenflo.co.uk rather than guessing. Keep answers short (2-4 sentences), warm, and plain-English — many visitors have ADHD, so avoid long blocks of text. Never claim ZenFlo diagnoses, treats or manages ADHD as a medical condition; it's a productivity and structure tool.\n\n${ZENFLO_KNOWLEDGE}`,
        messages: [{ role: 'user', content: message.trim() }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(502).json({ error: "Something went wrong on our end — try again, or email hello@zenflo.co.uk" });
    }

    const data = await response.json();
    const reply = data.content && data.content[0] && data.content[0].text
      ? data.content[0].text
      : "Sorry, I couldn't work out an answer to that — try emailing hello@zenflo.co.uk";

    res.json({ reply });
  } catch (e) {
    console.error('Chat error:', e);
    res.status(500).json({ error: "Something went wrong — try again, or email hello@zenflo.co.uk" });
  }
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

// ── NUDGE EMAILS (day 1 / 3 / 7 after sign-up) ─────────────
// Short, friendly emails to NEW free users only (signed up within the last
// 10 days). Skipped if the user already used the app in the last 24 hours,
// and never sent twice. Each email has an unsubscribe link.
const crypto = require('crypto');
const NUDGE_BASE = 'https://app.zenflo.co.uk';
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function unsubToken(id) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'zenflo').update('unsub:' + id).digest('hex').slice(0, 32);
}
function unsubLink(id) { return NUDGE_BASE + '/unsubscribe?u=' + id + '&t=' + unsubToken(id); }
function dueNudgeStage(ageDays) { return ageDays >= 7 ? 3 : ageDays >= 3 ? 2 : ageDays >= 1 ? 1 : 0; }

async function sendBrevoEmail({ to, subject, html }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'John at ZenFlo', email: 'johnjames@bigbulldog.co.uk' },
      replyTo: { name: 'ZenFlo', email: 'hello@zenflo.co.uk' },
      to: [{ email: to }],
      subject: subject,
      htmlContent: html
    })
  });
  if (!response.ok) throw new Error('Brevo error: ' + (await response.text()));
  return response.json();
}

function nudgeEmail(stage, user) {
  const name = escHtml(user.name);
  const copy = {
    1: { subject: 'One thing, 30 seconds', lines: [
      'No setup needed.',
      'Open ZenFlo, type one thing that is on your mind, and tap Save. That is the whole thing.'] },
    2: { subject: 'Putting something off?', lines: [
      'If there is a task you keep avoiding, ZenFlo can shrink it.',
      'Type the task, add just the first tiny step, and stop there.'] },
    3: { subject: 'About a week left of your free Pro trial', lines: [
      'You have about a week left of your free Pro trial.',
      'If ZenFlo has helped even once, brilliant. If it has not, just hit reply and tell me what got in the way. One line is plenty.'] }
  }[stage];
  const p = 'style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1f2a37;"';
  const html = '<div style="background:#f4f7f5;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">' +
    '<div style="background:#0D1B2A;padding:20px 24px;"><span style="color:#4DC4A0;font-size:24px;font-weight:bold;">ZenFlo</span></div>' +
    '<div style="padding:28px 24px 12px;">' +
    '<p ' + p + '>Hi ' + name + ',</p>' +
    copy.lines.map(l => '<p ' + p + '>' + l + '</p>').join('') +
    '<p style="margin:24px 0;"><a href="' + NUDGE_BASE + '/" style="background:#1B8A6B;color:#ffffff;padding:14px 26px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block;">Open ZenFlo</a></p>' +
    '<p ' + p + '>John</p></div>' +
    '<div style="padding:16px 24px 24px;border-top:1px solid #e5e9e7;font-size:12px;line-height:1.5;color:#6b7280;">' +
    'You are getting this because you signed up to ZenFlo. ZenFlo is a service of Big Bulldog UK Ltd. ' +
    '<a href="' + unsubLink(user.id) + '" style="color:#6b7280;">Unsubscribe</a></div>' +
    '</div></div>';
  return { subject: copy.subject, html };
}

async function runNudges() {
  if (!process.env.BREVO_API_KEY) return;
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, COALESCE(u.nudge_stage, 0) AS nudge_stage,
             EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 86400 AS age_days,
             (EXISTS (SELECT 1 FROM brain_dumps b WHERE b.user_id = u.id AND b.created_at > NOW() - INTERVAL '24 hours')
              OR EXISTS (SELECT 1 FROM tasks t WHERE t.user_id = u.id AND t.created_at > NOW() - INTERVAL '24 hours')
              OR EXISTS (SELECT 1 FROM checkins c WHERE c.user_id = u.id AND c.created_at > NOW() - INTERVAL '24 hours')) AS active_today
      FROM users u
      WHERE u.plan = 'free'
        AND COALESCE(u.email_optout, false) = false
        AND COALESCE(u.nudge_stage, 0) < 3
        AND u.created_at > NOW() - INTERVAL '10 days'
        AND u.created_at <= NOW() - INTERVAL '1 day'
        AND u.email <> 'founder@zenflo.co.uk'
      LIMIT 20`);
    for (const u of result.rows) {
      const due = dueNudgeStage(Number(u.age_days));
      if (due <= Number(u.nudge_stage)) continue;
      const claimed = await pool.query(
        'UPDATE users SET nudge_stage=$2 WHERE id=$1 AND COALESCE(nudge_stage,0) < $2', [u.id, due]);
      if (!claimed.rowCount) continue;
      if (u.active_today) continue;
      try {
        const mail = nudgeEmail(due, u);
        await sendBrevoEmail({ to: u.email, subject: mail.subject, html: mail.html });
        console.log('Nudge email ' + due + ' sent to user ' + u.id);
      } catch (e) {
        console.error('Nudge email failed for user ' + u.id + ':', e.message);
      }
    }
  } catch (e) {
    console.error('Nudge run failed:', e.message);
  }
}
function startNudges() {
  setTimeout(runNudges, 60 * 1000);
  setInterval(runNudges, 60 * 60 * 1000);
}

app.get('/unsubscribe', async (req, res) => {
  const id = parseInt(req.query.u, 10);
  const t = String(req.query.t || '');
  const ok = Number.isInteger(id) && t.length === 32 &&
    crypto.timingSafeEqual(Buffer.from(t), Buffer.from(unsubToken(id)));
  if (!ok) return res.status(400).send('This unsubscribe link is not valid.');
  try {
    await pool.query('UPDATE users SET email_optout=true WHERE id=$1', [id]);
    res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial,sans-serif;background:#0D1B2A;color:#F4F7F5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;"><div style="max-width:420px;padding:24px;text-align:center;"><h2 style="color:#4DC4A0;">You are unsubscribed</h2><p>We will not send you any more ZenFlo reminder emails.</p></div></body>');
  } catch (e) {
    res.status(500).send('Something went wrong. Please email hello@zenflo.co.uk');
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
  startNudges();
}).catch(e => {
  console.error('DB init failed:', e);
  process.exit(1);
});
