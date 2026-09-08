(() => {
  'use strict';
  const E = CatEngine;
  const $ = selector => document.querySelector(selector);
  const icons = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;
  const STORE = 'little-cat-puzzle-v1';
  const STORE_VERSION = 4;
  const NAMES = { easy: '轻松', medium: '进阶', hard: '挑战' };
  const SIZES = { easy: 5, medium: 7, hard: 10 };
  const COLORS = ['杏橙', '珊瑚', '嫩绿', '鹅黄', '浅紫', '雾蓝', '天蓝', '薄荷', '奶茶', '月白'];
  const defaultSettings = { autoMark: true, colorblind: false, coordinates: false, sound: false };
  let difficulty = 'hard', settings = { ...defaultSettings }, rounds = {}, wins = [], totalWins = 0, streak = 0, bestStreak = 0, state;
  let regions, solution, cats, marks, errors, hint = null, mode = 'mark', paused = false, focusIndex = 0;
  let excludeDrag = null, dragSequence = 0;
  let storageAvailable = true, audioContext, dialogKind = '', messageTimeout, nextRoundWarmup = null;

  function freshRound(number = 1) {
    return { number, cats: [], marks: [], errors: [], lives: 3, seconds: 0, started: false, status: 'playing', hints: 0, history: [] };
  }
  function validRound(value, key) {
    const size = SIZES[key], validIndexes = list => Array.isArray(list) && list.length <= size * size && new Set(list).size === list.length && list.every(i => Number.isInteger(i) && i >= 0 && i < size * size);
    if (!value || !Number.isSafeInteger(value.number) || value.number < 1 || !validIndexes(value.cats) || !validIndexes(value.marks) || !validIndexes(value.errors || []) || !Number.isInteger(value.lives) || value.lives < 0 || value.lives > 3 || !Number.isInteger(value.seconds) || value.seconds < 0 || value.seconds > 31536000 || !['playing', 'won', 'lost'].includes(value.status)) return false;
    const board = E.level(CAT_LEVELS, key, value.number), solution = E.solve(board, 1)[0], placed = new Set(value.cats);
    const isAnswer = i => solution?.[Math.floor(i / size)] === i % size;
    if (value.cats.length > size || value.cats.some(i => !isAnswer(i) || E.conflict(board, placed, i)) || value.marks.some(i => placed.has(i)) || (value.errors || []).some(i => placed.has(i) || isAnswer(i))) return false;
    if ((value.status === 'won') !== E.complete(board, placed) || (value.status === 'lost') !== (value.lives === 0)) return false;
    value.hints = Number.isInteger(value.hints) && value.hints >= 0 ? value.hints : 0;
    value.started = Boolean(value.started);
    value.errors = Array.isArray(value.errors) ? value.errors : [];
    value.history = Array.isArray(value.history) ? value.history.slice(-100).filter(h => h && validIndexes(h.cats) && validIndexes(h.marks) && validIndexes(h.errors || []) && !h.marks.some(i => h.cats.includes(i)) && !(h.errors || []).some(i => h.cats.includes(i) || isAnswer(i)) && h.cats.every(i => isAnswer(i) && !E.conflict(board, new Set(h.cats), i))) : [];
    return true;
  }
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE));
      if (!saved || ![1, 2, 3, STORE_VERSION].includes(saved.version)) return;
      if (Object.hasOwn(SIZES, saved.difficulty)) difficulty = saved.difficulty;
      for (const key of Object.keys(defaultSettings)) if (typeof saved.settings?.[key] === 'boolean') settings[key] = saved.settings[key];
      // Earlier saves used either a 9×9 challenge or the previous 10×10
      // generator. Keep portable settings and completion history, but start
      // the redesigned challenge board from a clean round.
      for (const key of Object.keys(SIZES)) {
        if (saved.version < STORE_VERSION && key === 'hard') continue;
        if (validRound(saved.rounds?.[key], key)) rounds[key] = saved.rounds[key];
      }
      if (Array.isArray(saved.wins)) wins = [...new Set(saved.wins.filter(v => typeof v === 'string' && /^(easy|medium|hard):\d+$/.test(v)))];
      totalWins = Number.isSafeInteger(saved.totalWins) && saved.totalWins >= 0 ? saved.totalWins : wins.length;
      streak = Number.isSafeInteger(saved.streak) && saved.streak >= 0 ? saved.streak : 0;
      bestStreak = Number.isSafeInteger(saved.bestStreak) && saved.bestStreak >= 0 ? Math.max(saved.bestStreak, streak) : streak;
    } catch { storageAvailable = false; }
  }
  function save() {
    if (!state) return;
    state.cats = [...cats]; state.marks = [...marks]; state.errors = [...errors]; rounds[difficulty] = state;
    try {
      localStorage.setItem(STORE, JSON.stringify({ version: STORE_VERSION, difficulty, settings, rounds, wins, totalWins, streak, bestStreak }));
      storageAvailable = true;
    } catch { storageAvailable = false; }
    $('#save-status').innerHTML = storageAvailable ? '<i></i>进度已保存' : '当前浏览器无法存档';
  }
  function formatTime(seconds) {
    const min = Math.floor(seconds / 60), sec = seconds % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  function say(text, type = '') {
    clearTimeout(messageTimeout);
    $('#game-message').textContent = text;
    $('#game-message').className = `game-message ${type}`;
  }
  function tone(kind) {
    if (!settings.sound) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      const notes = kind === 'win' ? [523, 659, 784, 1047] : kind === 'error' ? [220, 185] : [kind === 'mark' ? 390 : 660];
      notes.forEach((frequency, i) => {
        const oscillator = audioContext.createOscillator(), gain = audioContext.createGain(), time = audioContext.currentTime + i * .11;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(.055, time + .012); gain.gain.exponentialRampToValueAtTime(.001, time + .18);
        oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(time); oscillator.stop(time + .2);
      });
    } catch { /* Sound is optional; the puzzle remains playable. */ }
  }
  function enterRound(key = difficulty) {
    finishExcludeDrag(null, { cancel: true, force: true });
    document.querySelectorAll('.confetti').forEach(piece => piece.remove());
    difficulty = key; state = rounds[key] || freshRound(); rounds[key] = state;
    regions = E.level(CAT_LEVELS, key, state.number);
    solution = E.solve(regions, 1)[0];
    cats = new Set(state.cats); marks = new Set(state.marks); errors = new Set(state.errors || []);
    hint = null; paused = false; focusIndex = 0;
    $('#board-overlay').hidden = true; $('#board').inert = false;
    buildBoard(); render(); save();
    const text = state.status === 'won' ? '这一关的小猫全部找到啦！可以开始下一关了。' : state.status === 'lost' ? '这次的机会用完了。再试一次，小猫还在原地。' : state.started ? '欢迎回来，继续刚才的猫咪谜题吧。' : '每个色块都有一只猫。先从范围最小的色块找起吧。';
    say(text);
  }
  function buildBoard() {
    const n = regions.length, board = $('#board'), fragment = document.createDocumentFragment();
    board.style.setProperty('--size', n);
    board.setAttribute('aria-label', `${n}行${n}列找猫棋盘，使用方向键移动，回车或空格操作`);
    board.replaceChildren();
    board.onpointerup = event => finishExcludeDrag(event);
    board.onpointercancel = event => finishExcludeDrag(event, { cancel: true });
    board.onlostpointercapture = event => finishExcludeDrag(event, { cancel: true });
    for (let i = 0; i < n * n; i++) {
      const r = Math.floor(i / n), c = i % n, color = regions[r][c], cell = document.createElement('button');
      cell.className = 'cell'; cell.dataset.index = i; cell.dataset.coordinate = `${r + 1},${c + 1}`;
      cell.style.setProperty('--cell-color', `var(--r${color})`);
      cell.tabIndex = i === focusIndex ? 0 : -1;
      cell.addEventListener('pointerdown', event => {
        cell.dataset.pointerButton = String(event.button); cell.dataset.pointerType = event.pointerType || '';
        if (event.pointerType === 'mouse' && event.button === 0 && state.status === 'playing' && !paused && !$('#game-dialog').open) {
          event.preventDefault();
          finishExcludeDrag(null, { cancel: true, force: true });
          const initialMarked = marks.has(i), dragToken = String(++dragSequence);
          excludeDrag = { pointerId: event.pointerId, token: dragToken, startIndex: i, startCell: cell, initialMarked, moved: false, changed: false, checkpointed: false, visited: new Set([i]), touched: new Set([cell]) };
          $('#board').classList.add('dragging');
          cell.classList.add('drag-target');
          cell.dataset.skipClick = dragToken;
          cell.dataset.dragToken = dragToken;
          try { cell.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional in older browsers. */ }
          if (!initialMarked) { excludeDrag.visited.delete(i); markForDrag(cell); }
        }
      });
      cell.addEventListener('pointerenter', continueExcludeDrag);
      cell.addEventListener('pointermove', continueExcludeDrag, { passive: false });
      cell.addEventListener('pointerup', event => finishExcludeDrag(event));
      cell.addEventListener('pointercancel', event => finishExcludeDrag(event, { cancel: true }));
      cell.addEventListener('lostpointercapture', event => finishExcludeDrag(event, { cancel: true }));
      cell.addEventListener('click', () => {
        if (cell.dataset.skipClick) {
          delete cell.dataset.skipClick;
          delete cell.dataset.dragToken;
          delete cell.dataset.pointerButton;
          delete cell.dataset.pointerType;
          return;
        }
        const pointerButton = cell.dataset.pointerButton;
        const pointerType = cell.dataset.pointerType;
        delete cell.dataset.pointerButton;
        delete cell.dataset.pointerType;
        // A physical mouse left click always excludes; touch and keyboard follow the selected tool.
        if (pointerType === 'mouse' && pointerButton === '2') return;
        interact(i, pointerType === 'mouse' && pointerButton === '0' ? 'mark' : mode);
      });
      cell.addEventListener('contextmenu', event => {
        event.preventDefault();
        finishExcludeDrag(event, { cancel: true, force: true });
        interact(i, 'cat');
        delete cell.dataset.pointerButton; delete cell.dataset.pointerType;
      });
      cell.addEventListener('focus', () => { focusIndex = i; updateTabStops(); });
      cell.addEventListener('keydown', event => {
        const movement = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key];
        if (!movement) return;
        event.preventDefault();
        const nr = Math.min(n - 1, Math.max(0, r + movement[0])), nc = Math.min(n - 1, Math.max(0, c + movement[1]));
        board.children[nr * n + nc].focus();
      });
      fragment.append(cell);
    }
    board.append(fragment);
  }
  function updateTabStops() { [...$('#board').children].forEach((cell, i) => { cell.tabIndex = focusIndex === i ? 0 : -1; }); }
  function cellAtPoint(event) {
    const board = $('#board'), node = document.elementFromPoint(event.clientX, event.clientY);
    const cell = node?.closest?.('.cell');
    return cell && board?.contains(cell) ? cell : null;
  }
  function clearDragVisuals(drag) {
    const board = $('#board'), cells = new Set(drag?.touched || []);
    if (board) {
      board.classList.remove('dragging');
      board.querySelectorAll('.drag-target,.drag-excluded').forEach(cell => cells.add(cell));
    }
    cells.forEach(cell => {
      cell.classList.remove('drag-target');
      if (cell.classList.contains('drag-excluded')) {
        setTimeout(() => cell.classList.remove('drag-excluded'), 280);
      }
    });
  }
  function markForDrag(cell) {
    const drag = excludeDrag;
    if (!drag || !cell) return false;
    const index = Number(cell.dataset.index);
    if (!Number.isInteger(index) || drag.visited.has(index)) return false;
    drag.visited.add(index); drag.touched.add(cell);
    if (state.status !== 'playing' || paused || $('#game-dialog').open || cats.has(index)) { cell.classList.remove('drag-target'); return false; }
    if (settings.autoMark && E.excluded(regions, cats).has(index) && !marks.has(index) && !errors.has(index)) { cell.classList.remove('drag-target'); return false; }
    cell.classList.add('drag-target');
    if (marks.has(index)) return false;
    if (!drag.checkpointed) { checkpoint(); drag.checkpointed = true; }
    state.started = true; clearHint(); errors.delete(index); marks.add(index); drag.changed = true;
    cell.classList.remove('drag-excluded'); void cell.offsetWidth; cell.classList.add('drag-excluded');
    render();
    return true;
  }
  function continueExcludeDrag(event) {
    const drag = excludeDrag;
    if (!drag || event.pointerId !== drag.pointerId || (event.pointerType && event.pointerType !== 'mouse')) return;
    if (!(event.buttons & 1)) { finishExcludeDrag(event); return; }
    event.preventDefault();
    const cell = cellAtPoint(event) || (event.currentTarget?.matches?.('.cell') ? event.currentTarget : null);
    if (!cell) return;
    if (Number(cell.dataset.index) !== drag.startIndex) drag.moved = true;
    markForDrag(cell);
  }
  function finishExcludeDrag(event, { cancel = false, force = false } = {}) {
    const drag = excludeDrag;
    if (!drag) return;
    if (!force && event?.pointerId != null && event.pointerId !== drag.pointerId) return;
    excludeDrag = null;
    const source = drag.startCell;
    if (source?.hasPointerCapture?.(drag.pointerId)) {
      try { source.releasePointerCapture(drag.pointerId); } catch { /* Capture may already be released. */ }
    }
    clearDragVisuals(drag);
    if (!cancel && !drag.changed && !drag.moved && drag.initialMarked && state.status === 'playing' && !paused && !$('#game-dialog').open) {
      interact(drag.startIndex, 'mark');
    } else if (!cancel && !drag.changed && !drag.moved && !drag.initialMarked && state.status === 'playing' && !paused && !$('#game-dialog').open) {
      // Preserve the normal feedback for a click on a cat or an automatic mark.
      interact(drag.startIndex, 'mark');
    } else if (drag.changed) {
      tone('mark'); say('已排除拖动经过的格子。白色粗叉是你的排除笔记。'); render(); save();
    }
    if (source) {
      // Keep the guard through the browser's synthesized click.  A pointerup
      // can be followed by click even when pointerdown was prevented; clearing
      // it here would make a simple left click toggle the mark twice.  The
      // click handler normally consumes the flag, while this fallback cleans
      // it up if the browser suppresses click entirely.
      const dragToken = drag.token;
      setTimeout(() => {
        if (source.dataset.skipClick === dragToken && source.dataset.dragToken === dragToken) {
          delete source.dataset.skipClick;
          delete source.dataset.dragToken;
          delete source.dataset.pointerButton;
          delete source.dataset.pointerType;
        }
      }, 0);
    }
  }
  function render() {
    const n = regions.length, blocked = settings.autoMark ? E.excluded(regions, cats) : new Set();
    $('#board').classList.toggle('colorblind', settings.colorblind);
    $('#board').classList.toggle('coordinates', settings.coordinates);
    [...$('#board').children].forEach((cell, i) => {
      const r = Math.floor(i / n), c = i % n, color = regions[r][c], cat = cats.has(i), marked = marks.has(i), wrong = errors.has(i), automatic = blocked.has(i);
      cell.classList.toggle('has-cat', cat);
      cell.classList.toggle('wrong-cell', wrong);
      cell.classList.toggle('error-cell', wrong);
      cell.classList.toggle('auto-mark', automatic && !marked);
      cell.classList.toggle('hint-cell', hint?.index === i);
      cell.disabled = state.status !== 'playing';
      const label = `<span class="cell-label">${String.fromCharCode(65 + color)}</span>`;
      const content = cat ? icons('cat-face', 'cat correct-cat') : wrong ? icons('i-close', 'icon cross error-cross') : marked || automatic ? icons('i-close', 'icon cross') : '';
      const signature = `${cat}-${wrong}-${marked}-${automatic}-${color}`;
      if (cell.dataset.signature !== signature) { cell.innerHTML = content + label; cell.dataset.signature = signature; }
      cell.setAttribute('aria-label', `第${r + 1}行，第${c + 1}列，${COLORS[color]}色块${String.fromCharCode(65 + color)}，${cat ? '已找到猫咪' : wrong ? '错误位置，红色叉号' : marked ? '已手动排除' : automatic ? '已自动排除' : '空格'}`);
      cell.setAttribute('aria-pressed', String(cat));
    });
    $('#difficulty-label').textContent = NAMES[difficulty];
    $('#level-number').textContent = String(state.number).padStart(3, '0');
    $('#lives').innerHTML = Array.from({ length: 3 }, (_, i) => icons('i-heart', `icon ${i >= state.lives ? 'empty' : ''}`)).join('');
    $('#lives').setAttribute('aria-label', `剩余${state.lives}次机会`);
    $('#timer').textContent = formatTime(state.seconds);
    $('#found-count').textContent = cats.size;
    $('#target-count').textContent = n;
    $('#total-wins').textContent = totalWins;
    const streakValue = $('#streak-count'); if (streakValue) streakValue.textContent = streak;
    const bestValue = $('#best-streak-value') || $('#best-streak'); if (bestValue) bestValue.textContent = bestStreak;
    document.querySelectorAll('[data-main-setting]').forEach(input => { input.checked = Boolean(settings[input.dataset.mainSetting]); });
    $('#progress-dots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < cats.size ? 'filled' : ''}"></i>`).join('');
    $('#undo-button').disabled = !state.history.length || state.status !== 'playing';
    $('#pause-button').disabled = state.status !== 'playing';
    $('#hint-button').innerHTML = state.status === 'won' ? `${icons('i-arrow')}下一关` : state.status === 'lost' ? `${icons('i-reset')}再试一次` : hint ? `${icons('i-check')}${hint.remove ? '移走它' : '放这里'}` : `${icons('i-bulb')}提示`;
    document.querySelectorAll('[data-difficulty]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.difficulty === difficulty)));
  }
  function checkpoint() {
    state.history.push({ cats: [...cats], marks: [...marks], errors: [...errors] });
    if (state.history.length > 100) state.history.shift();
  }
  function clearHint() { hint = null; }
  function interact(index, tool) {
    if (paused || state.status !== 'playing' || $('#game-dialog').open) return;
    state.started = true; clearHint();
    if (tool === 'cat') {
      if (cats.has(index)) {
        checkpoint(); cats.delete(index); say('猫咪先抱走，换个位置再试试。');
      } else {
        const row = Math.floor(index / regions.length), expected = solution?.[row];
        const problem = E.conflict(regions, cats, index);
        if (index % regions.length !== expected || problem) {
          checkpoint();
          state.lives = Math.max(0, state.lives - 1);
          errors.add(index); marks.delete(index); tone('error');
          const reason = problem || '这里没有猫咪';
          say(`${reason}，红色叉号表示错误位置。还有 ${state.lives} 次机会。`, 'error');
          if (state.lives === 0) { state.status = 'lost'; streak = 0; }
          render();
          const cell = $('#board').children[index];
          if (cell) { cell.classList.remove('error-cell'); void cell.offsetWidth; cell.classList.add('error-cell'); }
          save();
          if (state.status === 'lost') showResult();
          return;
        }
        checkpoint(); marks.delete(index); errors.delete(index); cats.add(index); tone('cat');
        say(settings.autoMark ? '找对啦！猫头出现了，同一行、列、色块和相邻格已自动排除。' : '找对啦，猫咪出现了。再观察一下其他色块吧。');
      }
    } else {
      if (cats.has(index)) { say('切换到「放猫」，再点一次就能抱走这只猫。'); render(); return; }
      if (settings.autoMark && E.excluded(regions, cats).has(index) && !marks.has(index) && !errors.has(index)) { say('这个格子已自动排除；抱走对应的猫咪后会自动恢复。'); render(); return; }
      checkpoint();
      errors.delete(index);
      if (marks.has(index)) marks.delete(index); else marks.add(index);
      tone('mark'); say('已排除这个格子。白色粗叉是你的排除笔记，再点一次可以取消。');
    }
    checkWin(); render(); save();
    if (state.status === 'won') showResult();
  }
  function checkWin() {
    if (!E.complete(regions, cats)) return;
    state.status = 'won';
    const key = `${difficulty}:${state.number}`;
    if (!wins.includes(key)) { wins.push(key); totalWins++; }
    streak++; bestStreak = Math.max(bestStreak, streak);
    say(`每只小猫都有了自己的位置。恭喜通关！当前连胜 ${streak}！`);
    tone('win'); celebrate();
    const streakCard = document.querySelector('.streak-card');
    if (streakCard) { streakCard.classList.remove('streak-pop'); void streakCard.offsetWidth; streakCard.classList.add('streak-pop'); }
  }
  function setMode(next) {
    mode = next;
    for (const tool of ['cat', 'mark']) {
      $(`#${tool}-tool`).classList.toggle('selected', mode === tool);
      $(`#${tool}-tool`).setAttribute('aria-pressed', String(mode === tool));
    }
    say(mode === 'cat' ? '放猫模式：触屏或键盘点格子放猫；鼠标右键也可直接放猫。' : '排除模式：触屏或键盘点格子排除；鼠标左键可点击或拖动连续排除。');
  }
  function undo() {
    if (paused || state.status !== 'playing' || !state.history.length) return;
    const previous = state.history.pop(); cats = new Set(previous.cats); marks = new Set(previous.marks); errors = new Set(previous.errors || []); clearHint();
    render(); save(); say('已撤销上一步。已消耗的机会不会恢复。');
  }
  function offerHint() {
    if (paused) return;
    if (state.status === 'won') { nextRound(); return; }
    if (state.status === 'lost') { restart(); return; }
    if (hint) {
      checkpoint(); state.started = true; state.hints++;
      if (hint.remove) cats.delete(hint.index); else { marks.delete(hint.index); errors.delete(hint.index); cats.add(hint.index); }
      clearHint(); checkWin(); render(); save();
      if (state.status === 'won') showResult(); else say('提示已应用。接下来交给你啦。');
      return;
    }
    const n = regions.length;
    const wrong = [...cats].find(i => solution[Math.floor(i / n)] !== i % n);
    if (wrong !== undefined) {
      hint = { index: wrong, remove: true };
      say(`第 ${Math.floor(wrong / n) + 1} 行、第 ${wrong % n + 1} 列的猫会使后续无解。点「移走它」调整，不扣机会。`, 'hint');
      render(); return;
    }
    const blocked = E.excluded(regions, cats);
    let best = null;
    for (let r = 0; r < n; r++) {
      const c = solution[r], index = r * n + c;
      if (cats.has(index)) continue;
      const color = regions[r][c], candidates = [];
      for (let j = 0; j < n * n; j++) if (!blocked.has(j) && !cats.has(j)) candidates.push(j);
      const colorCount = candidates.filter(i => regions[Math.floor(i / n)][i % n] === color).length;
      const rowCount = candidates.filter(i => Math.floor(i / n) === r).length;
      const colCount = candidates.filter(i => i % n === c).length;
      const score = Math.min(colorCount, rowCount, colCount);
      const reason = colorCount === 1 ? `${COLORS[color]}色块只剩这一个可用位置` : rowCount === 1 ? `这一行只剩这一个可用位置` : colCount === 1 ? `这一列只剩这一个可用位置` : '综合行、列、色块和相邻限制，这里是解中的正确位置';
      if (!best || score < best.score) best = { index, score, reason };
    }
    if (best) {
      hint = { index: best.index, remove: false };
      say(`第 ${Math.floor(best.index / n) + 1} 行、第 ${best.index % n + 1} 列：${best.reason}。点「放这里」安置。`, 'hint');
      render();
    }
  }
  function openDialog(kind, content) {
    dialogKind = kind;
    $('#dialog-content').innerHTML = content;
    if (!$('#game-dialog').open) $('#game-dialog').showModal();
    updatePauseLabel();
  }
  function closeDialog() {
    const dialog = $('#game-dialog');
    if (dialog.open) dialog.close();
    dialogKind = ''; updatePauseLabel();
  }
  function showResult() {
    const won = state.status === 'won';
    openDialog('result', `<div class="result-content">${icons('cat-face', 'dialog-cat')}<div class="dialog-eyebrow">${won ? 'ALL CATS, ALL HAPPY' : 'TAKE A LITTLE BREATH'}</div><h2 id="dialog-title">${won ? '小猫都找到啦！' : '再给自己一次机会'}</h2><p>${won ? '每一只都在对的位置。<br>下一场小小的挑战，准备好了吗？' : '这次的机会用完了，但思路已经更清楚了。<br>重新开始，或试试用提示找到突破口。'}</p><div class="result-stats"><div><b>${formatTime(state.seconds)}</b><span>本关用时</span></div><div><b>${state.hints}</b><span>使用提示</span></div><div><b>${cats.size} / ${regions.length}</b><span>找到小猫</span></div><div><b>${won ? streak : bestStreak}</b><span>${won ? '当前连胜' : '历史最高连胜'}</span></div></div><button class="primary-button" id="result-action">${won ? '继续，下一关' : '重新挑战'}${icons('i-arrow')}</button></div>`);
    $('#result-action').onclick = () => { won ? nextRound() : restart(); };
    if (won) warmNextRound();
  }
  function warmNextRound() {
    if (nextRoundWarmup != null) {
      if ('cancelIdleCallback' in window) window.cancelIdleCallback(nextRoundWarmup);
      else clearTimeout(nextRoundWarmup);
    }
    const key = difficulty, number = state.number + 1;
    const generate = () => {
      nextRoundWarmup = null;
      if (difficulty !== key || state.status !== 'won') return;
      try { E.level(CAT_LEVELS, key, number); } catch { /* enterRound retries if generation previously failed. */ }
    };
    nextRoundWarmup = 'requestIdleCallback' in window
      ? window.requestIdleCallback(generate, { timeout: 900 })
      : setTimeout(generate, 60);
  }
  function nextRound() {
    rounds[difficulty] = freshRound(state.number + 1);
    enterRound();
    closeDialog();
  }
  function restart() {
    rounds[difficulty] = freshRound(state.number);
    enterRound();
    closeDialog();
    say('重新开始了。机会已恢复，小猫的位置没有变化。');
  }
  function requestReset() {
    if (!state.started && !marks.size && !cats.size && !errors.size) { say('棋盘还是空的，直接开始就好。'); return; }
    openDialog('reset', `<div class="dialog-eyebrow">A FRESH START</div><h2 id="dialog-title">重新找一遍？</h2><p>本关的猫咪、排除标记和计时会清空，恢复 3 次机会。已经完成的关卡记录会保留。</p><div class="dialog-actions"><button class="secondary-button" id="reset-cancel">继续这局</button><button class="primary-button" id="reset-confirm">重新开始</button></div>`);
    $('#reset-cancel').onclick = closeDialog; $('#reset-confirm').onclick = restart;
  }
  function showHelp() {
    openDialog('help', `<div class="dialog-eyebrow">HOW TO PLAY</div><h2 id="dialog-title">给每只猫找个位置</h2><ol class="help-list"><li>每个颜色的区域恰好放 <b>1 只猫</b>。</li><li>每一行、每一列也都恰好放 <b>1 只猫</b>。</li><li>猫咪不能相邻，<b>斜角也算</b>。</li></ol><p>只有找对解答中的位置才会出现猫头；点错会显示红色叉并扣一次机会。</p><div class="help-controls"><b>鼠标</b>：左键点击排除，按住左键拖动可连续排除，右键放猫。<b>触屏／键盘</b>：选择下方工具后点格子，或用 <kbd>C</kbd>／<kbd>X</kbd> 切换。方向键移动，空格／回车操作，<kbd>Ctrl+Z</kbd> 撤销，<kbd>P</kbd> 暂停。<br><b>卡住了？</b> 提示会先指出一个位置和原因，再点一次才应用。提示不限次数。撤销不会返还机会。</div><p class="dialog-caption">三种难度会持续随机生成新棋盘，进度和最高连胜只保存在当前浏览器中；离线使用无需账号。</p><div class="dialog-actions"><button class="primary-button" id="help-done">知道了，去找猫</button></div>`);
    $('#help-done').onclick = closeDialog;
  }
  function showSettings() {
    const rows = [ ['autoMark', '自动排除', '放猫后标出同行、同列、同色块和相邻格'], ['colorblind', '色盲辅助', '用 A–J 字母区分不同颜色的区域'], ['coordinates', '显示坐标', '在格子右下角显示行、列坐标'], ['sound', '轻柔音效', '放猫、排除和完成时播放提示音'] ];
    openDialog('settings', `<div class="dialog-eyebrow">MAKE YOURSELF AT HOME</div><h2 id="dialog-title">按你喜欢的方式玩</h2>${rows.map(([key, label, desc]) => `<label class="settings-row"><span>${label}<small>${desc}</small></span><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''} aria-label="${label}"></label>`).join('')}<p class="dialog-caption">${storageAvailable ? '设置和三个难度的进度会分别自动保存。' : '当前浏览器不允许本地存储，关闭页面后进度会丢失。'}</p><div class="dialog-actions"><button class="primary-button" id="settings-done">继续游戏</button></div>`);
    document.querySelectorAll('[data-setting]').forEach(input => input.addEventListener('change', () => applySetting(input.dataset.setting, input.checked)));
    $('#settings-done').onclick = closeDialog;
  }
  function applySetting(key, value) {
    if (!(key in settings)) return;
    settings[key] = Boolean(value);
    document.querySelectorAll(`[data-setting="${key}"],[data-main-setting="${key}"]`).forEach(input => { input.checked = settings[key]; });
    render(); save();
    if (key === 'sound' && settings.sound) tone('cat');
  }
  function celebrate() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (let i = 0; i < 24; i++) {
      const piece = document.createElement('i'); piece.className = 'confetti';
      piece.style.left = `${15 + Math.random() * 70}%`;
      piece.style.background = `var(--r${i % 10})`;
      piece.style.animationDelay = `${Math.random() * .6}s`;
      piece.style.transform = `rotate(${Math.random() * 180}deg)`;
      document.body.append(piece); setTimeout(() => piece.remove(), 3600);
    }
  }
  function updatePauseLabel() { $('#pause-label').hidden = !(paused || $('#game-dialog').open); $('#pause-button').setAttribute('aria-label', paused ? '继续游戏（P）' : '暂停游戏（P）'); }
  function togglePause() {
    if (state.status !== 'playing') return;
    paused = !paused; $('#board-overlay').hidden = !paused; updatePauseLabel();
    $('#board').inert = paused;
    if (paused) $('#resume-button').focus(); else $('#board').children[focusIndex].focus();
  }
  $('#cat-tool').onclick = () => setMode('cat'); $('#mark-tool').onclick = () => setMode('mark');
  $('#undo-button').onclick = undo; $('#reset-button').onclick = requestReset; $('#hint-button').onclick = offerHint;
  $('#help-button').onclick = showHelp; $('#settings-button').onclick = showSettings;
  $('#dialog-close').onclick = closeDialog; $('#resume-button').onclick = togglePause;
  $('#pause-button').onclick = togglePause;
  $('#game-dialog').addEventListener('click', event => { if (event.target === $('#game-dialog')) { const rect = $('#game-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });
  $('#game-dialog').addEventListener('close', () => { dialogKind = ''; updatePauseLabel(); });
  document.querySelectorAll('[data-difficulty]').forEach(button => button.onclick = () => { const next = button.dataset.difficulty; if (next !== difficulty) { save(); enterRound(next); $('#board').inert = false; } });
  document.querySelectorAll('[data-main-setting]').forEach(input => input.addEventListener('change', () => applySetting(input.dataset.mainSetting, input.checked)));
  document.addEventListener('pointermove', continueExcludeDrag, { passive: false });
  document.addEventListener('pointerup', event => finishExcludeDrag(event), true);
  document.addEventListener('pointercancel', event => finishExcludeDrag(event, { cancel: true }), true);
  document.addEventListener('lostpointercapture', event => finishExcludeDrag(event, { cancel: true }), true);
  window.addEventListener('blur', () => finishExcludeDrag(null, { cancel: true, force: true }));
  document.addEventListener('keydown', event => {
    if ($('#game-dialog').open || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
    else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key.toLowerCase() === 'c') setMode('cat');
      if (event.key.toLowerCase() === 'x') setMode('mark');
      if (event.key.toLowerCase() === 'p') { event.preventDefault(); togglePause(); }
    }
  });
  load(); enterRound();
  setInterval(() => {
    if (state.started && state.status === 'playing' && !paused && !document.hidden && !$('#game-dialog').open) {
      state.seconds++; $('#timer').textContent = formatTime(state.seconds);
      if (state.seconds % 5 === 0) save();
    }
  }, 1000);
  document.addEventListener('visibilitychange', save);
  window.addEventListener('pagehide', save);
})();
