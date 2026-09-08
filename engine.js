(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /*
   * Keep difficulty dimensions in the engine so level generation is shared by
   * the browser and the node verification scripts.
   */
  const DIFFICULTY_SIZES = Object.freeze({ easy: 5, medium: 7, hard: 10 });
  const DEFAULT_GENERATION_ATTEMPTS = 1024;
  const MAX_GENERATED_CACHE = 160;
  const generatedCache = new Map();
  let randomSequence = 0;

  function cloneBoard(board) { return board.map(row => row.slice()); }

  function boardSize(board) {
    return Array.isArray(board) && board.length > 0 && board.every(row => Array.isArray(row) && row.length === board.length)
      ? board.length : 0;
  }

  function solve(regions, limit = 2, fixed = []) {
    const n = boardSize(regions), solutions = [], path = [], columns = new Set(), colors = new Set();
    const maxSolutions = limit === Infinity ? Number.MAX_SAFE_INTEGER : Number(limit);
    const constraints = Array.isArray(fixed) ? fixed : [];
    if (!n || !Number.isSafeInteger(maxSolutions) || maxSolutions < 1) return solutions;
    function visit(row) {
      if (solutions.length >= maxSolutions) return;
      if (row === n) { solutions.push(path.slice()); return; }
      for (let col = 0; col < n; col++) {
        if (constraints[row] != null && constraints[row] !== col) continue;
        const color = regions[row][col];
        if (columns.has(col) || colors.has(color) || (row && Math.abs(path[row - 1] - col) <= 1)) continue;
        path.push(col); columns.add(col); colors.add(color);
        visit(row + 1);
        path.pop(); columns.delete(col); colors.delete(color);
      }
    }
    visit(0); return solutions;
  }

  function conflict(regions, cats, index) {
    const n = boardSize(regions);
    if (!n || !Number.isInteger(index) || index < 0 || index >= n * n) return '这个格子不存在';
    const placed = cats instanceof Set ? cats : new Set(cats || []);
    const r = Math.floor(index / n), c = index % n;
    for (const other of placed) {
      if (other === index) continue;
      if (!Number.isInteger(other) || other < 0 || other >= n * n) continue;
      const rr = Math.floor(other / n), cc = other % n;
      if (rr === r) return '这一行已经有一只猫啦';
      if (cc === c) return '这一列已经有一只猫啦';
      if (regions[rr][cc] === regions[r][c]) return '这个色块已经有一只猫啦';
      if (Math.abs(rr - r) <= 1 && Math.abs(cc - c) <= 1) return '猫咪需要一点空间，斜角也不能相邻';
    }
    return '';
  }

  function excluded(regions, cats) {
    const result = new Set(), n = boardSize(regions);
    if (!n) return result;
    const placed = cats instanceof Set ? cats : new Set(cats || []);
    for (let i = 0; i < n * n; i++) if (!placed.has(i) && conflict(regions, placed, i)) result.add(i);
    return result;
  }

  function complete(regions, cats) {
    const n = boardSize(regions);
    if (!n) return false;
    const placed = cats instanceof Set ? cats : new Set(cats || []);
    return placed.size === n && [...placed].every(i => Number.isInteger(i) && i >= 0 && i < n * n && !conflict(regions, placed, i));
  }

  function transform(board, variant = 0) {
    let out = cloneBoard(board);
    let turn = Number.isFinite(variant) ? Math.trunc(variant) : 0;
    turn = ((turn % 8) + 8) % 8;
    if (turn >= 4) out = out.map(row => row.slice().reverse());
    for (let i = 0; i < turn % 4; i++) out = out[0].map((_, c) => out.map(row => row[c]).reverse());
    return out;
  }

  function resolveSize(sizeOrDifficulty) {
    if (typeof sizeOrDifficulty === 'string' && Object.hasOwn(DIFFICULTY_SIZES, sizeOrDifficulty)) return DIFFICULTY_SIZES[sizeOrDifficulty];
    const size = Number(sizeOrDifficulty);
    // The public generator intentionally supports the three game dimensions
    // only.  The solver itself still accepts arbitrary square boards, but
    // allowing an accidental 32×32 generation request would make uniqueness
    // search unbounded and can freeze an offline page.
    return Number.isSafeInteger(size) && Object.values(DIFFICULTY_SIZES).includes(size) ? size : 0;
  }

  // FNV-1a gives stable seeds in browser and node.
  function hashSeed(value) {
    const text = String(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function makeRandom(seed) {
    let value = hashSeed(seed) || 0x6d2b79f5;
    return () => {
      // Mulberry32 is deterministic and sufficient for shuffling regions.
      value = (value + 0x6D2B79F5) >>> 0;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(items, random) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function fallbackSolution(n) {
    // Interleaving even and odd columns works for the game's 5/7/10 sizes.
    const candidate = [
      ...Array.from({ length: n }, (_, i) => i).filter(i => i % 2 === 0),
      ...Array.from({ length: n }, (_, i) => i).filter(i => i % 2)
    ];
    if (candidate.length === n && candidate.every((c, r) => !r || Math.abs(c - candidate[r - 1]) > 1)) return candidate;
    return Array.from({ length: n }, (_, i) => i);
  }

  function makeSolution(n, random) {
    const result = [], used = new Uint8Array(n);
    function visit(row) {
      if (row === n) return true;
      for (const col of shuffle(Array.from({ length: n }, (_, i) => i), random)) {
        if (used[col] || (row && Math.abs(col - result[row - 1]) <= 1)) continue;
        result[row] = col; used[col] = 1;
        if (visit(row + 1)) return true;
        used[col] = 0; result.pop();
      }
      return false;
    }
    return visit(0) ? result.slice() : fallbackSolution(n);
  }

  function makeCandidate(n, random) {
    const solution = makeSolution(n, random);
    const board = Array.from({ length: n }, () => Array(n).fill(-1));
    const frontier = [];
    // A linear spread keeps the shapes varied while making unique boards with
    // no more than a couple of single-cell clue regions practical to find.
    const weights = Array.from({ length: n }, () => 0.2 + random() * 2);
    function grow(r, c, color) {
      board[r][c] = color;
      for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc] === -1) frontier.push({ r: rr, c: cc, color, rank: random() / weights[color] });
      }
    }
    solution.forEach((c, r) => { board[r][c] = r; });
    solution.forEach((c, r) => grow(r, c, r));
    while (frontier.length) {
      frontier.sort((a, b) => b.rank - a.rank);
      const cell = frontier.pop();
      if (board[cell.r][cell.c] === -1) grow(cell.r, cell.c, cell.color);
    }
    return board;
  }

  function hasBalancedRegions(board) {
    const n = boardSize(board);
    if (!n || n < 10) return true;
    const sizes = Array(n).fill(0);
    for (const color of board.flat()) if (Number.isInteger(color) && color >= 0 && color < n) sizes[color]++;
    const singleCells = sizes.filter(size => size === 1).length;
    // This is a cheap pre-filter. Tiny regions are expanded later while
    // preserving uniqueness, so rejecting them here only wastes good seeds.
    return Math.max(...sizes) <= 50 && singleCells <= 5;
  }

  function expandSmallRegions(board, random, minimum = 4) {
    let current = cloneBoard(board), solution = solve(current, 1)[0];
    if (!solution) return current;
    const n = current.length;
    const protectedCells = new Set(solution.map((col, row) => row * n + col));
    for (let pass = 0; pass < n; pass++) {
      const sizes = Array(n).fill(0);
      current.flat().forEach(color => sizes[color]++);
      const tiny = shuffle(Array.from({ length: n }, (_, color) => color).filter(color => sizes[color] < minimum), random)
        .sort((a, b) => sizes[a] - sizes[b]);
      if (!tiny.length) return current;
      let changed = false;
      for (const color of tiny) {
        const neighbours = new Set();
        for (let index = 0; index < n * n; index++) {
          const row = Math.floor(index / n), col = index % n;
          if (current[row][col] !== color) continue;
          for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const r = row + dr, c = col + dc, next = r * n + c;
            if (r >= 0 && r < n && c >= 0 && c < n && !protectedCells.has(next) && current[r][c] !== color && sizes[current[r][c]] > minimum) neighbours.add(next);
          }
        }
        for (const index of shuffle([...neighbours], random).sort((a, b) => sizes[current[Math.floor(b / n)][b % n]] - sizes[current[Math.floor(a / n)][a % n]])) {
          const trial = cloneBoard(current), r = Math.floor(index / n), c = index % n;
          trial[r][c] = color;
          if (!isConnected(trial) || solve(trial, 2).length !== 1) continue;
          current = trial; changed = true; break;
        }
      }
      if (!changed) return current;
    }
    return current;
  }

  function isConnected(board) {
    const n = boardSize(board);
    if (!n) return false;
    const values = board.flat(), colors = new Set(values);
    if (colors.size !== n || [...colors].some(color => !Number.isInteger(color) || color < 0 || color >= n)) return false;
    for (let color = 0; color < n; color++) {
      const indexes = values.map((value, i) => value === color ? i : -1).filter(i => i >= 0);
      if (!indexes.length) return false;
      const reached = new Set([indexes[0]]), queue = [indexes[0]];
      while (queue.length) {
        const current = queue.shift(), r = Math.floor(current / n), c = current % n;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const rr = r + dr, cc = c + dc, next = rr * n + cc;
          if (rr >= 0 && rr < n && cc >= 0 && cc < n && board[rr][cc] === color && !reached.has(next)) { reached.add(next); queue.push(next); }
        }
      }
      if (reached.size !== indexes.length) return false;
    }
    return true;
  }

  function isValidBoard(board, requireUnique = true) {
    if (!isConnected(board)) return false;
    return !requireUnique || solve(board, 2).length === 1;
  }

  function generatedLevelKey(size, seed, requireUnique = true) {
    return `${size}:${requireUnique ? 'unique' : 'any'}:${String(seed)}`;
  }

  function cacheGenerated(key, board) {
    // Keep infinite play from retaining every historical board forever.
    generatedCache.delete(key);
    generatedCache.set(key, cloneBoard(board));
    while (generatedCache.size > MAX_GENERATED_CACHE) generatedCache.delete(generatedCache.keys().next().value);
  }

  /**
   * Generate a connected region board with one solution.  The seed can be any
   * stable primitive; callers receive a fresh array so a round cannot mutate
   * the cached copy used by a later visit.
   */
  function generateLevel(sizeOrDifficulty, seed = 0, options = {}) {
    const n = resolveSize(sizeOrDifficulty);
    if (!n) throw new RangeError('棋盘尺寸必须是 5、7 或 10，或 easy、medium、hard');
    const requireUnique = options.unique !== false;
    const requestedAttempts = Number.isSafeInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : DEFAULT_GENERATION_ATTEMPTS;
    // A normal game level must satisfy uniqueness even when a caller supplies
    // a small preview budget. Non-unique previews may still opt into that
    // budget explicitly with unique:false.
    const minimumAttempts = n === 10 ? DEFAULT_GENERATION_ATTEMPTS * 4 : DEFAULT_GENERATION_ATTEMPTS;
    const attempts = requireUnique ? Math.max(requestedAttempts, minimumAttempts) : requestedAttempts;
    const key = generatedLevelKey(n, seed, requireUnique);
    const cached = generatedCache.get(key);
    if (cached) {
      generatedCache.delete(key);
      generatedCache.set(key, cached);
      return cloneBoard(cached);
    }
    const baseSeed = hashSeed(`${n}|${String(seed)}`);
    let best = null, bestSolutions = Infinity;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const random = makeRandom((baseSeed + Math.imul(attempt, 0x9e3779b9)) >>> 0);
      const candidate = makeCandidate(n, random);
      if (!isConnected(candidate) || !hasBalancedRegions(candidate)) continue;
      const solutionCount = solve(candidate, 2).length;
      if (solutionCount < bestSolutions) { best = candidate; bestSolutions = solutionCount; }
      if (!requireUnique || solutionCount === 1) {
        const result = requireUnique && n === 10 ? expandSmallRegions(candidate, random, 4) : candidate;
        if (n === 10) {
          const sizes = Array(n).fill(0);
          result.flat().forEach(color => sizes[color]++);
          if (Math.min(...sizes) < 4) continue;
        }
        cacheGenerated(key, result);
        return cloneBoard(result);
      }
    }
    // A caller can explicitly request a non-unique board, but the normal
    // generator must never silently ship an ambiguous puzzle.  Throwing here
    // lets the caller retry with a different seed instead of caching a bad
    // board under a supposedly unique level number.
    if (!requireUnique && best && isConnected(best)) {
      cacheGenerated(key, best);
      return cloneBoard(best);
    }
    throw new Error(`无法生成 ${n}×${n} 棋盘的唯一解`);
  }

  function randomLevel(sizeOrDifficulty, seed) {
    const actualSeed = seed === undefined ? `${Date.now()}:${randomSequence++}` : seed;
    return generateLevel(sizeOrDifficulty, actualSeed);
  }

  function level(bank, difficulty, number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new RangeError('关卡编号必须是正整数');
    const collection = Array.isArray(bank?.[difficulty]) ? bank[difficulty] : [];
    const expected = DIFFICULTY_SIZES[difficulty] || boardSize(collection[0]);
    // Use the curated opening set and its eight orientations when dimensions
    // match.  Every later number gets an independent deterministic seed.
    if (collection.length && expected && boardSize(collection[0]) === expected && number <= collection.length * 8) {
      const index = (number - 1) % collection.length;
      const variant = Math.floor((number - 1) / collection.length) % 8;
      return transform(collection[index], variant);
    }
    if (!expected) throw new RangeError(`未知难度：${difficulty}`);
    return generateLevel(expected, `${difficulty}:${number}`);
  }

  /** Classify a placement for UIs that reveal a cat only for the true answer. */
  function evaluatePlacement(regions, solution, cats, index) {
    const n = boardSize(regions), placed = cats instanceof Set ? cats : new Set(cats || []);
    if (!n || !Number.isInteger(index) || index < 0 || index >= n * n) return { status: 'invalid', ok: false, correct: false, message: '这个格子不存在' };
    if (placed.has(index)) return { status: 'remove', ok: true, correct: true, message: '可以抱走这只猫' };
    const problem = conflict(regions, placed, index);
    if (problem) return { status: 'conflict', ok: false, correct: false, message: problem };
    const row = Math.floor(index / n), col = index % n;
    const answer = Array.isArray(solution) && solution.length === n ? solution[row] === col : solve(regions, 1)[0]?.[row] === col;
    return answer
      ? { status: 'correct', ok: true, correct: true, message: '找到猫咪啦！' }
      : { status: 'wrong', ok: false, correct: false, message: '这里没有猫咪，再观察一下其他色块吧' };
  }

  const checkPlacement = evaluatePlacement;

  function createGameState(regions, options = {}) {
    const board = cloneBoard(regions), answer = options.solution || solve(board, 1)[0] || [];
    return {
      regions: board,
      solution: answer.slice(),
      cats: new Set(options.cats || []),
      marks: new Set(options.marks || []),
      lives: Number.isInteger(options.lives) && options.lives >= 0 ? options.lives : 3,
      status: options.status || 'playing',
      feedback: null,
      streak: Number.isInteger(options.streak) && options.streak >= 0 ? options.streak : 0,
      bestStreak: Number.isInteger(options.bestStreak) && options.bestStreak >= 0 ? options.bestStreak : 0
    };
  }

  function updateStreak(current, won) {
    const value = Number.isSafeInteger(current) && current >= 0 ? current : 0;
    return won ? value + 1 : 0;
  }

  function updateBestStreak(best, streak) {
    const previous = Number.isSafeInteger(best) && best >= 0 ? best : 0;
    const value = Number.isSafeInteger(streak) && streak >= 0 ? streak : 0;
    return Math.max(previous, value);
  }

  return {
    DIFFICULTY_SIZES,
    solve,
    conflict,
    excluded,
    complete,
    transform,
    level,
    resolveSize,
    generateLevel,
    randomLevel,
    isConnected,
    isValidBoard,
    evaluatePlacement,
    checkPlacement,
    createGameState,
    updateStreak,
    updateBestStreak
  };
});
