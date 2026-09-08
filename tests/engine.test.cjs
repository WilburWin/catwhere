const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const bank = require('../levels.js');

for (const [key, boards] of Object.entries(bank)) {
  test(`${key}: curated and generated levels have exactly one solution and connected regions`, () => {
    assert.equal(boards.length, 16);
    for (let number = 1; number <= 160; number++) {
      const board = E.level(bank, key, number), n = board.length;
      assert.equal(new Set(board.flat()).size, n);
      const solutions = E.solve(board);
      assert.equal(solutions.length, 1, `${key} ${number}: unique solution`);
      if (key === 'hard') {
        const regionSizes = Array(n).fill(0);
        board.flat().forEach(color => regionSizes[color]++);
        assert.ok(Math.min(...regionSizes) >= 4, `${key} ${number}: no one-, two- or three-cell regions`);
        assert.ok(Math.max(...regionSizes) <= 50, `${key} ${number}: no region covers over half the board`);
      }
      const cats = new Set(solutions[0].map((c, r) => r * n + c));
      assert.ok(E.complete(board, cats));
      assert.equal(E.excluded(board, cats).size, n * n - n);
      for (let color = 0; color < n; color++) {
        const indexes = board.flat().map((value, i) => value === color ? i : -1).filter(i => i >= 0);
        const reached = new Set([indexes[0]]), queue = [indexes[0]];
        while (queue.length) {
          const i = queue.shift(), r = Math.floor(i / n), c = i % n;
          for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const rr = r + dr, cc = c + dc, next = rr * n + cc;
            if (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc] === color && !reached.has(next)) { reached.add(next); queue.push(next); }
          }
        }
        assert.equal(reached.size, indexes.length, `${key} ${number}: region ${color} connected`);
      }
    }
  });
}
test('row, column, region and diagonal conflicts are detected', () => {
  const board = [[0,0,1],[2,1,1],[2,2,1]], cats = new Set([0]);
  assert.match(E.conflict(board, cats, 2), /行/);
  assert.match(E.conflict(board, cats, 6), /列/);
  assert.match(E.conflict(board, cats, 4), /相邻/);
  assert.equal(E.conflict(board, cats, 8), '');
  assert.match(E.conflict(board, new Set([2]), 7 + 1), /列/);
  assert.match(E.conflict([[0,1,2],[1,0,2],[1,2,0]], new Set([0]), 8), /色块/);
});
test('automatic exclusion reverses when a cat is removed', () => {
  const board = bank.hard[0], cats = new Set([0]);
  assert.ok(E.excluded(board, cats).has(10));
  assert.ok(!E.excluded(board, cats).has(0));
  cats.delete(0);
  assert.equal(E.excluded(board, cats).size, 0);
});
test('fixed placements constrain the solver; incomplete boards never win', () => {
  const board = bank.hard[0], solution = E.solve(board, 1)[0];
  assert.equal(E.solve(board, 2, [solution[0]]).length, 1);
  assert.equal(E.solve(board, 2, [(solution[0] + 1) % board.length]).length, 0);
  assert.equal(E.complete(board, new Set()), false);
});
test('rotations preserve source arrays', () => {
  const board = bank.medium[0], copy = JSON.stringify(board);
  for (let i = 0; i < 8; i++) E.transform(board, i);
  assert.equal(JSON.stringify(board), copy);
});

test('difficulty dimensions and unbounded deterministic generation', () => {
  assert.deepEqual(E.DIFFICULTY_SIZES, { easy: 5, medium: 7, hard: 10 });
  assert.equal(E.resolveSize('easy'), 5);
  assert.equal(E.resolveSize(7), 7);
  assert.equal(E.resolveSize(4), 0);
  for (const [key, size] of Object.entries(E.DIFFICULTY_SIZES)) {
    const first = E.level(bank, key, 129), second = E.level(bank, key, 129);
    assert.equal(first.length, size);
    assert.deepEqual(first, second, `${key}: same number is reproducible`);
    assert.equal(E.solve(first, 2).length, 1, `${key}: generated board has one solution`);
    assert.equal(E.isConnected(first), true, `${key}: generated regions are connected`);
    assert.notDeepEqual(first, E.level(bank, key, 130), `${key}: later numbers do not cycle immediately`);
    first[0][0] = 99;
    assert.notEqual(E.level(bank, key, 129)[0][0], 99, `${key}: cached boards are protected from mutation`);
  }
});

test('placement feedback distinguishes correct, wrong and conflicting cells', () => {
  const board = E.level(bank, 'easy', 1), solution = E.solve(board, 1)[0];
  const answer = solution[0];
  const correct = E.evaluatePlacement(board, solution, new Set(), answer);
  assert.equal(correct.status, 'correct');
  assert.equal(correct.correct, true);
  const wrong = (answer + 1) % board.length;
  const wrongResult = E.evaluatePlacement(board, solution, new Set(), wrong);
  assert.equal(wrongResult.status, 'wrong');
  assert.equal(wrongResult.correct, false);
  const conflictResult = E.evaluatePlacement(board, solution, new Set([answer]), (Math.floor(answer / board.length) * board.length) + ((answer + 1) % board.length));
  assert.equal(conflictResult.status, 'conflict');
  assert.equal(E.evaluatePlacement(board, solution, new Set([answer]), answer).status, 'remove');
});

test('streak helpers reset on a loss and retain the best value', () => {
  assert.equal(E.updateStreak(3, true), 4);
  assert.equal(E.updateStreak(3, false), 0);
  assert.equal(E.updateBestStreak(5, 3), 5);
  assert.equal(E.updateBestStreak(5, 7), 7);
});
