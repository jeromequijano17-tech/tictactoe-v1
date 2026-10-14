const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const views = ['home', 'leaderboard', 'friends', 'history', 'admin'];
let csrfToken = '';
let player = null;
let socket = null;
let matchState = null;
let matchCode = '';
let mySymbol = null;
let localAI = false;
let isSpectating = false;
let aiDifficulty = 'medium';
let mutedChat = false;
let soundEnabled = localStorage.getItem('gridline-sound') !== 'off';
let historyPage = 0;
let leaderboardPeriod = 'all';
let replayTimer = null;
let replayData = null;
let resetToken = '';
let toastTimer = null;
let clockTimer = null;

async function api(url, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, { credentials: 'same-origin', ...options, method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'That request could not be completed.');
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
}

function setConnection(online) {
  $('#connection-dot').className = online ? 'online' : 'offline';
  $('#connection-label').textContent = online ? 'Connected' : 'Reconnecting';
}

function updatePlayer(next) {
  player = next;
  $('#account-name').textContent = next.name;
  $('#avatar-mini').textContent = next.name.slice(0, 1).toUpperCase();
  $('#logout-button').classList.toggle('hidden', next.guest);
  $('.admin-nav').classList.toggle('hidden', next.role !== 'admin');
  if (!next.guest && $('input[name="game-mode"][value="ranked"]')) {
    $('input[name="game-mode"][value="ranked"]').disabled = false;
  }
  loadMissions();
}

function showView(name) {
  if (!views.includes(name)) return;
  for (const view of views) $(`#${view}-view`).classList.toggle('hidden', name !== view);
  $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  if (name === 'leaderboard') loadLeaderboard(leaderboardPeriod);
  if (name === 'friends') loadFriends();
  if (name === 'history') loadHistory(true);
  if (name === 'admin') loadAdmin();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function currentSettings() {
  return {
    size: Number($('input[name="board-size"]:checked').value),
    mode: $('input[name="game-mode"]:checked').value,
    timerSeconds: Number($('#timer-select').value),
  };
}

function connectSocket() {
  socket = window.io({ withCredentials: true, reconnection: true, reconnectionAttempts: Infinity });
  socket.on('connect', () => setConnection(true));
  socket.on('disconnect', () => setConnection(false));
  socket.on('connect_error', () => setConnection(false));
  socket.on('match:identity', ({ symbol }) => { mySymbol = symbol; renderMatch(); });
  socket.on('match:state', (state) => {
    if (localAI) return;
    matchState = state;
    matchCode = state.code;
    $('#queue-state').classList.add('hidden');
    $('#game-panel').classList.remove('hidden');
    renderMatch();
  });
  socket.on('match:found', ({ code, state }) => {
    matchCode = code;
    matchState = state;
    $('#queue-state').classList.add('hidden');
    $('#game-panel').classList.remove('hidden');
    addChatLine('system', 'Your opponent is here. Make the first move.');
    renderMatch();
  });
  socket.on('match:presence', ({ name, online }) => {
    addChatLine('system', `${name} ${online ? 'is back' : 'lost connection'}.`);
    if (matchState) matchState.players = matchState.players.map((item) => item.name === name ? { ...item, online } : item);
    renderMatch();
  });
  socket.on('match:result', ({ result }) => {
    playTone(result === 'draw' ? 440 : result === (mySymbol === 'X' ? 'x_win' : 'o_win') ? 720 : 260);
    if (!player?.guest) loadMissions();
  });
  socket.on('player:achievement', (achievement) => toast(`Achievement unlocked: ${achievement.name} · +${achievement.xp_reward} XP`));
  socket.on('match:disconnected-result', ({ name }) => toast(`${name} ran out of reconnection time.`));
  socket.on('match:error', (message) => toast(message));
  socket.on('match:rematch-created', ({ code }) => {
    matchCode = code;
    toast('Rematch ready. You have swapped sides.');
  });
  socket.on('chat:message', (message) => {
    if (!mutedChat) addChatLine(message.name, message.message, message.at);
  });
  socket.on('match:reaction', ({ name, reaction }) => {
    $('#reaction-toast').textContent = `${name} ${reaction}`;
    setTimeout(() => { $('#reaction-toast').textContent = ''; }, 2200);
  });
}

function emitAck(event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function startRoom(event, payload) {
  if (!socket?.connected) return toast('Reconnecting to the game server…');
  const response = await emitAck(event, payload);
  if (!response?.ok) return toast(response?.error || 'Could not start that match.');
  isSpectating = false;
  if (response.waiting) {
    matchCode = response.code;
    $('#queue-title').textContent = event === 'matchmaking:join' ? 'Finding an opponent' : 'Room is ready';
    $('#queue-state').classList.remove('hidden');
    if (event !== 'matchmaking:join') toast(`Room ${response.code} is ready to share.`);
    return;
  }
  localAI = false;
  matchState = response.state;
  matchCode = response.code || response.state.code;
  if (event === 'room:create') {
    const link = `${location.origin}/?room=${matchCode}`;
    try { await navigator.clipboard.writeText(link); toast(`Invite link copied. Room ${matchCode} is ready.`); }
    catch { toast(`Room ${matchCode} is ready. Use Copy invite to share it.`); }
  }
  $('#queue-state').classList.add('hidden');
  $('#game-panel').classList.remove('hidden');
  renderMatch();
}

function roomStateFromInvite() {
  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  resetToken = params.get('reset') || '';
  if (resetToken) $('#reset-dialog').showModal();
  if (code) {
    history.replaceState(null, '', location.pathname);
    $('#room-code').value = code.toUpperCase();
    setTimeout(() => $('#join-room-button').click(), 300);
  }
}

async function loadMissions() {
  const container = $('#daily-missions');
  if (!container || !player) return;
  if (player.guest) {
    container.replaceChildren(emptyRow('Sign in to track daily goals and claim XP.'));
    return;
  }
  try {
    const { missions } = await api('/api/missions');
    const rows = missions.map((mission) => {
      const item = document.createElement('div'); item.className = 'mission-item';
      const title = document.createElement('b'); title.textContent = mission.title;
      const status = document.createElement('span'); status.className = 'mission-count'; status.textContent = `${Math.min(mission.progress, mission.target)} / ${mission.target}`;
      const progress = document.createElement('progress'); progress.max = mission.target; progress.value = Math.min(mission.progress, mission.target); progress.setAttribute('aria-label', `${mission.title}: ${progress.value} of ${mission.target}`);
      item.append(title, status, progress);
      if (mission.claimed_at) { const claimed = document.createElement('small'); claimed.textContent = 'CLAIMED'; item.append(claimed); }
      else if (mission.progress >= mission.target) { const claim = document.createElement('button'); claim.type = 'button'; claim.className = 'claim-button'; claim.textContent = `Claim +${mission.xp_reward} XP`; claim.addEventListener('click', () => claimMission(mission.id)); item.append(claim); }
      return item;
    });
    container.replaceChildren(...(rows.length ? rows : [emptyRow('No missions available today.') ]));
  } catch (error) { container.replaceChildren(emptyRow(error.message)); }
}

async function claimMission(id) {
  try { const result = await api(`/api/missions/${id}/claim`, { method: 'POST', body: {} }); toast(`Mission claimed · +${result.xp} XP`); loadMissions(); }
  catch (error) { toast(error.message); }
}

function renderMatch() {
  if (!matchState) return;
  const state = matchState;
  const aiMode = localAI;
  $('#game-panel').classList.remove('hidden');
  $('#match-code').textContent = aiMode ? 'PRACTICE / LOCAL' : `ROOM / ${matchCode}`;
  $('#copy-invite-button').classList.toggle('hidden', aiMode || state.status !== 'waiting');
  $('#match-mode-label').textContent = aiMode ? `PRACTICE · ${aiDifficulty.toUpperCase()} AI` : `${state.mode.toUpperCase()} MATCH · ${state.size} × ${state.size}`;
  const inProgress = state.status === 'active' && state.gameStatus === 'playing';
  const waiting = state.status === 'waiting';
  const players = state.players || [];
  const current = players.find((item) => item.symbol === state.turn);
  $('#match-status').textContent = waiting ? 'Waiting for a player…' : inProgress ? (state.turn === mySymbol || aiMode && state.turn === 'X' ? 'Your turn.' : `${current?.name || 'Opponent'} is up.`) : state.gameStatus === 'draw' ? 'A well-played draw.' : `${players.find((item) => item.symbol === state.winner)?.name || 'Player'} takes it.`;
  $('#turn-clock').classList.toggle('hidden', !state.turnEndsAt || !inProgress);
  $('#players-strip').replaceChildren(...['X', 'O'].map((symbol) => {
    const item = players.find((candidate) => candidate.symbol === symbol) || { name: waiting && symbol === 'O' ? 'Waiting for player' : 'Open seat', online: false };
    const chip = document.createElement('div');
    chip.className = `player-chip${inProgress && state.turn === symbol ? ' current' : ''}${item.online === false && item.name !== 'Open seat' && item.name !== 'Waiting for player' ? ' disconnected' : ''}`;
    const mark = document.createElement('span'); mark.className = 'player-symbol'; mark.textContent = symbol;
    const details = document.createElement('div');
    const name = document.createElement('b'); name.textContent = item.name;
    const label = document.createElement('small'); label.textContent = item.online === false && item.name !== 'Open seat' ? 'OFFLINE' : symbol === mySymbol ? 'YOU' : item.registered ? 'PLAYER' : item.name === 'Open seat' ? 'AVAILABLE' : 'GUEST';
    details.append(name, label); chip.append(mark, details); return chip;
  }));
  const board = $('#game-board');
  board.className = `board size-${state.size}`;
  const win = state.winner ? getWinningCells(state.board, state.size, state.winner) : [];
  board.replaceChildren(...state.board.map((mark, index) => {
    const cell = document.createElement('button');
    cell.type = 'button'; cell.className = `cell${mark ? ` mark-${mark.toLowerCase()}` : ''}${win.includes(index) ? ' winning' : ''}`;
    cell.setAttribute('role', 'gridcell'); cell.setAttribute('aria-label', `Row ${Math.floor(index / state.size) + 1}, column ${index % state.size + 1}${mark ? `, ${mark}` : ', empty'}`);
    cell.textContent = mark || '';
    cell.disabled = Boolean(mark) || !inProgress || (!aiMode && state.turn !== mySymbol) || (aiMode && state.turn !== 'X');
    cell.addEventListener('click', () => makeMove(index));
    return cell;
  }));
  const ended = state.status === 'completed' || state.gameStatus !== 'playing' && !waiting;
  $('#win-banner').classList.toggle('hidden', !ended);
  $('#win-banner').replaceChildren();
  if (ended) { const label = document.createElement('span'); label.textContent = state.gameStatus === 'draw' ? 'NOBODY BLINKED' : state.winner === mySymbol || aiMode && state.winner === 'X' ? 'THAT’S THE GAME' : 'NICE TRY'; $('#win-banner').append(label); }
  $('#rematch-button').classList.toggle('hidden', !ended || aiMode || isSpectating);
  $('#new-game-button').classList.toggle('hidden', !ended);
  $('#report-button').classList.toggle('hidden', aiMode || waiting || ended);
  $('#game-hint').textContent = waiting ? 'Share the room link with a friend' : inProgress ? (state.turn === mySymbol || aiMode && state.turn === 'X' ? 'Your square, your call' : 'A good time to plan your next move') : 'Fancy another round?';
  if (!state.turnEndsAt) clearInterval(clockTimer);
  else {
    clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((state.turnEndsAt - Date.now()) / 1000));
      $('#clock-value').textContent = String(remaining).padStart(2, '0');
      $('#turn-clock').classList.toggle('urgent', remaining <= 5);
    }, 200);
  }
}

function getWinningCells(board, size, symbol) {
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] !== symbol) continue;
    const row = Math.floor(index / size); const col = index % size;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const cells = [index];
      for (let offset = 1; offset < 3; offset += 1) {
        const r = row + dr * offset; const c = col + dc * offset;
        if (r < 0 || r >= size || c < 0 || c >= size || board[r * size + c] !== symbol) break;
        cells.push(r * size + c);
      }
      if (cells.length === 3) return cells;
    }
  }
  return [];
}

function makeMove(index) {
  if (!matchState) return;
  if (localAI) {
    try {
      matchState = applyLocalMove(matchState, 'X', index);
      renderMatch(); playTone(540);
      if (matchState.gameStatus === 'playing') setTimeout(makeAIMove, 370);
    } catch (error) { toast(error.message); }
    return;
  }
  socket.emit('match:move', { index }, (result) => {
    if (!result?.ok) toast(result?.error || 'Move was not accepted.');
    else playTone(540);
  });
}

function applyLocalMove(state, symbol, index) {
  if (state.gameStatus !== 'playing' || state.turn !== symbol || state.board[index] !== null) throw new Error('That square is not available.');
  const board = [...state.board]; board[index] = symbol;
  const moves = [...state.moves, { player: symbol, index, number: state.moves.length + 1 }];
  const won = getWinningCells(board, state.size, symbol).length > 0;
  return { ...state, board, moves, turn: symbol === 'X' ? 'O' : 'X', winner: won ? symbol : null, gameStatus: won ? 'finished' : moves.length === board.length ? 'draw' : 'playing', status: won || moves.length === board.length ? 'completed' : 'active' };
}

function makeAIMove() {
  if (!localAI || !matchState || matchState.turn !== 'O' || matchState.gameStatus !== 'playing') return;
  const board = matchState.board;
  const available = board.map((value, index) => value === null ? index : -1).filter((index) => index >= 0);
  let choice;
  if (aiDifficulty === 'easy') choice = available[Math.floor(Math.random() * available.length)];
  else if (aiDifficulty === 'perfect' && matchState.size === 3) choice = perfectMove(board);
  else choice = tacticalMove(board, available, matchState.size);
  matchState = applyLocalMove(matchState, 'O', choice);
  renderMatch(); playTone(340);
}

function tacticalMove(board, available, size) {
  for (const symbol of ['O', 'X']) {
    for (const index of available) {
      const next = [...board]; next[index] = symbol;
      if (getWinningCells(next, size, symbol).length) return index;
    }
  }
  const center = Math.floor(size / 2) * size + Math.floor(size / 2);
  if (available.includes(center)) return center;
  const corners = available.filter((index) => {
    const row = Math.floor(index / size); const col = index % size;
    return (row === 0 || row === size - 1) && (col === 0 || col === size - 1);
  });
  const choices = corners.length ? corners : available;
  return choices[Math.floor(Math.random() * choices.length)];
}

function perfectMove(board) {
  const memo = new Map();
  function solve(position, turn) {
    const key = `${position.join('')}:${turn}`;
    if (memo.has(key)) return memo.get(key);
    const winsX = getWinningCells(position, 3, 'X').length > 0;
    const winsO = getWinningCells(position, 3, 'O').length > 0;
    if (winsO) return { score: 10, move: -1 };
    if (winsX) return { score: -10, move: -1 };
    const spaces = position.map((value, index) => value === null ? index : -1).filter((index) => index >= 0);
    if (!spaces.length) return { score: 0, move: -1 };
    let best = { score: turn === 'O' ? -Infinity : Infinity, move: spaces[0] };
    for (const index of spaces) {
      const next = [...position]; next[index] = turn;
      const result = solve(next, turn === 'O' ? 'X' : 'O');
      const depthAdjusted = result.score > 0 ? result.score - 1 : result.score < 0 ? result.score + 1 : 0;
      if (turn === 'O' ? depthAdjusted > best.score : depthAdjusted < best.score) best = { score: depthAdjusted, move: index };
    }
    memo.set(key, best); return best;
  }
  return solve(board, 'O').move;
}

function startLocalAI() {
  const size = Number($('input[name="board-size"]:checked').value);
  localAI = true; mySymbol = 'X'; matchCode = '';
  const selectedDifficulty = $('#ai-difficulty').value;
  aiDifficulty = size === 3 || selectedDifficulty === 'easy' ? selectedDifficulty : 'medium';
  if (selectedDifficulty === 'perfect' && size !== 3) toast('Unbeatable practice is available on the 3 × 3 board. Using tactical AI here.');
  matchState = { code: 'PRACTICE', mode: 'casual', size, board: Array(size * size).fill(null), turn: 'X', status: 'active', gameStatus: 'playing', winner: null, moves: [], players: [{ name: player.name, symbol: 'X', online: true, registered: !player.guest }, { name: `${aiDifficulty === 'perfect' && size === 3 ? 'Perfect' : aiDifficulty === 'easy' ? 'Easy' : 'Smart'} AI`, symbol: 'O', online: true, registered: false }], timerSeconds: 0, turnEndsAt: null };
  $('#queue-state').classList.add('hidden'); $('#game-panel').classList.remove('hidden'); renderMatch();
}

function addChatLine(name, message, at) {
  const line = document.createElement('p'); line.className = name === 'system' ? 'chat-message system' : 'chat-message';
  if (name !== 'system') { const sender = document.createElement('b'); sender.textContent = name; line.append(sender); }
  const body = document.createTextNode(message); line.append(body);
  $('#chat-log').append(line); $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
}

async function loadLeaderboard(period = 'all') {
  try {
    leaderboardPeriod = period;
    $$('[data-period]').forEach((button) => button.classList.toggle('selected', button.dataset.period === period));
    const { players } = await api(`/api/leaderboard?limit=50&period=${period}`);
    const renderRow = (item, index, compact = false) => {
      const row = document.createElement('div'); row.className = 'leader-row';
      const rank = document.createElement('span'); rank.className = 'leader-number'; rank.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('span'); name.className = 'leader-name'; name.textContent = item.username;
      const rating = document.createElement('span'); rating.className = compact ? 'leader-rating' : 'leader-level'; rating.textContent = compact ? String(item.rating) : `LV ${item.level}`;
      row.append(rank, name, rating); return row;
    };
    $('#home-leaderboard').replaceChildren(...players.slice(0, 5).map((item, index) => renderRow(item, index, true)));
    if (!players.length) $('#home-leaderboard').innerHTML = '<div class="empty-state">No ranked players yet. Take the first spot.</div>';
    const body = $('#leaderboard-body');
    body.replaceChildren(...players.map((item, index) => {
      const row = document.createElement('tr');
      for (const value of [String(index + 1).padStart(2, '0')]) { const cell = document.createElement('td'); cell.className = 'rank-cell'; cell.textContent = value; row.append(cell); }
      const playerCell = document.createElement('td'); const playerName = document.createElement('span'); playerName.className = 'player-table-name'; const avatar = document.createElement('i'); avatar.textContent = item.username.slice(0, 1).toUpperCase(); playerName.append(avatar, document.createTextNode(item.username)); playerCell.append(playerName); row.append(playerCell);
      for (const value of [item.level, item.wins, `${item.wins} / ${item.losses} / ${item.draws}`, item.rating]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      return row;
    }));
    if (!players.length) body.innerHTML = '<tr><td colspan="6">No ranked matches yet.</td></tr>';
  } catch (error) { $('#home-leaderboard').innerHTML = '<div class="empty-state">Rankings need a database connection.</div>'; if (!$('#leaderboard-view').classList.contains('hidden')) toast(error.message); }
}

async function loadHistory(reset = false) {
  if (reset) { historyPage = 0; $('#history-body').replaceChildren(); }
  if (player.guest) { $('#history-body').innerHTML = '<tr><td colspan="5">Create an account to save your match history.</td></tr>'; $('#profile-stats').replaceChildren(); return; }
  try {
    const { matches, hasMore } = await api(`/api/history?page=${historyPage}`);
    const rows = matches.map((match) => {
      const row = document.createElement('tr'); const result = document.createElement('td'); result.textContent = match.player_result || match.result || 'DRAW';
      const opponent = document.createElement('td'); opponent.textContent = match.opponent || 'Guest';
      const mode = document.createElement('td'); mode.textContent = `${match.mode} · ${match.board_size}×${match.board_size}`;
      const date = document.createElement('td'); date.textContent = match.completed_at ? new Date(match.completed_at).toLocaleDateString() : '—';
      const replay = document.createElement('td'); const button = document.createElement('button'); button.className = 'person-action'; button.textContent = 'Replay'; button.addEventListener('click', () => openReplay(match.id)); replay.append(button); row.append(result, opponent, mode, date, replay); return row;
    });
    $('#history-body').append(...rows);
    if (reset && !matches.length) $('#history-body').innerHTML = '<tr><td colspan="5">No completed matches yet. Your first one is waiting.</td></tr>';
    $('#history-more').classList.toggle('hidden', !hasMore);
    if (reset) {
      const { stats } = await api('/api/profile');
      $('#profile-stats').replaceChildren(...[['rating', stats.rating], ['level', stats.level], ['wins', stats.wins], ['losses', stats.losses], ['win rate', `${stats.winRate}%`]].map(([label, value]) => { const item = document.createElement('div'); item.className = 'stat-cell'; const b = document.createElement('b'); b.textContent = value; const span = document.createElement('span'); span.textContent = label; item.append(b, span); return item; }));
    }
  } catch (error) { $('#history-body').innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`; }
}

async function openReplay(id) {
  try {
    replayData = await api(`/api/matches/${encodeURIComponent(id)}/replay`);
    replayData.step = 0;
    $('#replay-caption').textContent = `${replayData.match.board_size} × ${replayData.match.board_size} · ${replayData.moves.length} moves`;
    drawReplay(); $('#replay-dialog').showModal();
  } catch (error) { toast(error.message); }
}

function drawReplay() {
  if (!replayData) return;
  const { match, moves, step } = replayData;
  const board = Array(match.board_size ** 2).fill('');
  for (const move of moves.slice(0, step)) board[move.cell_index] = move.player_symbol;
  const target = $('#replay-board'); target.className = `replay-board size-${match.board_size}`;
  target.replaceChildren(...board.map((symbol) => { const cell = document.createElement('span'); cell.className = symbol ? `mark-${symbol.toLowerCase()}` : ''; cell.textContent = symbol; return cell; }));
  $('#replay-step').textContent = step ? `Move ${step} / ${moves.length}` : 'Start';
  $('#replay-prev').disabled = step === 0; $('#replay-next').disabled = step >= moves.length;
}

async function loadFriends() {
  if (player.guest) { $('#friends-list').innerHTML = '<div class="empty-state">Sign in to search for and keep friends.</div>'; return; }
  try {
    const { friends } = await api('/api/friends');
    const rows = friends.map((friend) => {
      const incoming = String(friend.addressee_id) === String(player.id) && friend.status === 'pending';
      const status = friend.status === 'accepted' ? 'Friend' : incoming ? 'Wants to play' : 'Request sent';
      return createPersonRow(friend.username, status, incoming ? [
        ['Accept', () => friendRequest('/api/friends/respond', { userId: friend.id, accept: true })],
        ['Decline', () => friendRequest('/api/friends/respond', { userId: friend.id, accept: false })],
      ] : friend.status === 'accepted' ? [['Challenge', () => challengeFriend(friend.username)]] : []);
    });
    $('#friends-list').replaceChildren(...rows);
    if (!rows.length) $('#friends-list').innerHTML = '<div class="empty-state">No friends here yet. Search a username above.</div>';
  } catch (error) { $('#friends-list').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}

function createPersonRow(name, subtitle, actions = []) {
  const row = document.createElement('div'); row.className = 'person-row';
  const avatar = document.createElement('span'); avatar.className = 'person-avatar'; avatar.textContent = name.slice(0, 1).toUpperCase();
  const info = document.createElement('div'); info.className = 'person-info'; const title = document.createElement('b'); title.textContent = name; const detail = document.createElement('small'); detail.textContent = subtitle; info.append(title, detail); row.append(avatar, info);
  for (const [label, action] of actions) { const button = document.createElement('button'); button.className = 'person-action'; button.type = 'button'; button.textContent = label; button.addEventListener('click', action); row.append(button); }
  return row;
}

async function friendRequest(url, data) {
  try { await api(url, { method: 'POST', body: data }); toast('Friend list updated.'); loadFriends(); }
  catch (error) { toast(error.message); }
}

async function challengeFriend(name) {
  if (player.guest) return openAuth('register');
  const response = await emitAck('room:create', currentSettings());
  if (!response?.ok) return toast(response?.error || 'Could not create a room.');
  const link = `${location.origin}/?room=${response.code}`;
  try { await navigator.clipboard.writeText(link); toast(`Invite link copied for ${name}.`); }
  catch { window.prompt(`Send this invite to ${name}:`, link); }
}

async function loadAdmin() {
  if (player.role !== 'admin') return showView('home');
  try {
    const data = await api('/api/admin/overview');
    $('#admin-stats').replaceChildren(...[['users', data.totalUsers], ['active matches', data.activeMatches || 0], ['completed', data.completedMatches || 0]].map(([label, value]) => { const item = document.createElement('div'); item.className = 'admin-stat'; const number = document.createElement('b'); number.textContent = value; const caption = document.createElement('span'); caption.textContent = label; item.append(number, caption); return item; }));
    const reportRows = data.reports.map((report) => createPersonRow(`#${report.id} · ${report.reason}`, `${report.target || 'Unknown player'} · ${report.status}`, report.status === 'open' ? [['Review', () => reviewReport(report.id, 'reviewed')], ['Dismiss', () => reviewReport(report.id, 'dismissed')], ['Action', () => reviewReport(report.id, 'actioned')]] : []));
    $('#admin-reports').replaceChildren(...(reportRows.length ? reportRows : [emptyRow('No reports to review.') ]));
    const { users } = await api('/api/admin/users');
    const userRows = users.map((user) => createPersonRow(user.username, `${user.email} · ${user.role}${user.suspended_at ? ' · suspended' : ''}`, [['', () => {}]]));
    userRows.forEach((row, index) => { const button = row.querySelector('button'); button.textContent = users[index].suspended_at ? 'Restore' : 'Suspend'; button.addEventListener('click', () => suspendUser(users[index].id, !users[index].suspended_at)); });
    $('#admin-users').replaceChildren(...(userRows.length ? userRows : [emptyRow('No accounts found.') ]));
  } catch (error) { $('#admin-stats').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}

function emptyRow(message) { const item = document.createElement('div'); item.className = 'empty-state'; item.textContent = message; return item; }
async function reviewReport(id, status) { try { await api(`/api/admin/reports/${id}/review`, { method: 'POST', body: { status } }); toast('Report updated.'); loadAdmin(); } catch (error) { toast(error.message); } }
async function suspendUser(id, suspended) { if (!window.confirm(`${suspended ? 'Suspend' : 'Restore'} this player account?`)) return; try { await api(`/api/admin/users/${id}/suspend`, { method: 'POST', body: { suspended } }); toast('Account updated.'); loadAdmin(); } catch (error) { toast(error.message); } }

function escapeHtml(value) { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; }

function openAuth(mode = 'login') { setAuthMode(mode); $('#auth-error').textContent = ''; $('#auth-dialog').showModal(); }
function setAuthMode(mode) {
  const register = mode === 'register';
  $$('[data-auth-mode]').forEach((button) => button.classList.toggle('selected', button.dataset.authMode === mode));
  $$('.register-only').forEach((item) => item.classList.toggle('hidden', !register));
  $('#login-label').classList.toggle('hidden', register);
  $('#auth-title').textContent = register ? 'Make it official.' : 'Play under your name.';
  $('#auth-description').textContent = register ? 'Save your stats, history, and ranking.' : 'Pick up your stats, history, and ranking.';
  $('#auth-submit').innerHTML = `${register ? 'Create account' : 'Sign in'} <span>↗</span>`;
  $('#auth-form').dataset.mode = mode;
}

function playTone(frequency) {
  if (!soundEnabled) return;
  try {
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = frequency; gain.gain.setValueAtTime(.045, context.currentTime); gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .13);
    oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .13); oscillator.onended = () => context.close();
  } catch { /* Audio may be unavailable in a restricted browser. */ }
}

function init() {
  const savedTheme = localStorage.getItem('gridline-theme');
  if (savedTheme === 'dark') document.body.dataset.theme = 'dark';
  $('#sound-icon').textContent = soundEnabled ? '♫' : '♪';
  connectSocket();
  api('/api/bootstrap').then(({ csrfToken: token, player: currentPlayer }) => {
    csrfToken = token; updatePlayer(currentPlayer); loadLeaderboard(); roomStateFromInvite();
  }).catch((error) => toast(error.message));

  $$('.nav-link, [data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  $('#account-button').addEventListener('click', () => openAuth(player?.guest ? 'login' : 'login'));
  $('#profile-button').addEventListener('click', async () => {
    $('#profile-name').textContent = player.name;
    $('#profile-detail').textContent = player.guest ? 'Guest matches are casual and are not saved to a competitive profile.' : `Player since ${new Date().getFullYear()}. Ranked games update your rating.`;
    $('#profile-auth-button').classList.toggle('hidden', !player.guest);
    $('#profile-card-content').replaceChildren();
    if (!player.guest) {
      try {
        const [{ stats }, { achievements }] = await Promise.all([api('/api/profile'), api('/api/profile/achievements')]);
        $('#profile-card-content').replaceChildren(...[['Rating', stats.rating], ['Level', stats.level], ['Wins', stats.wins], ['Win rate', `${stats.winRate}%`]].map(([label, value]) => { const cell = document.createElement('div'); cell.className = 'profile-stat'; const b = document.createElement('b'); b.textContent = value; const caption = document.createElement('span'); caption.textContent = label; cell.append(b, caption); return cell; }));
        const achievementList = $('#profile-achievements');
        achievementList.replaceChildren();
        if (achievements.length) {
          const heading = document.createElement('span'); heading.className = 'section-kicker'; heading.textContent = 'ACHIEVEMENTS'; achievementList.append(heading);
          for (const achievement of achievements) { const item = document.createElement('div'); item.className = `achievement-row${achievement.earned ? ' earned' : ''}`; const name = document.createElement('b'); name.textContent = achievement.name; const detail = document.createElement('span'); detail.textContent = achievement.earned ? `Earned · +${achievement.xp_reward} XP` : achievement.description; item.append(name, detail); achievementList.append(item); }
        }
      }
      catch (error) { toast(error.message); }
    }
    $('#profile-dialog').showModal();
  });
  $('#profile-auth-button').addEventListener('click', () => { $('#profile-dialog').close(); openAuth('register'); });
  $('#theme-toggle').addEventListener('click', () => { const dark = document.body.dataset.theme !== 'dark'; document.body.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('gridline-theme', dark ? 'dark' : 'light'); });
  $('#sound-toggle').addEventListener('click', () => { soundEnabled = !soundEnabled; localStorage.setItem('gridline-sound', soundEnabled ? 'on' : 'off'); $('#sound-icon').textContent = soundEnabled ? '♫' : '♪'; toast(soundEnabled ? 'Sound on.' : 'Sound off.'); });
  $('#quickplay-button').addEventListener('click', () => {
    const settings = currentSettings();
    if (settings.mode === 'ranked' && player.guest) { openAuth('register'); toast('Create an account to queue for ranked matches.'); return; }
    startRoom('matchmaking:join', settings);
  });
  $('#create-room-button').addEventListener('click', () => startRoom('room:create', currentSettings()));
  $('#join-room-button').addEventListener('click', () => { const code = $('#room-code').value.trim().toUpperCase(); if (!code) return toast('Enter a room code first.'); startRoom('room:join', code); });
  $('#room-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#join-room-button').click(); } });
  $('#ai-button').addEventListener('click', startLocalAI);
  $('#watch-match-button').addEventListener('click', async () => {
    const code = $('#room-code').value.trim().toUpperCase();
    if (!code) return toast('Enter the live room code above, then choose Watch a room.');
    isSpectating = true;
    const response = await emitAck('room:spectate', code);
    if (!response?.ok) { isSpectating = false; return toast(response?.error || 'Could not watch that room.'); }
    localAI = false; mySymbol = null; matchState = response.state; matchCode = code;
    $('#game-panel').classList.remove('hidden'); renderMatch(); toast('You joined as a spectator.');
  });
  $('#copy-invite-button').addEventListener('click', async () => { const link = `${location.origin}/?room=${matchCode}`; try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); } catch { window.prompt('Copy this invite link:', link); } });
  $('#cancel-queue-button').addEventListener('click', async () => { if (matchCode) await emitAck('match:leave'); $('#queue-state').classList.add('hidden'); matchCode = ''; });
  $('#back-lobby-button').addEventListener('click', async () => { if (matchState?.status === 'active' && !isSpectating && !localAI && !window.confirm('Leave this match? It will count as a forfeit.')) return; if (isSpectating) await emitAck('room:unspectate'); else if (!localAI) await emitAck('match:leave'); localAI = false; isSpectating = false; matchState = null; matchCode = ''; $('#game-panel').classList.add('hidden'); $('#queue-state').classList.add('hidden'); });
  $('#new-game-button').addEventListener('click', () => { localAI = false; matchState = null; matchCode = ''; $('#game-panel').classList.add('hidden'); $('#room-code').focus(); });
  $('#rematch-button').addEventListener('click', async () => { const result = await emitAck('match:rematch'); if (!result?.ok) toast(result?.error || 'Rematch unavailable.'); });
  $('#chat-form').addEventListener('submit', (event) => { event.preventDefault(); const input = $('#chat-input'); const message = input.value.trim(); if (!message) return; if (localAI) { toast('Chat opens when you play online.'); return; } socket.emit('chat:send', { message }, (result) => { if (result?.ok) input.value = ''; else toast(result?.error || 'Could not send message.'); }); });
  $('#mute-chat-button').addEventListener('click', () => { mutedChat = !mutedChat; $('#mute-chat-button').textContent = mutedChat ? 'Unmute' : 'Mute'; $('#mute-chat-button').setAttribute('aria-pressed', String(mutedChat)); });
  $$('.reactions button').forEach((button) => button.addEventListener('click', () => { if (localAI) return toast('Reactions are for online matches.'); socket.emit('match:reaction', button.dataset.reaction, (result) => { if (!result?.ok) toast(result?.error || 'Reaction unavailable.'); }); }));
  $('#report-button').addEventListener('click', () => $('#report-dialog').showModal());
  $('#report-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const opponent = matchState?.players?.find((item) => item.symbol !== mySymbol); try { await api('/api/reports', { method: 'POST', body: { reason: form.get('reason'), details: form.get('details'), userId: opponent?.id } }); $('#report-dialog').close(); toast('Report sent. Thank you.'); } catch (error) { $('#report-error').textContent = error.message; } });
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('#auth-error').textContent = '';
    const form = new FormData(event.currentTarget); const data = Object.fromEntries(form.entries());
    const register = event.currentTarget.dataset.mode === 'register';
    try {
      const result = await api(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: register ? { ...data, linkGuest: form.get('linkGuest') === 'true' } : { login: data.login, password: data.password } });
      updatePlayer(result.player); $('#auth-dialog').close(); toast(`Welcome, ${result.player.name}.`);
      socket.disconnect(); socket.connect();
    } catch (error) { $('#auth-error').textContent = error.message; }
  });
  $$('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  $('#continue-guest').addEventListener('click', () => $('#auth-dialog').close());
  $('#forgot-password-button').addEventListener('click', () => { $('#auth-dialog').close(); $('#forgot-dialog').showModal(); });
  $('#forgot-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('#forgot-error').textContent = '';
    try { const form = new FormData(event.currentTarget); const result = await api('/api/auth/password/request', { method: 'POST', body: { email: form.get('email') } }); $('#forgot-dialog').close(); toast(result.message); }
    catch (error) { $('#forgot-error').textContent = error.message; }
  });
  $('#reset-form').addEventListener('submit', async (event) => {
    event.preventDefault(); $('#reset-error').textContent = '';
    try { const form = new FormData(event.currentTarget); const result = await api('/api/auth/password/reset', { method: 'POST', body: { token: resetToken, password: form.get('password') } }); $('#reset-dialog').close(); history.replaceState(null, '', location.pathname); openAuth('login'); toast(result.message); }
    catch (error) { $('#reset-error').textContent = error.message; }
  });
  $('#logout-button').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', body: {} }); const data = await api('/api/bootstrap'); csrfToken = data.csrfToken; updatePlayer(data.player); showView('home'); toast('Signed out.'); } catch (error) { toast(error.message); } });
  $('#player-search-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (player.guest) return openAuth('register');
    const query = $('#player-search').value.trim(); if (query.length < 2) return toast('Enter at least two characters.');
    try { const { players } = await api(`/api/players/search?q=${encodeURIComponent(query)}`); const rows = players.map((item) => createPersonRow(item.username, 'GRIDLINE PLAYER', [['Add friend', () => friendRequest('/api/friends/request', { userId: item.id })]])); $('#search-results').replaceChildren(...(rows.length ? rows : [emptyRow('No players with that name.') ])); }
    catch (error) { toast(error.message); }
  });
  $('#refresh-friends').addEventListener('click', loadFriends);
  $('#refresh-leaderboard').addEventListener('click', loadLeaderboard);
  $$('[data-period]').forEach((button) => button.addEventListener('click', () => loadLeaderboard(button.dataset.period)));
  $('#history-more').addEventListener('click', () => { historyPage += 1; loadHistory(false); });
  $('#refresh-admin').addEventListener('click', loadAdmin);
  $('#replay-prev').addEventListener('click', () => { if (replayData?.step > 0) { replayData.step -= 1; drawReplay(); } });
  $('#replay-next').addEventListener('click', () => { if (replayData && replayData.step < replayData.moves.length) { replayData.step += 1; drawReplay(); } });
  $('#replay-play').addEventListener('click', () => { clearInterval(replayTimer); replayTimer = setInterval(() => { if (!replayData || replayData.step >= replayData.moves.length) { clearInterval(replayTimer); return; } replayData.step += 1; drawReplay(); }, 650); });
  $('#replay-dialog').addEventListener('close', () => clearInterval(replayTimer));
}

init();