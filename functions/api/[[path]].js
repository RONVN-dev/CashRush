const COOKIE_NAME = 'ccr_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const ADMIN_USERNAME = 'AdminLee';
const ADMIN_PASSWORD = 'AdminLee';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '') || 'me';

  if (request.method === 'OPTIONS') return json({ ok: true });
  if (!env.DB) return json({ error: 'D1 binding DB is not configured.' }, 500);

  try {
    if (route === 'register' && request.method === 'POST') return register(request, env);
    if (route === 'login' && request.method === 'POST') return login(request, env);
    if (route === 'logout' && request.method === 'POST') return logout(request, env);
    if (route === 'me' && request.method === 'GET') return me(request, env);
    if (route === 'balance' && request.method === 'POST') return saveBalance(request, env);
    if (route === 'hourly' && request.method === 'POST') return hourly(request, env);
    if (route === 'reward-ad' && request.method === 'POST') return rewardAd(request, env);
    if (route === 'admin/add-tokens' && request.method === 'POST') return adminAddTokens(request, env);
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    return json({ error: error.message || 'Server error.' }, 500);
  }
}

async function register(request, env) {
  const body = await readJson(request);
  const username = cleanUsername(body.username);
  const password = String(body.password || '');
  const startingBalance = clampNumber(body.balance, 1000, 0, 1_000_000_000);

  if (!username || password.length < 3) return json({ error: 'Enter a username and a password with at least 3 characters.' }, 400);
  if (username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) return json({ error: 'That username is reserved.' }, 409);

  const existing = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(username).first();
  if (existing) return json({ error: 'That username already exists.' }, 409);

  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt);
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO users (username, password_hash, salt, balance, last_hourly_grant, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(username, passwordHash, salt, startingBalance, now, now).run();

  const token = await createSession(env, username, false);
  return json({ username, balance: startingBalance, isAdmin: false }, 200, sessionCookie(request, token));
}

async function login(request, env) {
  const body = await readJson(request);
  const username = cleanUsername(body.username);
  const password = String(body.password || '');

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = await createSession(env, ADMIN_USERNAME, true);
    return json({ username: ADMIN_USERNAME, balance: 1000, isAdmin: true }, 200, sessionCookie(request, token));
  }

  const user = await env.DB.prepare('SELECT username, password_hash, salt, balance FROM users WHERE username = ?').bind(username).first();
  if (!user) return json({ error: 'Incorrect username or password.' }, 401);

  const passwordHash = await hashPassword(password, user.salt);
  if (passwordHash !== user.password_hash) return json({ error: 'Incorrect username or password.' }, 401);

  const token = await createSession(env, user.username, false);
  return json({ username: user.username, balance: Number(user.balance) || 1000, isAdmin: false }, 200, sessionCookie(request, token));
}

async function logout(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true }, 200, clearSessionCookie(request));
}

async function me(request, env) {
  const session = await requireSession(request, env, false);
  if (!session) return json({ username: null, balance: 1000, isAdmin: false });
  if (session.is_admin) return json({ username: ADMIN_USERNAME, balance: 1000, isAdmin: true });
  const user = await env.DB.prepare('SELECT username, balance FROM users WHERE username = ?').bind(session.username).first();
  if (!user) return json({ username: null, balance: 1000, isAdmin: false }, 200, clearSessionCookie(request));
  return json({ username: user.username, balance: Number(user.balance) || 1000, isAdmin: false });
}

async function saveBalance(request, env) {
  const session = await requireSession(request, env, true);
  if (session.is_admin) return json({ ok: true, balance: 1000 });
  const body = await readJson(request);
  const balance = clampNumber(body.balance, 1000, 0, 1_000_000_000);
  await env.DB.prepare('UPDATE users SET balance = ? WHERE username = ?').bind(balance, session.username).run();
  return json({ ok: true, balance });
}

async function hourly(request, env) {
  const session = await requireSession(request, env, true);
  if (session.is_admin) return json({ grant: 0, balance: 1000 });

  const user = await env.DB.prepare('SELECT balance, last_hourly_grant FROM users WHERE username = ?').bind(session.username).first();
  if (!user) return json({ error: 'User not found.' }, 404);

  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const last = Number(user.last_hourly_grant) || now;
  const hours = Math.floor((now - last) / hour);
  if (hours <= 0) return json({ grant: 0, balance: Number(user.balance) || 1000 });

  const grant = hours * 100;
  const newBalance = roundMoney((Number(user.balance) || 0) + grant);
  const newLast = last + hours * hour;
  await env.DB.prepare('UPDATE users SET balance = ?, last_hourly_grant = ? WHERE username = ?').bind(newBalance, newLast, session.username).run();
  return json({ grant, balance: newBalance });
}

async function rewardAd(request, env) {
  const session = await requireSession(request, env, true);
  if (session.is_admin) return json({ error: 'Admin accounts do not receive ad rewards.' }, 403);
  const user = await env.DB.prepare('SELECT balance FROM users WHERE username = ?').bind(session.username).first();
  if (!user) return json({ error: 'User not found.' }, 404);
  const balance = roundMoney((Number(user.balance) || 0) + 1000);
  await env.DB.prepare('UPDATE users SET balance = ? WHERE username = ?').bind(balance, session.username).run();
  return json({ reward: 1000, balance });
}

async function adminAddTokens(request, env) {
  const session = await requireSession(request, env, true);
  if (!session.is_admin) return json({ error: 'Admin access required.' }, 403);
  const body = await readJson(request);
  const username = cleanUsername(body.username);
  const amount = clampNumber(body.amount, 0, -1_000_000_000, 1_000_000_000);
  if (!username || !Number.isFinite(amount)) return json({ error: 'Enter a username and token amount.' }, 400);

  const user = await env.DB.prepare('SELECT balance FROM users WHERE username = ?').bind(username).first();
  if (!user) return json({ error: 'User not found.' }, 404);
  const balance = roundMoney((Number(user.balance) || 0) + amount);
  await env.DB.prepare('UPDATE users SET balance = ? WHERE username = ?').bind(balance, username).run();
  return json({ username, amount, balance });
}

async function requireSession(request, env, strict) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) {
    if (strict) throw new Error('Not logged in.');
    return null;
  }
  const session = await env.DB.prepare('SELECT token, username, is_admin, expires_at FROM sessions WHERE token = ?').bind(token).first();
  if (!session || Number(session.expires_at) < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    if (strict) throw new Error('Session expired. Please log in again.');
    return null;
  }
  return { ...session, is_admin: Number(session.is_admin) === 1 };
}

async function createSession(env, username, isAdmin) {
  const token = randomHex(32);
  const expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
  await env.DB.prepare('INSERT INTO sessions (token, username, is_admin, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, username, isAdmin ? 1 : 0, expiresAt)
    .run();
  return token;
}

function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return { 'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}${secure}` };
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return { 'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}` };
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const parts = cookie.split(';').map(v => v.trim());
  for (const part of parts) {
    const [k, ...rest] = part.split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function cleanUsername(value) {
  return String(value || '').trim().slice(0, 32).replace(/[^a-zA-Z0-9_\-]/g, '');
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
