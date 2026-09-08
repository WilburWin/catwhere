(() => {
  'use strict';
  const E = CatEngine;
  const $ = selector => document.querySelector(selector);
  const icons = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#${name}"/></svg>`;
  const STORE = 'little-cat-puzzle-v1';
  const STORE_VERSION = 5;
  const TAP_WINDOW = 300;
  const NAMES = { easy: '轻松', medium: '进阶', hard: '挑战' };
  const SIZES = { easy: 5, medium: 7, hard: 10 };
  const COLORS = ['杏橙', '珊瑚', '嫩绿', '鹅黄', '浅紫', '雾蓝', '天蓝', '薄荷', '奶茶', '月白'];
  const defaultSettings = { colorblind: false, coordinates: false };
  let difficulty = 'hard', settings = { ...defaultSettings }, rounds = {}, wins = [], totalWins = 0, streak = 0, bestStreak = 0, state;
  let regions, solution, cats, marks, errors, hint = null, paused = false, focusIndex = 0;
  let excludeDrag = null, dragSequence = 0, pendingTap = null;
  let storageAvailable = true, audioContext, dialogKind = '', messageTimeout, celebrationTimeout, nextRoundWarmup = null, preparedRound = null;

  function randomSeed() {
    const values = new Uint32Array(4);
    if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(values);
    else for (let i = 0; i < values.length; i++) values[i] = Math.floor(Math.random() * 0x100000000);
    return [...values].map(value => value.toString(36)).join('-');
  }
  function freshRound(number = 1, seed = randomSeed()) {
    return { number, seed, cats: [], marks: [], errors: [], lives: 3, seconds: 0, started: false, status: 'playing', hints: 0, history: [] };
  }
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE));
      if (!saved || !Number.isInteger(saved.version) || saved.version < 1 || saved.version > STORE_VERSION) return;
      if (Object.hasOwn(SIZES, saved.difficulty)) difficulty = saved.difficulty;
      for (const key of Object.keys(defaultSettings)) if (typeof saved.settings?.[key] === 'boolean') settings[key] = saved.settings[key];
      if (Array.isArray(saved.wins)) wins = [...new Set(saved.wins.filter(v => typeof v === 'string'))].slice(-1000);
      totalWins = Number.isSafeInteger(saved.totalWins) && saved.totalWins >= 0 ? saved.totalWins : wins.length;
      streak = Number.isSafeInteger(saved.streak) && saved.streak >= 0 ? saved.streak : 0;
      bestStreak = Number.isSafeInteger(saved.bestStreak) && saved.bestStreak >= 0 ? Math.max(saved.bestStreak, streak) : streak;
    } catch { storageAvailable = false; }
  }
  function save() {
    if (!state) return;
    state.cats = [...cats]; state.marks = [...marks]; state.errors = [...errors]; rounds[difficulty] = state;
    try {
      localStorage.setItem(STORE, JSON.stringify({ version: STORE_VERSION, difficulty, settings, wins, totalWins, streak, bestStreak }));
      storageAvailable = true;
    } catch { storageAvailable = false; }
    setCachedHTML($('#save-status'), String(storageAvailable), storageAvailable ? '<i></i>记录已保存' : '当前浏览器无法保存记录');
  }
  function formatTime(seconds) {
    const min = Math.floor(seconds / 60), sec = seconds % 60;
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  function setCachedHTML(element, signature, html) {
    if (!element || element.dataset.renderSignature === signature) return;
    element.innerHTML = html;
    element.dataset.renderSignature = signature;
  }
  function say(text, type = '') {
    clearTimeout(messageTimeout);
    $('#game-message').textContent = text;
    $('#game-message').className = `game-message ${type}`;
  }
  function tone(kind) {
    if (kind === 'cat') {
      const sound = $('#cat-sound');
      if (!sound) return;
      sound.pause(); sound.currentTime = 0; sound.volume = .7;
      sound.play().catch(() => {});
      return;
    }
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      const notes = kind === 'error' ? [220, 185] : [520, 780];
      notes.forEach((frequency, i) => {
        const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
        const time = audioContext.currentTime + (kind === 'error' ? i * .11 : i * .018);
        oscillator.type = kind === 'error' ? 'sine' : (i ? 'triangle' : 'sine');
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(kind === 'error' ? .055 : .026, time + .008);
        gain.gain.exponentialRampToValueAtTime(.001, time + (kind === 'error' ? .18 : .09));
        oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(time); oscillator.stop(time + (kind === 'error' ? .2 : .1));
      });
    } catch { /* Sound is optional; the puzzle remains playable. */ }
  }
  function enterRound(key = difficulty) {
    finishExcludeDrag(null, { cancel: true, force: true });
    clearTimeout(celebrationTimeout);
    $('#celebration-layer')?.replaceChildren();
    difficulty = key; state = rounds[key] || freshRound(); rounds[key] = state;
    regions = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { regions = E.generateLevel(SIZES[key], state.seed); break; }
      catch { state.seed = randomSeed(); }
    }
    if (!regions) throw new Error('暂时无法生成随机棋盘，请刷新后重试');
    solution = E.solve(regions, 1)[0];
    cats = new Set(state.cats); marks = new Set(state.marks); errors = new Set(state.errors || []);
    hint = null; paused = false; focusIndex = 0;
    document.querySelector('.streak-card')?.classList.remove('streak-pop');
    $('#board-overlay').hidden = true; $('#board').inert = false;
    buildBoard(); render(); save();
    const text = state.status === 'won' ? '这一关的小猫全部找到啦！可以开始下一关了。' : state.status === 'lost' ? '这次的机会用完了。再试一次，小猫还在原地。' : state.started ? '欢迎回来，继续刚才的猫咪谜题吧。' : '每个色块都有一只猫。先从范围最小的色块找起吧。';
    say(text);
  }
  function buildBoard() {
    const n = regions.length, board = $('#board'), fragment = document.createDocumentFragment();
    cancelPendingTap();
    board.style.setProperty('--size', n);
    board.setAttribute('aria-label', `${n}行${n}列找猫棋盘：单击排除，双击放猫，拖动连续排除`);
    board.replaceChildren();
    for (let i = 0; i < n * n; i++) {
      const r = Math.floor(i / n), c = i % n, color = regions[r][c], cell = document.createElement('button');
      cell.className = 'cell'; cell.dataset.index = i; cell.dataset.coordinate = `${r + 1},${c + 1}`;
      cell.style.setProperty('--cell-color', `var(--r${color})`);
      cell.style.setProperty('--cat-delay', `${(i % 7) * -.31}s`);
      cell.tabIndex = i === focusIndex ? 0 : -1;
      cell.addEventListener('pointerdown', event => {
        if (event.button !== 0 || state.status !== 'playing' || paused || $('#game-dialog').open) return;
        event.preventDefault();
        finishExcludeDrag(null, { cancel: true, force: true });
        const dragToken = String(++dragSequence);
        excludeDrag = {
          pointerId: event.pointerId, pointerType: event.pointerType || 'mouse', token: dragToken,
          startIndex: i, startCell: cell, startX: event.clientX, startY: event.clientY,
          moved: false, changed: false, checkpointed: false, visited: new Set(), touched: new Set([cell]),
          blocked: E.excluded(regions, cats), currentCell: cell
        };
        cell.classList.add('drag-target');
        try { cell.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional in older browsers. */ }
      });
      cell.addEventListener('contextmenu', event => {
        event.preventDefault();
        if (pendingTap?.index === i) cancelPendingTap();
        else cancelPendingTap(true);
        finishExcludeDrag(event, { cancel: true, force: true });
        interact(i, 'cat');
      });
      cell.addEventListener('focus', () => { focusIndex = i; updateTabStops(); });
      cell.addEventListener('keydown', event => {
        const movement = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key];
        if (movement) {
          event.preventDefault();
          const nr = Math.min(n - 1, Math.max(0, r + movement[0])), nc = Math.min(n - 1, Math.max(0, c + movement[1]));
          board.children[nr * n + nc].focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); interact(i, 'mark');
        }
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
  function cancelPendingTap(apply = false) {
    if (!pendingTap) return;
    clearTimeout(pendingTap.timer);
    const index = pendingTap.index; pendingTap = null;
    if (apply) interact(index, 'mark');
  }
  function queueTap(index) {
    const now = performance.now();
    if (pendingTap && pendingTap.index === index && now - pendingTap.time <= TAP_WINDOW) {
      cancelPendingTap(); interact(index, 'cat'); return;
    }
    if (pendingTap) cancelPendingTap(true);
    const tap = { index, time: now, timer: 0 };
    tap.timer = setTimeout(() => {
      if (pendingTap !== tap) return;
      pendingTap = null; interact(index, 'mark');
    }, TAP_WINDOW);
    pendingTap = tap;
  }
  function clearDragVisuals(drag) {
    $('#board')?.classList.remove('dragging');
    (drag?.touched || []).forEach(cell => {
      cell.classList.remove('drag-target');
      if (cell.classList.contains('drag-excluded')) setTimeout(() => cell.classList.remove('drag-excluded'), 220);
    });
  }
  function markForDrag(cell) {
    const drag = excludeDrag;
    if (!drag || !cell) return false;
    const index = Number(cell.dataset.index);
    if (!Number.isInteger(index) || drag.visited.has(index)) return false;
    drag.visited.add(index); drag.touched.add(cell);
    drag.currentCell?.classList.remove('drag-target'); drag.currentCell = cell; cell.classList.add('drag-target');
    if (state.status !== 'playing' || paused || $('#game-dialog').open || cats.has(index) || drag.blocked.has(index) || marks.has(index)) return false;
    if (!drag.checkpointed) { checkpoint(); drag.checkpointed = true; }
    state.started = true; clearHint(); errors.delete(index); marks.add(index); drag.changed = true;
    cell.classList.add('drag-excluded');
    renderCell(cell, index, drag.blocked); tone('mark');
    return true;
  }
  function continueExcludeDrag(event) {
    const drag = excludeDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.pointerType === 'mouse' && !(event.buttons & 1)) { finishExcludeDrag(event); return; }
    const cell = cellAtPoint(event);
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.moved && (distance >= 7 || (cell && Number(cell.dataset.index) !== drag.startIndex))) {
      drag.moved = true; cancelPendingTap(true); $('#board').classList.add('dragging');
      markForDrag(drag.startCell);
    }
    if (!drag.moved) return;
    event.preventDefault();
    if (cell) markForDrag(cell);
  }
  function finishExcludeDrag(event, { cancel = false, force = false } = {}) {
    const drag = excludeDrag;
    if (!drag) return;
    if (!force && event?.pointerId != null && event.pointerId !== drag.pointerId) return;
    excludeDrag = null;
    if (drag.startCell?.hasPointerCapture?.(drag.pointerId)) {
      try { drag.startCell.releasePointerCapture(drag.pointerId); } catch { /* Capture may already be released. */ }
    }
    clearDragVisuals(drag);
    if (cancel) {
      if (drag.changed) { render(); save(); }
      return;
    }
    if (drag.moved) {
      if (drag.changed) { say('已连续排除经过的格子。'); render(); save(); }
    } else {
      queueTap(drag.startIndex);
    }
  }
  function renderCell(cell, i, blocked) {
    const n = regions.length, r = Math.floor(i / n), c = i % n, color = regions[r][c];
    const cat = cats.has(i), marked = marks.has(i), wrong = errors.has(i), automatic = blocked.has(i);
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
  }
  function render() {
    const n = regions.length, blocked = E.excluded(regions, cats);
    $('#board').classList.toggle('colorblind', settings.colorblind);
    $('#board').classList.toggle('coordinates', settings.coordinates);
    [...$('#board').children].forEach((cell, i) => renderCell(cell, i, blocked));
    $('#difficulty-label').textContent = NAMES[difficulty];
    $('#level-number').textContent = String(state.number).padStart(3, '0');
    setCachedHTML($('#lives'), String(state.lives), Array.from({ length: 3 }, (_, i) => icons('i-heart', `icon ${i >= state.lives ? 'empty' : ''}`)).join(''));
    $('#lives').setAttribute('aria-label', `剩余${state.lives}次机会`);
    $('#timer').textContent = formatTime(state.seconds);
    $('#found-count').textContent = cats.size;
    $('#target-count').textContent = n;
    $('#total-wins').textContent = totalWins;
    const streakValue = $('#streak-count'); if (streakValue) streakValue.textContent = streak;
    const bestValue = $('#best-streak-value') || $('#best-streak'); if (bestValue) bestValue.textContent = bestStreak;
    document.querySelectorAll('[data-main-setting]').forEach(input => { input.checked = Boolean(settings[input.dataset.mainSetting]); });
    setCachedHTML($('#progress-dots'), `${n}:${cats.size}`, Array.from({ length: n }, (_, i) => `<i class="${i < cats.size ? 'filled' : ''}"></i>`).join(''));
    $('#undo-button').disabled = !state.history.length || state.status !== 'playing';
    $('#pause-button').disabled = state.status !== 'playing';
    const hintSignature = state.status === 'playing' ? (hint ? `hint:${hint.remove}` : 'hint:none') : state.status;
    setCachedHTML($('#hint-button'), hintSignature, state.status === 'won' ? `${icons('i-arrow')}下一关` : state.status === 'lost' ? `${icons('i-reset')}再试一次` : hint ? `${icons('i-check')}${hint.remove ? '移走它' : '放这里'}` : `${icons('i-bulb')}提示`);
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
          save();
          if (state.status === 'lost') showResult();
          return;
        }
        checkpoint(); marks.delete(index); errors.delete(index); cats.add(index); tone('cat');
        say('找对啦！猫头出现了，同一行、列、色块和相邻格已自动排除。');
      }
    } else {
      if (cats.has(index)) { say('双击或右键这只猫，就能把它抱走。'); render(); return; }
      if (E.excluded(regions, cats).has(index) && !marks.has(index) && !errors.has(index)) { say('这个格子已自动排除；抱走对应的猫咪后会自动恢复。'); render(); return; }
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
    const key = `${difficulty}:${state.number}:${state.seed}`;
    if (!wins.includes(key)) { wins.push(key); totalWins++; }
    streak++; bestStreak = Math.max(bestStreak, streak);
    say(`每只小猫都有了自己的位置。恭喜通关！当前连胜 ${streak}！`);
    const streakCard = document.querySelector('.streak-card');
    if (streakCard) streakCard.classList.add('streak-pop');
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
      checkpoint(); state.started = true;
      if (hint.remove) cats.delete(hint.index); else { marks.delete(hint.index); errors.delete(hint.index); cats.add(hint.index); tone('cat'); }
      clearHint(); checkWin(); render(); save();
      if (state.status === 'won') showResult(); else say('提示已应用。接下来交给你啦。');
      return;
    }
    const n = regions.length;
    const wrong = [...cats].find(i => solution[Math.floor(i / n)] !== i % n);
    if (wrong !== undefined) {
      state.hints++;
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
      state.hints++;
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
    clearTimeout(celebrationTimeout);
    $('#celebration-layer')?.replaceChildren();
    stopResultMusic();
    dialogKind = ''; updatePauseLabel();
  }
  function playResultMusic() {
    const music = $('#result-music');
    if (!music) return;
    music.volume = .34; music.currentTime = 0;
    music.play().catch(() => {});
  }
  function stopResultMusic() {
    const music = $('#result-music');
    if (!music) return;
    music.pause(); music.currentTime = 0;
  }
  function showResult() {
    const won = state.status === 'won';
    openDialog('result', `<div class="result-content">${icons('cat-face', 'dialog-cat')}<div class="dialog-eyebrow">${won ? 'ALL CATS, ALL HAPPY' : 'TAKE A LITTLE BREATH'}</div><h2 id="dialog-title">${won ? '小猫都找到啦！' : '再给自己一次机会'}</h2><p>${won ? '每一只都在对的位置。<br>下一场小小的挑战，准备好了吗？' : '这次的机会用完了，但思路已经更清楚了。<br>重新开始，或试试用提示找到突破口。'}</p><div class="result-stats"><div><b>${formatTime(state.seconds)}</b><span>本关用时</span></div><div><b>${state.hints}</b><span>使用提示</span></div><div><b>${cats.size} / ${regions.length}</b><span>找到小猫</span></div><div><b>${won ? streak : bestStreak}</b><span>${won ? '当前连胜' : '历史最高连胜'}</span></div></div><button class="primary-button" id="result-action">${won ? '继续，下一关' : '重新挑战'}${icons('i-arrow')}</button></div>`);
    $('#result-action').onclick = () => { won ? nextRound() : restart(); };
    playResultMusic();
    if (won) { celebrate(); warmNextRound(); }
  }
  function warmNextRound() {
    if (nextRoundWarmup != null) {
      if ('cancelIdleCallback' in window) window.cancelIdleCallback(nextRoundWarmup);
      else clearTimeout(nextRoundWarmup);
    }
    const key = difficulty, number = state.number + 1;
    preparedRound = freshRound(number);
    const generate = () => {
      nextRoundWarmup = null;
      if (difficulty !== key || state.status !== 'won' || preparedRound?.number !== number) return;
      try { E.generateLevel(SIZES[key], preparedRound.seed); } catch { preparedRound = null; }
    };
    nextRoundWarmup = 'requestIdleCallback' in window
      ? window.requestIdleCallback(generate, { timeout: 900 })
      : setTimeout(generate, 60);
  }
  function nextRound() {
    rounds[difficulty] = preparedRound?.number === state.number + 1 ? preparedRound : freshRound(state.number + 1);
    preparedRound = null;
    enterRound();
    closeDialog();
  }
  function restart() {
    rounds[difficulty] = freshRound(state.number);
    enterRound();
    closeDialog();
    say('重新开始了。机会已恢复，并换成新的随机棋盘。');
  }
  function requestReset() {
    if (!state.started && !marks.size && !cats.size && !errors.size) { say('棋盘还是空的，直接开始就好。'); return; }
    openDialog('reset', `<div class="dialog-eyebrow">A FRESH START</div><h2 id="dialog-title">换一盘重新找？</h2><p>会生成一张全新的随机棋盘，清空本关标记和计时并恢复 3 次机会。连胜和完成记录会保留。</p><div class="dialog-actions"><button class="secondary-button" id="reset-cancel">继续这局</button><button class="primary-button" id="reset-confirm">换一盘</button></div>`);
    $('#reset-cancel').onclick = closeDialog; $('#reset-confirm').onclick = restart;
  }
  function showHelp() {
    openDialog('help', `<div class="dialog-eyebrow">HOW TO PLAY</div><h2 id="dialog-title">给每只猫找个位置</h2><ol class="help-list"><li>每个颜色的区域恰好放 <b>1 只猫</b>。</li><li>每一行、每一列也都恰好放 <b>1 只猫</b>。</li><li>猫咪不能相邻，<b>斜角也算</b>。</li></ol><p>只有找对解答中的位置才会出现猫头；点错会显示红色叉并扣一次机会。</p><div class="help-controls"><b>鼠标</b>：左键单击排除，左键双击或右键放猫，按住左键拖动可连续排除。<b>手机</b>：点击排除，双击放猫，按住滑动连续排除。<b>键盘</b>：方向键移动，空格／回车排除，<kbd>C</kbd> 放猫，<kbd>X</kbd> 排除，<kbd>Ctrl+Z</kbd> 撤销，<kbd>P</kbd> 暂停。<br><b>卡住了？</b> 提示会先指出一个位置和原因，再点一次才应用。</div><p class="dialog-caption">每次刷新、重来或进入下一关都会生成新棋盘；最高连胜和显示设置保存在当前浏览器中。</p><div class="dialog-actions"><button class="primary-button" id="help-done">知道了，去找猫</button></div>`);
    $('#help-done').onclick = closeDialog;
  }
  function applySetting(key, value) {
    if (!(key in settings)) return;
    settings[key] = Boolean(value);
    document.querySelectorAll(`[data-main-setting="${key}"]`).forEach(input => { input.checked = settings[key]; });
    render(); save();
  }
  function celebrate() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const layer = $('#celebration-layer');
    if (!layer) return;
    clearTimeout(celebrationTimeout); layer.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 56; i++) {
      const piece = document.createElement('i');
      piece.className = `confetti confetti-fall${i % 5 === 0 ? ' confetti-round' : ''}`;
      piece.style.left = `${2 + Math.random() * 96}%`;
      piece.style.background = `var(--r${i % 10})`;
      piece.style.setProperty('--delay', `${Math.random() * 1.1}s`);
      piece.style.setProperty('--duration', `${2.6 + Math.random() * 1.5}s`);
      piece.style.setProperty('--drift', `${-90 + Math.random() * 180}px`);
      piece.style.setProperty('--spin', `${540 + Math.random() * 900}deg`);
      fragment.append(piece);
    }
    for (const side of ['left', 'right']) {
      for (let i = 0; i < 20; i++) {
        const piece = document.createElement('i');
        piece.className = `confetti confetti-jet confetti-${side}${i % 4 === 0 ? ' confetti-round' : ''}`;
        piece.style.bottom = `${8 + Math.random() * 18}%`;
        piece.style.background = `var(--r${(i * 3 + (side === 'right' ? 5 : 0)) % 10})`;
        piece.style.setProperty('--delay', `${.08 + Math.random() * .38}s`);
        piece.style.setProperty('--duration', `${1.55 + Math.random() * .75}s`);
        const jetDistance = 34 + Math.random() * 31;
        piece.style.setProperty('--jet-x', `${side === 'left' ? jetDistance : -jetDistance}vw`);
        piece.style.setProperty('--jet-y', `${-26 - Math.random() * 47}vh`);
        const jetSpin = 500 + Math.random() * 760;
        piece.style.setProperty('--spin', `${side === 'left' ? jetSpin : -jetSpin}deg`);
        fragment.append(piece);
      }
    }
    layer.append(fragment);
    celebrationTimeout = setTimeout(() => layer.replaceChildren(), 4600);
  }
  function updatePauseLabel() { $('#pause-label').hidden = !(paused || $('#game-dialog').open); $('#pause-button').setAttribute('aria-label', paused ? '继续游戏（P）' : '暂停游戏（P）'); }
  function togglePause() {
    if (state.status !== 'playing') return;
    paused = !paused; $('#board-overlay').hidden = !paused; updatePauseLabel();
    $('#board').inert = paused;
    if (paused) $('#resume-button').focus(); else $('#board').children[focusIndex].focus();
  }
  $('#undo-button').onclick = undo; $('#reset-button').onclick = requestReset; $('#hint-button').onclick = offerHint;
  $('#help-button').onclick = showHelp;
  $('#dialog-close').onclick = closeDialog; $('#resume-button').onclick = togglePause;
  $('#pause-button').onclick = togglePause;
  $('#game-dialog').addEventListener('click', event => { if (event.target === $('#game-dialog')) { const rect = $('#game-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(); } });
  $('#game-dialog').addEventListener('close', () => { stopResultMusic(); dialogKind = ''; updatePauseLabel(); });
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
      if (event.key.toLowerCase() === 'c') { event.preventDefault(); interact(focusIndex, 'cat'); }
      if (event.key.toLowerCase() === 'x') { event.preventDefault(); interact(focusIndex, 'mark'); }
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
