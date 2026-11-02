const encoder = new TextEncoder();
const schemaReady = new WeakMap();
const now = () => Math.floor(Date.now() / 1000);
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations: 100000 }, key, 256));
}
async function equalSecret(a, b) {
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
export async function initializeSchema(db, schema) {
  const statements = schema.replace(/--[^\n]*/g, '').split(';').map(sql => sql.trim()).filter(Boolean);
  if (!schemaReady.has(db)) schemaReady.set(db, db.batch(statements.map(sql => db.prepare(sql))).catch(error => { schemaReady.delete(db); throw error; }));
  await schemaReady.get(db);
}
export async function siteSettings(db) {
  const row = await db.prepare('SELECT site_name, language FROM app_settings WHERE id=1').first();
  return row ? { siteName: row.site_name, language: row.language } : null;
}
function bearer(request) {
  return request.headers.get('X-Admin-Token') || request.headers.get('Authorization')?.replace(/^Bearer /, '') || new URL(request.url).searchParams.get('token') || '';
}
export async function checkAuth(request, env) {
  const token = bearer(request);
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  return Boolean(await env.QUIZ_DB.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at>?').bind(await digest(token), now()).first());
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function limited(request, db) {
  const key = await digest(request.headers.get('CF-Connecting-IP') || 'local');
  await db.prepare('INSERT INTO login_attempts(client_hash,attempts,window_start) VALUES(?,1,?) ON CONFLICT(client_hash) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END, window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END').bind(key, now(), now()-900, now()-900).run();
  const row = await db.prepare('SELECT attempts FROM login_attempts WHERE client_hash=?').bind(key).first();
  return { key, blocked: row.attempts > 10 };
}
export async function accountRoute(request, env) {
  const path = new URL(request.url).pathname;
  if (path === '/api/site' && request.method === 'GET') return json({ configured: Boolean(await siteSettings(env.QUIZ_DB)), settings: await siteSettings(env.QUIZ_DB), setupKeyConfigured: typeof env.SETUP_TOKEN === 'string' && env.SETUP_TOKEN.length >= 24 });
  if (!['/api/setup', '/api/auth/login', '/api/auth/logout'].includes(path)) return null;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origin not allowed' }, 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'JSON required' }, 415);
  const db = env.QUIZ_DB;
  if (path === '/api/auth/logout') {
    await db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await digest(bearer(request))).run();
    return json({ success: true });
  }
  const settings = await siteSettings(db);
  if (path === '/api/setup' && settings) return json({ error: 'Setup is already complete' }, 409);
  if (path === '/api/setup' && (typeof env.SETUP_TOKEN !== 'string' || env.SETUP_TOKEN.length < 24)) return json({ error: 'Set a unique SETUP_TOKEN deployment secret of at least 24 characters before setup' }, 503);
  const limit = await limited(request, db);
  if (limit.blocked) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
  let data;
  try { data = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Invalid request' }, 400);
  if (typeof data.password !== 'string' || data.password.length > 128) return json({ error: 'Invalid password' }, 400);
  if (path === '/api/setup') {
    if (!await equalSecret(String(data.setupKey || ''), env.SETUP_TOKEN)) return json({ error: 'Invalid setup key' }, 403);
    if (data.password.length < 12 || typeof data.siteName !== 'string' || !data.siteName.trim() || data.siteName.length > 80 || !['en', 'zh-CN'].includes(data.language)) return json({ error: 'Enter a site name (1–80 characters), a language, and a password of 12–128 characters' }, 400);
    const salt = random(), hash = await passwordHash(data.password, salt);
    try {
      await db.prepare('INSERT INTO app_settings(id,site_name,language,password_salt,password_hash,created_at) VALUES(1,?,?,?,?,?)').bind(data.siteName.trim(), data.language, salt, hash, now()).run();
    } catch {
      if (await siteSettings(db)) return json({ error: 'Setup is already complete' }, 409);
      throw new Error('Could not save configuration');
    }
    return json({ success: true });
  }
  const credentials = await db.prepare('SELECT password_salt,password_hash FROM app_settings WHERE id=1').first();
  if (!credentials || !await equalSecret(await passwordHash(data.password, credentials.password_salt), credentials.password_hash)) return json({ error: 'Invalid password' }, 401);
  const token = random();
  await db.batch([
    db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').bind(now()),
    db.prepare('INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)').bind(await digest(token), now()+43200),
    db.prepare('DELETE FROM login_attempts WHERE client_hash=?').bind(limit.key),
  ]);
  return json({ success: true, token, expiresIn: 43200 });
}
