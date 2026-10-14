const WIN_LENGTH = 3;

export function createGame(size = 3) {
  if (![3, 4, 5].includes(size)) throw new Error('Board size must be 3, 4, or 5');
  return { size, board: Array(size * size).fill(null), turn: 'X', moves: [], status: 'playing', winner: null };
}

export function playMove(game, player, index) {
  if (game.status !== 'playing') throw new Error('Game is already finished');
  if (player !== game.turn) throw new Error('It is not your turn');
  if (!Number.isInteger(index) || index < 0 || index >= game.board.length) throw new Error('Invalid cell');
  if (game.board[index] !== null) throw new Error('Cell is already occupied');

  const next = {
    ...game,
    board: [...game.board],
    moves: [...game.moves, { player, index, number: game.moves.length + 1, at: new Date().toISOString() }],
  };
  next.board[index] = player;
  if (hasWinningLine(next.board, next.size, index, player)) {
    next.status = 'finished';
    next.winner = player;
  } else if (next.moves.length === next.board.length) {
    next.status = 'draw';
  } else {
    next.turn = player === 'X' ? 'O' : 'X';
  }
  return next;
}

function hasWinningLine(board, size, index, player) {
  const row = Math.floor(index / size);
  const col = index % size;
  const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];

  return directions.some(([dr, dc]) => {
    let count = 1;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < size && c >= 0 && c < size && board[r * size + c] === player) {
        count += 1;
        r += dr * sign;
        c += dc * sign;
      }
    }
    return count >= WIN_LENGTH;
  });
}