import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import request from 'supertest';
import { io } from 'socket.io-client';

const enabled = process.env.RUN_DB_TESTS === '1';
let serverProcess;
let baseUrl;

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error('Test server exited during startup.');
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* Server is still binding or waiting on its database. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the integration-test server.');
}

if (enabled) {
  before(async () => {
    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, ['src/server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), APP_ORIGIN: baseUrl, SESSION_SECRET: randomBytes(32).toString('hex'), COOKIE_SECURE: 'false', NODE_ENV: 'test' },
      stdio: 'ignore',
    });
    await waitForServer();
  });

  after(async () => {
    if (!serverProcess || serverProcess.exitCode !== null) return;
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit');
  });
}

test('account auth and two-client ranked match persist an authoritative replay', { skip: !enabled && 'Set RUN_DB_TESTS=1 and provide disposable MySQL credentials.' }, async () => {
  const players = ['X', 'O'].map((symbol) => ({
    username: `test_${symbol.toLowerCase()}_${randomUUID().replaceAll('-', '').slice(0, 10)}`,
    email: `${symbol.toLowerCase()}_${randomUUID().slice(0, 12)}@example.test`,
    password: 'Correct-horse-battery-9',
  }));
  const accounts = [];
  const sockets = [];

  try {
    for (const details of players) {
      const agent = request.agent(baseUrl);
      const bootstrap = await agent.get('/api/bootstrap').expect(200);
      const registration = await agent.post('/api/auth/register').set('x-csrf-token', bootstrap.body.csrfToken).send(details).expect(201);
      assert.equal(registration.body.player.name, details.username);
      const invalidLogin = await agent.post('/api/auth/login')
        .set('x-csrf-token', registration.body.csrfToken)
        .send({ login: details.username, password: 'wrong-password-value' }).expect(401);
      assert.match(invalidLogin.body.error, /incorrect/);
      const login = await agent.post('/api/auth/login')
        .set('x-csrf-token', registration.body.csrfToken)
        .send({ login: details.username, password: details.password }).expect(200);
      assert.equal(login.body.player.name, details.username);
      const cookie = login.headers['set-cookie']?.[0]?.split(';', 1)[0];
      assert.ok(cookie, 'registration must establish a session cookie');
      accounts.push({ agent, csrf: login.body.csrfToken, cookie, id: registration.body.player.id });
    }

    await accounts[0].agent.get('/api/profile').expect(200);
    await request(baseUrl).get('/api/profile').expect(401);
    await accounts[0].agent.post('/api/friends/request').send({ userId: accounts[1].id }).expect(403);

    for (const account of accounts) {
      const socket = io(baseUrl, { extraHeaders: { Cookie: account.cookie }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
    }

    const lastState = [null, null];
    sockets.forEach((socket, index) => socket.on('match:state', (state) => { lastState[index] = state; }));
    const created = await new Promise((resolve) => sockets[0].emit('room:create', { mode: 'ranked', size: 3 }, resolve));
    assert.equal(created.ok, true, created.error || 'Room creation failed.');
    const joined = await new Promise((resolve) => sockets[1].emit('room:join', created.code, resolve));
    assert.equal(joined.ok, true);
    assert.deepEqual(joined.state.players.map((player) => player.symbol), ['X', 'O']);

    const wrongTurn = await new Promise((resolve) => sockets[1].emit('match:move', { index: 1 }, resolve));
    assert.equal(wrongTurn.ok, false);
    for (const [socketIndex, cell] of [[0, 0], [1, 1], [0, 3], [1, 2], [0, 6]]) {
      const result = await new Promise((resolve) => sockets[socketIndex].emit('match:move', { index: cell }, resolve));
      assert.equal(result.ok, true, result.error || `Move ${cell} was rejected.`);
    }
    assert.equal(lastState[0].status, 'completed');
    assert.equal(lastState[0].winner, 'X');
    assert.equal(lastState[0].board[6], 'X');

    const history = await accounts[0].agent.get('/api/history').expect(200);
    assert.equal(history.body.matches[0].player_result, 'win');
    const replay = await accounts[0].agent.get(`/api/matches/${history.body.matches[0].id}/replay`).expect(200);
    assert.equal(replay.body.moves.length, 5);
    assert.deepEqual(replay.body.moves.map((move) => move.cell_index), [0, 1, 3, 2, 6]);
    const { body: profile } = await accounts[0].agent.get('/api/profile').expect(200);
    assert.equal(profile.stats.wins, 1);
    assert.equal(profile.stats.rating, 1016);
    await accounts[0].agent.post('/api/auth/logout').set('x-csrf-token', accounts[0].csrf).send({}).expect(200);
    await accounts[0].agent.get('/api/profile').expect(401);
  } finally {
    for (const socket of sockets) socket.disconnect();
  }
});

test('quick matchmaking pairs guests and restores the same player on reconnect', { skip: !enabled && 'Set RUN_DB_TESTS=1 and provide disposable MySQL credentials.' }, async () => {
  const sockets = [];
  try {
    const guests = [];
    for (let index = 0; index < 2; index += 1) {
      const agent = request.agent(baseUrl);
      const response = await agent.get('/api/bootstrap').expect(200);
      guests.push(response.headers['set-cookie']?.[0]?.split(';', 1)[0]);
    }
    for (const cookie of guests) {
      const socket = io(baseUrl, { extraHeaders: { Cookie: cookie }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    }

    const found = new Promise((resolve) => sockets[0].once('match:found', resolve));
    const queued = await new Promise((resolve) => sockets[0].emit('matchmaking:join', { mode: 'casual', size: 3 }, resolve));
    assert.equal(queued.ok, true);
    assert.equal(queued.waiting, true);
    const matched = await new Promise((resolve) => sockets[1].emit('matchmaking:join', { mode: 'casual', size: 3 }, resolve));
    assert.equal(matched.ok, true);
    assert.ok(matched.state, `Expected a paired room, got ${JSON.stringify(matched)}`);
    assert.equal(matched.state.status, 'active');
    const foundMatch = await found;
    assert.equal(foundMatch.code, queued.code);

    const disconnected = new Promise((resolve) => sockets[1].once('match:presence', resolve));
    sockets[0].disconnect();
    const offline = await disconnected;
    assert.equal(offline.online, false);

    const replacement = io(baseUrl, { extraHeaders: { Cookie: guests[0] }, transports: ['websocket'], reconnection: false });
    sockets.push(replacement);
    const restored = new Promise((resolve) => replacement.once('match:state', resolve));
    await new Promise((resolve, reject) => { replacement.once('connect', resolve); replacement.once('connect_error', reject); });
    const restoredState = await restored;
    assert.equal(restoredState.code, queued.code);
    const online = await new Promise((resolve) => sockets[1].once('match:presence', resolve));
    assert.equal(online.online, true);
  } finally {
    for (const socket of sockets) socket.disconnect();
  }
});