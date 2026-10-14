import 'dotenv/config';
import { createServer } from 'node:http';
import { randomUUID, randomInt, randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import mysqlSession from 'express-mysql-session';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';
import { createGame, playMove } from './game.js';
import { pool, query } from './db/pool.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
const secureCookies = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
if (secureCookies && !origin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS in production');

const MySQLStore = mysqlSession(session);
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: 24 * 60 * 60 * 1000,
  createDatabaseTable: true,
});
const sessionMiddleware = session({
  name: 'ttt.sid',
  secret: sessionSecret,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 24 * 60 * 60 * 1000 },
});

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", origin, 'wss:', 'ws:'] } } }));
app.use(express.json({ limit: '16kb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(dirname, '../public'), { index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const io = new SocketServer(httpServer, {
  cors: { origin, credentials: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 16_384,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
});
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const requestOrigin = socket.handshake.headers.origin;
  if (requestOrigin && requestOrigin !== origin) return next(new Error('Origin not allowed'));
  const currentSession = socket.request.session;
  (async () => {
    if (currentSession.userId) {
      const [user] = await query('SELECT suspended_at FROM users WHERE id = ?', [currentSession.userId]);
      if (!user || user.suspended_at) throw new Error('Account is unavailable.');
    }
    if (!currentSession.userId && !currentSession.guestId) currentSession.guestId = randomUUID();
    currentSession.save(next);
  })().catch(next);
});

const rooms = new Map();
const playerMatches = new Map();
const matchmaking = new Map();
const identityOf = (sessionData) => sessionData.userId ? `u:${sessionData.userId}` : `g:${sessionData.guestId}`;
const cleanUsername = (value) => typeof value === 'string' ? value.trim() : '';
const publicPlayer = (player) => ({ id: player.userId, name: player.name, symbol: player.symbol, online: player.online, registered: Boolean(player.userId) });
const code = () => randomInt(0, 36 ** 7).toString(36).toUpperCase().padStart(7, '0');

function apiError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireCsrf(req, res, next) {
  const requestOrigin = req.get('origin');
  if (requestOrigin && requestOrigin !== origin) return apiError(res, 403, 'Request origin is not allowed');
  if (!req.session.csrfToken || req.get('x-csrf-token') !== req.session.csrfToken) return apiError(res, 403, 'Invalid security token. Refresh and try again.');
  next();
}

function requireUser(req, res, next) {
  if (!req.session.userId) return apiError(res, 401, 'Sign in to use this feature.');
  query('SELECT suspended_at FROM users WHERE id = ?', [req.session.userId]).then(([user]) => {
    if (!user || user.suspended_at) {
      req.session.destroy(() => {});
      return apiError(res, user ? 403 : 401, user ? 'This account is suspended.' : 'Sign in to use this feature.');
    }
    next();
  }).catch(next);
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return apiError(res, 401, 'Sign in required.');
  try {
    const [user] = await query('SELECT role FROM users WHERE id = ? AND suspended_at IS NULL', [req.session.userId]);
    if (!user || user.role !== 'admin') return apiError(res, 403, 'Administrator access required.');
    next();
  } catch (error) { next(error); }
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false });
const actionLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

app.get('/api/bootstrap', (req, res) => {
  if (!req.session.csrfToken) req.session.csrfToken = randomUUID();
  if (!req.session.userId && !req.session.guestId) req.session.guestId = randomUUID();
  const guestName = req.session.guestName || `Guest-${req.session.guestId.slice(0, 4)}`;
  res.json({ csrfToken: req.session.csrfToken, player: req.session.userId ? { id: req.session.userId, name: req.session.username, guest: false, role: req.session.role } : { id: null, name: guestName, guest: true } });
});

app.post('/api/guest/name', requireCsrf, (req, res) => {
  const name = cleanUsername(req.body.name);
  if (!/^[\p{L}\p{N}_ -]{2,20}$/u.test(name)) return apiError(res, 400, 'Choose a name with 2 to 20 letters, numbers, spaces, _ or -.');
  req.session.guestName = name;
  res.json({ name });
});

app.post('/api/auth/register', authLimiter, requireCsrf, async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body.password;
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return apiError(res, 400, 'Username must be 3–24 letters, numbers, or underscores.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return apiError(res, 400, 'Enter a valid email address.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 72) return apiError(res, 400, 'Password must be between 10 and 72 characters.');
    const hash = await bcrypt.hash(password, 12);
    const connection = await pool.getConnection();
    let userId;
    try {
      await connection.beginTransaction();
      const [insert] = await connection.execute('INSERT INTO users (username, username_normalized, email, password_hash) VALUES (?, ?, ?, ?)', [username, username.toLowerCase(), email, hash]);
      userId = insert.insertId;
      await connection.execute('INSERT INTO player_stats (user_id) VALUES (?)', [userId]);
      if (req.body.linkGuest === true && req.session.guestId) {
        const guestId = req.session.guestId;
        const [guestResults] = await connection.execute(`SELECT mp.result FROM match_players mp JOIN matches m ON m.id = mp.match_id
          WHERE mp.guest_id = ? AND m.status = 'completed' ORDER BY m.completed_at DESC`, [guestId]);
        const wins = guestResults.filter((item) => item.result === 'win').length;
        const losses = guestResults.filter((item) => item.result === 'loss').length;
        const draws = guestResults.filter((item) => item.result === 'draw').length;
        const xp = wins * 30 + losses * 5 + draws * 10;
        let streak = 0;
        for (const item of guestResults) { if (item.result !== 'win') break; streak += 1; }
        let bestStreak = 0;
        let currentStreak = 0;
        for (const item of [...guestResults].reverse()) {
          currentStreak = item.result === 'win' ? currentStreak + 1 : 0;
          bestStreak = Math.max(bestStreak, currentStreak);
        }
        await connection.execute(`UPDATE matches m JOIN match_players mp ON mp.match_id = m.id
          SET m.winner_user_id = ? WHERE mp.guest_id = ? AND mp.result = 'win' AND m.status = 'completed'`, [userId, guestId]);
        await connection.execute(`UPDATE match_players mp JOIN matches m ON m.id = mp.match_id
          SET mp.user_id = ?, mp.guest_id = NULL WHERE mp.guest_id = ? AND m.status = 'completed'`, [userId, guestId]);
        await connection.execute(`UPDATE player_stats SET wins = ?, losses = ?, draws = ?, win_streak = ?, best_streak = ?, xp = ?, level = FLOOR(? / 250) + 1 WHERE user_id = ?`, [wins, losses, draws, streak, bestStreak, xp, xp, userId]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    await establishLogin(req, { id: userId, username, role: 'player' });
    res.status(201).json({ csrfToken: req.session.csrfToken, player: { id: userId, name: username, guest: false, role: 'player' } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return apiError(res, 409, 'That username or email is already in use.');
    next(error);
  }
});

app.post('/api/auth/login', authLimiter, requireCsrf, async (req, res, next) => {
  try {
    const login = typeof req.body.login === 'string' ? req.body.login.trim().toLowerCase() : '';
    const [user] = await query('SELECT id, username, password_hash, role, suspended_at FROM users WHERE username_normalized = ? OR email = ? LIMIT 1', [login, login]);
    const passwordValid = await bcrypt.compare(typeof req.body.password === 'string' ? req.body.password : '', user?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid12');
    if (!user || !passwordValid || user.suspended_at) return apiError(res, 401, 'Username/email or password is incorrect.');
    await establishLogin(req, user);
    res.json({ csrfToken: req.session.csrfToken, player: { id: user.id, name: user.username, guest: false, role: user.role } });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', requireCsrf, (req, res, next) => req.session.destroy((error) => {
  if (error) return next(error);
  res.clearCookie('ttt.sid', { httpOnly: true, sameSite: 'lax', secure: secureCookies });
  res.json({ ok: true });
}));

app.post('/api/auth/password/request', authLimiter, requireCsrf, async (req, res, next) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return apiError(res, 400, 'Enter a valid email address.');
  if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) return apiError(res, 503, 'Password recovery email is not configured. Contact the site administrator.');
  try {
    const [user] = await query('SELECT id FROM users WHERE email = ?', [email]);
    if (user) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await query('DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at < UTC_TIMESTAMP()', [user.id]);
      await query('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR))', [tokenHash, user.id]);
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
      });
      try {
        const resetLink = `${origin}/?reset=${encodeURIComponent(token)}`;
        await transport.sendMail({ from: process.env.SMTP_FROM, to: email, subject: 'Reset your Gridline password', text: `Use this one-time link within one hour to reset your password: ${resetLink}` });
      } catch (error) {
        await query('DELETE FROM password_reset_tokens WHERE token_hash = ?', [tokenHash]);
        throw error;
      } finally { transport.close(); }
    }
    res.json({ ok: true, message: 'If that email is registered, a reset link is on its way.' });
  } catch (error) { next(error); }
});

app.post('/api/auth/password/reset', authLimiter, requireCsrf, async (req, res, next) => {
  const token = typeof req.body.token === 'string' ? req.body.token : '';
  const password = req.body.password;
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return apiError(res, 400, 'This reset link is invalid or expired.');
  if (typeof password !== 'string' || password.length < 10 || password.length > 72) return apiError(res, 400, 'Password must be between 10 and 72 characters.');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const passwordHash = await bcrypt.hash(password, 12);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [tokens] = await connection.execute('SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP() FOR UPDATE', [tokenHash]);
    if (!tokens.length) { await connection.rollback(); return apiError(res, 400, 'This reset link is invalid or expired.'); }
    const userId = tokens[0].user_id;
    await connection.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
    await connection.execute('UPDATE password_reset_tokens SET used_at = UTC_TIMESTAMP() WHERE token_hash = ?', [tokenHash]);
    await connection.execute("DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId')) = CAST(? AS CHAR)", [userId]);
    await connection.commit();
    res.json({ ok: true, message: 'Password reset. Sign in with your new password.' });
  } catch (error) { await connection.rollback(); next(error); }
  finally { connection.release(); }
});

async function establishLogin(req, user) {
  const linkedGuestId = req.session.guestId;
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  if (linkedGuestId) req.session.linkedGuestId = linkedGuestId;
  req.session.csrfToken = randomUUID();
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

app.get('/api/profile', async (req, res, next) => {
  if (!req.session.userId) return apiError(res, 401, 'Create an account to view player stats.');
  try {
    const [stats] = await query('SELECT rating, xp, level, wins, losses, draws, win_streak, best_streak FROM player_stats WHERE user_id = ?', [req.session.userId]);
    const total = stats.wins + stats.losses + stats.draws;
    res.json({ stats: { ...stats, winRate: total ? Math.round(stats.wins * 1000 / total) / 10 : 0, total } });
  } catch (error) { next(error); }
});

app.get('/api/profile/achievements', requireUser, async (req, res, next) => {
  try {
    const achievements = await query(`SELECT a.achievement_key, a.name, a.description, a.xp_reward,
      pa.earned_at IS NOT NULL AS earned, pa.earned_at
      FROM achievements a LEFT JOIN player_achievements pa ON pa.achievement_id = a.id AND pa.user_id = ?
      WHERE a.active = TRUE ORDER BY earned DESC, a.id`, [req.session.userId]);
    res.json({ achievements });
  } catch (error) { next(error); }
});

app.get('/api/missions', requireUser, async (req, res, next) => {
  try {
    const missions = await query(`SELECT m.id, m.mission_key, m.title, m.target, m.xp_reward,
      COALESCE(p.progress, 0) AS progress, p.claimed_at
      FROM daily_missions m LEFT JOIN mission_progress p ON p.mission_id = m.id AND p.user_id = ? AND p.mission_date = UTC_DATE()
      WHERE m.active = TRUE ORDER BY m.id`, [req.session.userId]);
    res.json({ missions });
  } catch (error) { next(error); }
});

app.post('/api/missions/:id/claim', requireUser, requireCsrf, async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [missions] = await connection.execute('SELECT id, target, xp_reward FROM daily_missions WHERE id = ? AND active = TRUE FOR UPDATE', [req.params.id]);
    if (!missions.length) { await connection.rollback(); return apiError(res, 404, 'Mission not found.'); }
    const mission = missions[0];
    await connection.execute('INSERT IGNORE INTO mission_progress (user_id, mission_id, mission_date, progress) VALUES (?, ?, UTC_DATE(), 0)', [req.session.userId, mission.id]);
    const [progressRows] = await connection.execute('SELECT progress, claimed_at FROM mission_progress WHERE user_id = ? AND mission_id = ? AND mission_date = UTC_DATE() FOR UPDATE', [req.session.userId, mission.id]);
    const progress = progressRows[0];
    if (!progress || progress.progress < mission.target || progress.claimed_at) { await connection.rollback(); return apiError(res, 409, 'This mission is not ready to claim.'); }
    await connection.execute('UPDATE mission_progress SET claimed_at = UTC_TIMESTAMP() WHERE user_id = ? AND mission_id = ? AND mission_date = UTC_DATE() AND claimed_at IS NULL', [req.session.userId, mission.id]);
    await connection.execute('UPDATE player_stats SET level = FLOOR((xp + ?) / 250) + 1, xp = xp + ? WHERE user_id = ?', [mission.xp_reward, mission.xp_reward, req.session.userId]);
    await connection.commit();
    res.json({ ok: true, xp: mission.xp_reward });
  } catch (error) { await connection.rollback(); next(error); }
  finally { connection.release(); }
});

app.get('/api/leaderboard', async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'all';
    const rows = period === 'all'
      ? await query('SELECT u.username, u.avatar, s.rating, s.level, s.wins, s.losses, s.draws FROM player_stats s JOIN users u ON u.id = s.user_id WHERE u.suspended_at IS NULL ORDER BY s.rating DESC, s.wins DESC LIMIT ?', [limit])
      : await query(`SELECT u.username, u.avatar, s.rating, s.level,
        SUM(mp.result = 'win') AS wins, SUM(mp.result = 'loss') AS losses, SUM(mp.result = 'draw') AS draws
        FROM match_players mp JOIN matches m ON m.id = mp.match_id
        JOIN users u ON u.id = mp.user_id JOIN player_stats s ON s.user_id = u.id
        WHERE m.status = 'completed' AND m.mode = 'ranked' AND u.suspended_at IS NULL
          AND m.completed_at >= ${period === 'day' ? 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)' : period === 'week' ? 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)' : 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)'}
        GROUP BY u.id, u.username, u.avatar, s.rating, s.level ORDER BY wins DESC, s.rating DESC LIMIT ?`, [limit]);
    res.json({ players: rows });
  } catch (error) { next(error); }
});

app.get('/api/history', requireUser, async (req, res, next) => {
  try {
    const page = Math.min(10000, Math.max(0, Number.parseInt(req.query.page, 10) || 0));
    const rows = await query(`SELECT m.id, m.room_code, m.mode, m.board_size, m.result, m.completed_at,
      mine.symbol, mine.result AS player_result,
      (SELECT other.display_name FROM match_players other WHERE other.match_id = m.id AND other.symbol <> mine.symbol LIMIT 1) AS opponent
      FROM match_players mine JOIN matches m ON m.id = mine.match_id
      WHERE mine.user_id = ? AND m.status = 'completed' ORDER BY m.completed_at DESC LIMIT 20 OFFSET ?`, [req.session.userId, page * 20]);
    res.json({ matches: rows, page, hasMore: rows.length === 20 });
  } catch (error) { next(error); }
});

app.get('/api/matches/:id/replay', async (req, res, next) => {
  try {
    const [match] = await query('SELECT id, board_size, result, completed_at FROM matches WHERE id = ? AND status = \'completed\'', [req.params.id]);
    if (!match) return apiError(res, 404, 'Match replay not found.');
    const moves = await query('SELECT move_number, player_symbol, cell_index, created_at FROM moves WHERE match_id = ? ORDER BY move_number', [match.id]);
    res.json({ match, moves });
  } catch (error) { next(error); }
});

app.get('/api/players/search', requireUser, async (req, res, next) => {
  try {
    const term = cleanUsername(req.query.q).slice(0, 24);
    if (term.length < 2) return res.json({ players: [] });
    const players = await query('SELECT id, username, avatar FROM users WHERE username_normalized LIKE ? AND id <> ? AND suspended_at IS NULL ORDER BY username LIMIT 10', [`${term.toLowerCase()}%`, req.session.userId]);
    res.json({ players });
  } catch (error) { next(error); }
});

app.get('/api/friends', requireUser, async (req, res, next) => {
  try {
    const friends = await query(`SELECT f.requester_id, f.addressee_id, f.status, u.id, u.username, u.avatar
      FROM friends f JOIN users u ON u.id = IF(f.requester_id = ?, f.addressee_id, f.requester_id)
      WHERE f.requester_id = ? OR f.addressee_id = ? ORDER BY f.status, u.username`, [req.session.userId, req.session.userId, req.session.userId]);
    res.json({ friends });
  } catch (error) { next(error); }
});

app.post('/api/friends/request', requireUser, requireCsrf, async (req, res, next) => {
  try {
    const target = Number(req.body.userId);
    if (!Number.isSafeInteger(target) || target === Number(req.session.userId)) return apiError(res, 400, 'Choose a valid player.');
    const [existing] = await query('SELECT status FROM friends WHERE requester_id = ? AND addressee_id = ?', [target, req.session.userId]);
    if (existing?.status === 'pending') {
      await query('UPDATE friends SET status = \'accepted\' WHERE requester_id = ? AND addressee_id = ?', [target, req.session.userId]);
      return res.json({ status: 'accepted' });
    }
    await query('INSERT INTO friends (requester_id, addressee_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE status = IF(status = \'accepted\', status, \'pending\')', [req.session.userId, target]);
    res.status(201).json({ status: 'pending' });
  } catch (error) {
    if (error.code === 'ER_NO_REFERENCED_ROW_2') return apiError(res, 404, 'Player not found.');
    next(error);
  }
});

app.post('/api/friends/respond', requireUser, requireCsrf, async (req, res, next) => {
  try {
    const target = Number(req.body.userId);
    const accepted = req.body.accept === true;
    const result = accepted
      ? await query("UPDATE friends SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'", [target, req.session.userId])
      : await query("DELETE FROM friends WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'", [target, req.session.userId]);
    if (!result.affectedRows) return apiError(res, 404, 'Request not found.');
    res.json({ status: accepted ? 'accepted' : 'rejected' });
  } catch (error) { next(error); }
});

app.post('/api/reports', requireCsrf, async (req, res, next) => {
  try {
    const reason = typeof req.body.reason === 'string' ? req.body.reason : '';
    const details = typeof req.body.details === 'string' ? req.body.details.trim().slice(0, 500) : '';
    if (!['abuse', 'cheating', 'inappropriate_name', 'other'].includes(reason)) return apiError(res, 400, 'Choose a valid report reason.');
    const targetUserId = Number(req.body.userId) || null;
    const matchId = Number(req.body.matchId) || null;
    await query('INSERT INTO player_reports (reporter_id, reported_user_id, match_id, reason, details) VALUES (?, ?, ?, ?, ?)', [req.session.userId || null, targetUserId, matchId, reason, details]);
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/admin/overview', requireAdmin, async (req, res, next) => {
  try {
    const [[users]] = await pool.query('SELECT COUNT(*) AS totalUsers FROM users');
    const [[matches]] = await pool.query('SELECT COUNT(*) AS totalMatches, SUM(status = \'active\') AS activeMatches, SUM(status = \'completed\') AS completedMatches FROM matches');
    const reports = await query(`SELECT r.id, r.reason, r.details, r.status, r.created_at, u.username AS target
      FROM player_reports r LEFT JOIN users u ON u.id = r.reported_user_id ORDER BY r.created_at DESC LIMIT 30`);
    res.json({ ...users, ...matches, reports });
  } catch (error) { next(error); }
});

app.get('/api/admin/users', requireAdmin, async (req, res, next) => {
  try {
    const users = await query('SELECT id, username, email, role, suspended_at, created_at FROM users ORDER BY created_at DESC LIMIT 100');
    res.json({ users });
  } catch (error) { next(error); }
});

app.post('/api/admin/users/:id/suspend', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    if (Number(req.params.id) === Number(req.session.userId)) return apiError(res, 400, 'You cannot suspend your own account.');
    const suspended = req.body.suspended === true;
    const result = await query('UPDATE users SET suspended_at = ? WHERE id = ?', [suspended ? new Date() : null, req.params.id]);
    if (!result.affectedRows) return apiError(res, 404, 'Player not found.');
    await query('INSERT INTO admin_audit_logs (admin_user_id, action, target_type, target_id, details) VALUES (?, ?, \'user\', ?, ?)', [req.session.userId, suspended ? 'user.suspend' : 'user.unsuspend', req.params.id, JSON.stringify({ suspended })]);
    res.json({ suspended });
  } catch (error) { next(error); }
});

app.post('/api/admin/reports/:id/review', requireAdmin, requireCsrf, async (req, res, next) => {
  try {
    const status = ['reviewed', 'dismissed', 'actioned'].includes(req.body.status) ? req.body.status : null;
    if (!status) return apiError(res, 400, 'Invalid report status.');
    const result = await query('UPDATE player_reports SET status = ?, reviewed_by = ? WHERE id = ?', [status, req.session.userId, req.params.id]);
    if (!result.affectedRows) return apiError(res, 404, 'Report not found.');
    await query('INSERT INTO admin_audit_logs (admin_user_id, action, target_type, target_id, details) VALUES (?, ?, \'report\', ?, ?)', [req.session.userId, 'report.review', req.params.id, JSON.stringify({ status })]);
    res.json({ status });
  } catch (error) { next(error); }
});

app.get('/api/health', async (_req, res, next) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'connected' }); }
  catch (error) { next(error); }
});

function getSessionPlayer(sessionData) {
  if (sessionData.userId && sessionData.linkedGuestId) {
    const guestIdentity = `g:${sessionData.linkedGuestId}`;
    const activeCode = playerMatches.get(guestIdentity);
    if (activeCode && rooms.get(activeCode)?.status !== 'completed') {
      return { id: guestIdentity, userId: null, guestId: sessionData.linkedGuestId, name: sessionData.username };
    }
  }
  const id = identityOf(sessionData);
  return { id, userId: sessionData.userId || null, guestId: sessionData.userId ? null : sessionData.guestId, name: sessionData.username || sessionData.guestName || `Guest-${sessionData.guestId.slice(0, 4)}` };
}

async function createRoom(player, options = {}) {
  const previousCode = playerMatches.get(player.id);
  if (previousCode && rooms.get(previousCode)?.status !== 'completed') throw new Error('Finish or leave your current match first.');
  if (previousCode) playerMatches.delete(player.id);
  const size = Number(options.size || 3);
  const mode = options.mode === 'ranked' ? 'ranked' : 'casual';
  if (![3, 4, 5].includes(size)) throw new Error('Board size must be 3, 4, or 5.');
  if (mode === 'ranked' && !player.userId) throw new Error('Ranked games require an account.');
  const roomCode = code();
  const [insert] = await pool.execute('INSERT INTO matches (room_code, mode, board_size) VALUES (?, ?, ?)', [roomCode, mode, size]);
  const room = {
    code: roomCode, matchId: insert.insertId, mode, size, game: createGame(size), players: new Map(), status: 'waiting',
    queue: Promise.resolve(), timer: null, timerSeconds: Math.min(120, Math.max(0, Number(options.timerSeconds ?? process.env.TURN_SECONDS) || 0)),
    turnEndsAt: null, completedSaved: false,
  };
  rooms.set(roomCode, room);
  try { await addPlayer(room, player); }
  catch (error) {
    rooms.delete(roomCode);
    try { await pool.execute("UPDATE matches SET status = 'abandoned', result = 'abandoned', completed_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'waiting'", [room.matchId]); }
    catch (cleanupError) { console.error('Room cleanup failed:', cleanupError.message); }
    throw error;
  }
  return room;
}

async function addPlayer(room, player) {
  if (room.players.size >= 2) throw new Error('This room is full.');
  const previousCode = playerMatches.get(player.id);
  if (previousCode && rooms.get(previousCode)?.status !== 'completed') throw new Error('Finish or leave your current match first.');
  if (previousCode) playerMatches.delete(player.id);
  const symbol = room.players.size === 0 ? 'X' : 'O';
  const member = { ...player, symbol, online: true, socketIds: new Set() };
  const startsMatch = room.players.size === 1;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO match_players (match_id, user_id, guest_id, display_name, symbol) VALUES (?, ?, ?, ?, ?)', [room.matchId, player.userId, player.guestId, player.name, symbol]);
    if (startsMatch) {
      const [updated] = await connection.execute("UPDATE matches SET status = 'active', started_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'waiting'", [room.matchId]);
      if (!updated.affectedRows) throw new Error('This room is no longer available.');
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  room.players.set(player.id, member);
  playerMatches.set(player.id, room.code);
  if (startsMatch) {
    room.status = 'active';
    room.game = { ...room.game, status: 'playing' };
    resetTurnTimer(room);
  }
}

function stateFor(room) {
  return {
    code: room.code, mode: room.mode, size: room.size, board: room.game.board, turn: room.game.turn,
    status: room.status, gameStatus: room.game.status, winner: room.game.winner, moves: room.game.moves,
    players: [...room.players.values()].map(publicPlayer), timerSeconds: room.timerSeconds, turnEndsAt: room.turnEndsAt,
  };
}

function sendState(room) {
  io.to(room.code).emit('match:state', stateFor(room));
  for (const member of room.players.values()) {
    for (const socketId of member.socketIds) io.to(socketId).emit('match:identity', { symbol: member.symbol });
  }
}

function resetTurnTimer(room) {
  clearTimeout(room.timer);
  room.turnEndsAt = room.timerSeconds && room.status === 'active' ? Date.now() + room.timerSeconds * 1000 : null;
  if (room.turnEndsAt) {
    room.timer = setTimeout(() => serialize(room, async () => {
      if (room.status !== 'active') return;
      const loser = [...room.players.values()].find((player) => player.symbol === room.game.turn);
      const winner = [...room.players.values()].find((player) => player.symbol !== room.game.turn);
      await finishRoom(room, winner?.symbol || null, loser?.symbol || null, 'forfeit');
    }), room.timerSeconds * 1000);
  }
}

function serialize(room, operation) {
  room.queue = room.queue.then(operation).catch((error) => {
    console.error('Match operation failed:', error.message);
    io.to(room.code).emit('match:error', 'The match could not be saved. Please try again.');
  });
  return room.queue;
}

async function updatePlayerProgress(connection, player, won) {
  await connection.execute(`INSERT INTO mission_progress (user_id, mission_id, mission_date, progress)
    SELECT ?, id, UTC_DATE(), IF(mission_key = 'play_3', 1, IF(? = 1, 1, 0)) FROM daily_missions WHERE active = TRUE
    ON DUPLICATE KEY UPDATE progress = progress + VALUES(progress)`, [player.userId, won ? 1 : 0]);
  const [eligible] = await connection.execute(`SELECT a.id, a.achievement_key, a.name, a.description, a.xp_reward
    FROM achievements a JOIN player_stats s ON s.user_id = ?
    LEFT JOIN player_achievements pa ON pa.achievement_id = a.id AND pa.user_id = ?
    WHERE a.active = TRUE AND pa.user_id IS NULL AND (
      (a.achievement_key = 'first_win' AND s.wins >= 1) OR
      (a.achievement_key = 'streak_3' AND s.win_streak >= 3) OR
      (a.achievement_key = 'matches_25' AND s.wins + s.losses + s.draws >= 25)
    )`, [player.userId, player.userId]);
  const unlocked = [];
  for (const achievement of eligible) {
    const [insert] = await connection.execute('INSERT IGNORE INTO player_achievements (user_id, achievement_id) VALUES (?, ?)', [player.userId, achievement.id]);
    if (!insert.affectedRows) continue;
    await connection.execute('UPDATE player_stats SET level = FLOOR((xp + ?) / 250) + 1, xp = xp + ? WHERE user_id = ?', [achievement.xp_reward, achievement.xp_reward, player.userId]);
    unlocked.push(achievement);
  }
  return unlocked;
}

async function finishRoom(room, winnerSymbol, loserSymbol, resultOverride = null) {
  if (room.completedSaved || room.status !== 'active') return;
  const result = resultOverride || (winnerSymbol ? `${winnerSymbol.toLowerCase()}_win` : 'draw');
  const unlockedBySymbol = new Map();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [updated] = await connection.execute("UPDATE matches SET status = 'completed', result = ?, winner_user_id = ?, completed_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'", [result, room.players.get([...room.players.keys()].find((key) => room.players.get(key).symbol === winnerSymbol))?.userId || null, room.matchId]);
    if (!updated.affectedRows) { await connection.rollback(); return; }
    for (const player of room.players.values()) {
      const playerResult = result === 'draw' ? 'draw' : player.symbol === winnerSymbol ? 'win' : result === 'abandoned' ? 'abandoned' : 'loss';
      await connection.execute('UPDATE match_players SET result = ?, rating_delta = ? WHERE match_id = ? AND symbol = ?', [playerResult, room.mode === 'ranked' && player.userId ? (playerResult === 'win' ? 16 : playerResult === 'loss' ? -16 : 0) : 0, room.matchId, player.symbol]);
      if (player.userId) {
        const won = playerResult === 'win';
        const lost = playerResult === 'loss';
        const xp = won ? 30 : playerResult === 'draw' ? 10 : 5;
        const rating = room.mode === 'ranked' ? (won ? 16 : lost ? -16 : 0) : 0;
        await connection.execute(`UPDATE player_stats SET
          wins = wins + ?, losses = losses + ?, draws = draws + ?,
          win_streak = IF(?, win_streak + 1, 0), best_streak = GREATEST(best_streak, IF(?, win_streak + 1, 0)),
          rating = GREATEST(0, rating + ?), level = FLOOR((xp + ?) / 250) + 1, xp = xp + ? WHERE user_id = ?`,
        [won ? 1 : 0, lost ? 1 : 0, playerResult === 'draw' ? 1 : 0, won, won, rating, xp, xp, player.userId]);
        unlockedBySymbol.set(player.symbol, await updatePlayerProgress(connection, player, won));
      }
    }
    await connection.commit();
    room.completedSaved = true;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  clearTimeout(room.timer);
  room.status = 'completed';
  room.game = { ...room.game, status: result === 'draw' ? 'draw' : 'finished', winner: winnerSymbol };
  room.turnEndsAt = null;
  sendState(room);
  io.to(room.code).emit('match:result', { result, winner: winnerSymbol });
  for (const [symbol, achievements] of unlockedBySymbol) {
    const member = [...room.players.values()].find((player) => player.symbol === symbol);
    for (const achievement of achievements) {
      for (const socketId of member?.socketIds || []) io.to(socketId).emit('player:achievement', achievement);
    }
  }
}

io.on('connection', (socket) => {
  const player = getSessionPlayer(socket.request.session);
  const existingCode = playerMatches.get(player.id);
  if (existingCode && rooms.has(existingCode)) {
    const room = rooms.get(existingCode);
    const member = room.players.get(player.id);
    member.online = true;
    member.socketIds.add(socket.id);
    clearTimeout(member.disconnectTimer);
    socket.join(existingCode);
    socket.emit('match:state', stateFor(room));
    io.to(existingCode).emit('match:presence', { name: member.name, online: true });
  }

  socket.on('room:create', async (options = {}, ack = () => {}) => {
    if (!allowSocketEvent(socket, 'room:create', 5, 60_000)) return ack({ ok: false, error: 'Too many room requests. Try again shortly.' });
    try {
      const room = await createRoom(player, options);
      const member = room.players.get(player.id);
      member.socketIds.add(socket.id);
      socket.join(room.code);
      sendState(room);
      ack({ ok: true, code: room.code, state: stateFor(room) });
    } catch (error) { ack({ ok: false, error: error.message }); }
  });

  socket.on('room:join', async (rawCode, ack = () => {}) => {
    if (!allowSocketEvent(socket, 'room:join', 8, 60_000)) return ack({ ok: false, error: 'Too many join attempts. Try again shortly.' });
    try {
      const roomCode = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
      const room = rooms.get(roomCode);
      if (!room || room.status !== 'waiting') throw new Error('Room not found or already started.');
      await addPlayer(room, player);
      room.players.get(player.id).socketIds.add(socket.id);
      socket.join(room.code);
      sendState(room);
      ack({ ok: true, state: stateFor(room) });
    } catch (error) { ack({ ok: false, error: error.message }); }
  });

  socket.on('room:spectate', (rawCode, ack = () => {}) => {
    if (playerMatches.has(player.id)) return ack({ ok: false, error: 'Leave your current match before spectating.' });
    const roomCode = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
    const room = rooms.get(roomCode);
    if (!room || room.status !== 'active') return ack({ ok: false, error: 'Active match not found.' });
    if (socket.data.spectating) socket.leave(socket.data.spectating);
    socket.join(room.code);
    socket.data.spectating = room.code;
    socket.emit('match:state', stateFor(room));
    ack({ ok: true, state: stateFor(room) });
  });

  socket.on('room:unspectate', (ack = () => {}) => {
    if (socket.data.spectating) socket.leave(socket.data.spectating);
    socket.data.spectating = null;
    ack({ ok: true });
  });

  socket.on('matchmaking:join', async (options = {}, ack = () => {}) => {
    if (!allowSocketEvent(socket, 'matchmaking:join', 5, 60_000)) return ack({ ok: false, error: 'Too many matchmaking requests. Try again shortly.' });
    const mode = options.mode === 'ranked' ? 'ranked' : 'casual';
    const size = [3, 4, 5].includes(Number(options.size)) ? Number(options.size) : 3;
    if (mode === 'ranked' && !player.userId) return ack({ ok: false, error: 'Ranked games require an account.' });
    const queueKey = `${mode}:${size}`;
    const queue = (matchmaking.get(queueKey) || []).filter((candidate) =>
      playerMatches.get(candidate.player.id) === candidate.roomCode && rooms.get(candidate.roomCode)?.status === 'waiting');
    matchmaking.set(queueKey, queue);
    const candidateIndex = queue.findIndex((candidate) => candidate.player.id !== player.id);
    if (candidateIndex >= 0) {
      const candidate = queue.splice(candidateIndex, 1)[0];
      matchmaking.set(queueKey, queue);
      try {
        const room = rooms.get(candidate.roomCode);
        if (!room || room.status !== 'waiting') throw new Error('Opponent is no longer available.');
        await addPlayer(room, player);
        room.players.get(player.id).socketIds.add(socket.id);
        socket.join(room.code);
        const otherSocket = io.sockets.sockets.get(candidate.socketId);
        if (otherSocket) { otherSocket.join(room.code); otherSocket.emit('match:found', { code: room.code, state: stateFor(room) }); }
        sendState(room);
        ack({ ok: true, code: room.code, state: stateFor(room) });
      } catch (error) { ack({ ok: false, error: error.message }); }
    } else {
      try {
        const room = await createRoom(player, { mode, size, timerSeconds: options.timerSeconds });
        room.players.get(player.id).socketIds.add(socket.id);
        socket.join(room.code);
        queue.push({ roomCode: room.code, player, socketId: socket.id });
        matchmaking.set(queueKey, queue);
        ack({ ok: true, waiting: true, code: room.code });
      } catch (error) { ack({ ok: false, error: error.message }); }
    }
  });

  socket.on('match:move', ({ index } = {}, ack = () => {}) => {
    if (!allowSocketEvent(socket, 'match:move', 12, 10_000)) return ack({ ok: false, error: 'Moves are arriving too quickly.' });
    const roomCode = playerMatches.get(player.id);
    const room = rooms.get(roomCode);
    if (!room || !room.players.has(player.id)) return ack({ ok: false, error: 'You are not in an active match.' });
    serialize(room, async () => {
      const previousGame = room.game;
      let savedMoveNumber = null;
      try {
        const member = room.players.get(player.id);
        const next = playMove(room.game, member.symbol, index);
        const move = next.moves.at(-1);
        await pool.execute('INSERT INTO moves (match_id, move_number, player_symbol, cell_index, created_at) VALUES (?, ?, ?, ?, ?)', [room.matchId, move.number, member.symbol, index, new Date(move.at)]);
        savedMoveNumber = move.number;
        room.game = next;
        if (next.status === 'finished') await finishRoom(room, next.winner, null);
        else if (next.status === 'draw') await finishRoom(room, null, null);
        else resetTurnTimer(room);
        sendState(room);
        ack({ ok: true });
      } catch (error) {
        room.game = previousGame;
        if (savedMoveNumber !== null) {
          try { await pool.execute('DELETE FROM moves WHERE match_id = ? AND move_number = ?', [room.matchId, savedMoveNumber]); }
          catch (rollbackError) { console.error('Move rollback failed:', rollbackError.message); }
        }
        ack({ ok: false, error: error.message });
      }
    });
  });

  socket.on('match:rematch', (_payload, ack = () => {}) => {
    const currentCode = playerMatches.get(player.id);
    const currentRoom = rooms.get(currentCode);
    if (!currentRoom || currentRoom.status !== 'completed' || currentRoom.players.size !== 2) return ack({ ok: false, error: 'Rematch is unavailable.' });
    serialize(currentRoom, async () => {
      const first = [...currentRoom.players.values()].find((candidate) => candidate.symbol === 'O');
      const second = [...currentRoom.players.values()].find((candidate) => candidate.symbol === 'X');
      const nextRoom = await createRoom(first, { mode: currentRoom.mode, size: currentRoom.size, timerSeconds: currentRoom.timerSeconds });
      await addPlayer(nextRoom, second);
      const nextPlayer = nextRoom.players.get(player.id);
        for (const previousPlayer of currentRoom.players.values()) {
          const freshPlayer = nextRoom.players.get(previousPlayer.id);
          for (const socketId of previousPlayer.socketIds) {
            freshPlayer.socketIds.add(socketId);
            io.sockets.sockets.get(socketId)?.join(nextRoom.code);
          }
        }
        sendState(nextRoom);
      io.to(currentRoom.code).emit('match:rematch-created', { code: nextRoom.code });
      ack({ ok: true, code: nextRoom.code, state: stateFor(nextRoom) });
    }).catch((error) => ack({ ok: false, error: error.message }));
  });

  socket.on('chat:send', async (payload = {}, ack = () => {}) => {
    const room = rooms.get(playerMatches.get(player.id));
    const now = Date.now();
    if (!room || room.status !== 'active' || !room.players.has(player.id)) return ack({ ok: false, error: 'Chat is only available during a match.' });
    if (socket.data.lastChatAt && now - socket.data.lastChatAt < 700) return ack({ ok: false, error: 'You are sending messages too quickly.' });
    const body = typeof payload.message === 'string' ? payload.message.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 280) : '';
    if (!body) return ack({ ok: false, error: 'Message is empty.' });
    socket.data.lastChatAt = now;
    try {
      const [insert] = await pool.execute('INSERT INTO chat_messages (match_id, user_id, display_name, body) VALUES (?, ?, ?, ?)', [room.matchId, player.userId, player.name, body]);
      io.to(room.code).emit('chat:message', { id: insert.insertId, name: player.name, message: body, at: new Date().toISOString() });
      ack({ ok: true });
    } catch (error) { ack({ ok: false, error: 'Message could not be saved.' }); }
  });

  socket.on('match:reaction', (reaction, ack = () => {}) => {
    if (!allowSocketEvent(socket, 'match:reaction', 6, 10_000)) return ack({ ok: false, error: 'Slow down on reactions.' });
    const allowed = ['😂', '👏', '😎', '😮'];
    const room = rooms.get(playerMatches.get(player.id));
    if (!room || room.status !== 'active' || !room.players.has(player.id) || !allowed.includes(reaction)) return ack({ ok: false, error: 'Reaction unavailable.' });
    io.to(room.code).emit('match:reaction', { name: player.name, reaction });
    ack({ ok: true });
  });

  socket.on('match:leave', (ack = () => {}) => {
    const room = rooms.get(playerMatches.get(player.id));
    if (!room || !room.players.has(player.id)) return ack({ ok: true });
    serialize(room, async () => {
      const opponent = [...room.players.values()].find((member) => member.id !== player.id);
      if (room.status === 'active' && opponent) await finishRoom(room, opponent.symbol, room.players.get(player.id).symbol, 'forfeit');
      else if (room.status === 'waiting') {
        await pool.execute("UPDATE matches SET status = 'abandoned', result = 'abandoned', completed_at = UTC_TIMESTAMP() WHERE id = ?", [room.matchId]);
        room.status = 'abandoned';
        playerMatches.delete(player.id);
        for (const [queueKey, queue] of matchmaking) matchmaking.set(queueKey, queue.filter((candidate) => candidate.roomCode !== room.code));
      }
      ack({ ok: true });
    });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(playerMatches.get(player.id));
    const member = room?.players.get(player.id);
    if (!member) return;
    member.socketIds.delete(socket.id);
    if (member.socketIds.size) return;
    member.online = false;
    io.to(room.code).emit('match:presence', { name: member.name, online: false });
    if (room.status === 'waiting') {
      serialize(room, async () => {
        if (member.online || room.status !== 'waiting') return;
        await pool.execute("UPDATE matches SET status = 'abandoned', result = 'abandoned', completed_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'waiting'", [room.matchId]);
        room.status = 'abandoned';
        playerMatches.delete(player.id);
        for (const [queueKey, queue] of matchmaking) matchmaking.set(queueKey, queue.filter((candidate) => candidate.roomCode !== room.code));
      });
      return;
    }
    if (room.status !== 'active') return;
    member.disconnectTimer = setTimeout(() => serialize(room, async () => {
      if (member.online || room.status !== 'active') return;
      const opponent = [...room.players.values()].find((candidate) => candidate.id !== player.id);
      await finishRoom(room, opponent?.symbol || null, member.symbol, 'forfeit');
      io.to(room.code).emit('match:disconnected-result', { name: member.name });
    }), Math.max(10, Number(process.env.RECONNECT_GRACE_SECONDS) || 45) * 1000);
  });
});

function allowSocketEvent(socket, event, limit, windowMs) {
  const now = Date.now();
  const recent = (socket.data.eventTimes?.[event] || []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) return false;
  socket.data.eventTimes ||= {};
  socket.data.eventTimes[event] = [...recent, now];
  return true;
}

app.use('/api', (_req, res) => apiError(res, 404, 'API endpoint not found.'));
app.use((error, _req, res, _next) => {
  console.error('Request failed:', error.code || error.name, error.message);
  if (res.headersSent) return;
  res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ error: error.code === 'ER_DUP_ENTRY' ? 'That value is already in use.' : 'The server could not complete that request.' });
});

const port = Number(process.env.PORT || 3000);
try {
  await pool.query('SELECT 1');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(`UPDATE match_players mp JOIN matches m ON m.id = mp.match_id
      SET mp.result = 'abandoned' WHERE m.status IN ('waiting','active') AND mp.result IS NULL`);
    await connection.execute(`UPDATE matches SET status = 'abandoned', result = 'abandoned', completed_at = UTC_TIMESTAMP()
      WHERE status IN ('waiting','active')`);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
  httpServer.listen(port, () => console.log(`Tic-Tac-Toe listening on ${origin}`));
} catch (error) {
  console.error('Database connection failed; server was not started:', error.message);
  process.exitCode = 1;
}

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  for (const room of rooms.values()) clearTimeout(room.timer);
  io.close();
  sessionStore.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));