import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, playMove } from '../src/game.js';

test('validates turn order and occupied cells without mutating the prior state', () => {
  const game = createGame();
  const afterMove = playMove(game, 'X', 0);
  assert.equal(afterMove.turn, 'O');
  assert.equal(game.board[0], null);
  assert.throws(() => playMove(afterMove, 'X', 1), /not your turn/);
  assert.throws(() => playMove(afterMove, 'O', 0), /occupied/);
});

test('detects wins in rows, columns, and diagonals', () => {
  for (const winningMoves of [[0, 3, 1, 4, 2], [0, 1, 3, 2, 6], [0, 1, 4, 2, 8]]) {
    const game = winningMoves.reduce((state, cell, turn) => playMove(state, turn % 2 ? 'O' : 'X', cell), createGame());
    assert.equal(game.status, 'finished');
    assert.equal(game.winner, 'X');
  }
});

test('detects a draw and rejects moves after a result', () => {
  const moves = [0, 1, 2, 4, 3, 5, 7, 6, 8];
  const game = moves.reduce((state, cell, turn) => playMove(state, turn % 2 ? 'O' : 'X', cell), createGame());
  assert.equal(game.status, 'draw');
  assert.throws(() => playMove(game, 'O', 8), /finished/);
});

test('supports 4x4 and 5x5 boards with three-in-a-row wins', () => {
  for (const size of [4, 5]) {
    const game = [0, size, 1, size + 1, 2].reduce(
      (state, cell, turn) => playMove(state, turn % 2 ? 'O' : 'X', cell), createGame(size),
    );
    assert.equal(game.winner, 'X');
  }
});