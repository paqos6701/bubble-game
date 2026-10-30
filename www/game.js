/* 비눗방울 터뜨리기 — 카메라 모션 게임
 * - 앞면 카메라 + 좌우 반전 화면
 * - MediaPipe 셀피 세그멘테이션(폰 안에 포함, 인터넷 불필요)으로 "사람이 있는 영역"을 찾고
 *   그 영역에 닿은 방울을 터뜨린다 (손, 발, 머리 등 몸 어디든)
 * - 1인 / 2인(화면 좌우 반반 점수 대결), 1분, 쉬움/보통, 황금 방울(5점), 효과음
 * - 시작·다시 하기: 화면 위쪽 큰 방울을 손으로 잠깐 터치
 */
(() => {
  'use strict';

  // ---------- 설정값 ----------
  const GAME_SECONDS = 60;
  const SEG_FPS = 15;            // 인식 횟수(초당). 낮을수록 발열 적음
  const MASK_W = 96;             // 인식 결과를 줄여서 읽는 크기
  const HUD_TOP = 0.14;          // 화면 위쪽 점수판 영역(비율)
  const GOLD_POINTS = 5;
  const DIFF = {
    easy:   { r: 0.095, speed: 0.06, max: 7, every: 0.55, life: 8.0 },
    normal: { r: 0.070, speed: 0.10, max: 5, every: 0.70, life: 6.5 },
  };
  const COLORS = { l: '#2f8cff', r: '#ff4d6d', s: '#17a2ff' };
  const NAMES = { l: '왼쪽', r: '오른쪽', s: '' };
  const DEBUG = /[?&]debug/.test(location.search);

  // ---------- 요소 ----------
  const video = document.getElementById('cam');
  const cv = document.getElementById('fx');
  const ctx = cv.getContext('2d');
  const setupEl = document.getElementById('setup');
  const startBtn = document.getElementById('startBtn');
  const homeBtn = document.getElementById('homeBtn');
  const msgEl = document.getElementById('msg');
  const maskCv = document.createElement('canvas');
  const maskCtx = maskCv.getContext('2d', { willReadFrequently: true });

  // ---------- 상태 ----------
  let W = 0, H = 0, DPR = 1;
  let state = 'setup';           // setup | loading | ready | countdown | play | result
  let stateT = 0;                // 현재 상태에 들어온 뒤 지난 시간(초)
  let players = [];
  let particles = [];
  let texts = [];
  let timeLeft = GAME_SECONDS;
  let lastTick = 0;
  let resultInfo = null;
  const settings = { players: 1, diff: { s: 'easy', l: 'easy', r: 'normal' } };

  let stream = null;
  let seg = null, segReady = false, segBusy = false, lastSegAt = 0;
  let mask = null, maskH = 0, maskAt = 0, maskUseAlpha = null;
  const debugPointers = new Map();

  // ---------- 화면 크기 ----------
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    spriteCache.clear();
    layoutPlayers();
  }
  window.addEventListener('resize', resize);

  // ---------- 설정 화면 ----------
  document.querySelectorAll('[data-players]').forEach(b => b.addEventListener('click', () => {
    settings.players = +b.dataset.players;
    document.querySelectorAll('[data-players]').forEach(x => x.classList.toggle('on', x === b));
    document.getElementById('diff1').classList.toggle('hidden', settings.players !== 1);
    document.getElementById('diff2').classList.toggle('hidden', settings.players !== 2);
  }));
  document.querySelectorAll('[data-diff]').forEach(b => b.addEventListener('click', () => {
    const [side, d] = b.dataset.diff.split(':');
    settings.diff[side] = d;
    document.querySelectorAll(`[data-diff^="${side}:"]`).forEach(x => x.classList.toggle('on', x === b));
  }));
  startBtn.addEventListener('click', start);
  homeBtn.addEventListener('click', goSetup);

  async function start() {
    msgEl.textContent = '';
    Sound.unlock();
    setupEl.classList.add('hidden');
    homeBtn.classList.remove('hidden');
    makePlayers();
    setState('loading');
    try {
      await startCamera();
      await initSeg();
      setState('ready');
    } catch (e) {
      console.error(e);
      goSetup();
      msgEl.textContent = '카메라를 켤 수 없어요. 카메라 권한을 허용했는지 확인해 주세요. (' + (e && e.name || e) + ')';
    }
  }

  function goSetup() {
    stopCamera();
    setState('setup');
    setupEl.classList.remove('hidden');
    homeBtn.classList.add('hidden');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state !== 'setup') goSetup();   // 화면이 꺼지거나 다른 앱으로 가면 카메라 끔(발열 방지)
  });

  // ---------- 카메라 ----------
  async function startCamera() {
    if (stream) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 } },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    await new Promise(res => {
      if (video.videoWidth) return res();
      video.onloadedmetadata = () => res();
    });
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    mask = null;
  }

  // ---------- 사람 인식 ----------
  async function initSeg() {
    if (segReady) return;
    seg = new SelfieSegmentation({ locateFile: f => 'mp/' + f });
    seg.setOptions({ modelSelection: 1, selfieMode: false });
    seg.onResults(onSegResults);
    await seg.initialize();
    segReady = true;
  }

  function onSegResults(res) {
    const m = res.segmentationMask;
    if (!m) return;
    const vw = video.videoWidth || 640, vh = video.videoHeight || 360;
    const mh = Math.max(1, Math.round(MASK_W * vh / vw));
    if (maskCv.width !== MASK_W || maskCv.height !== mh) { maskCv.width = MASK_W; maskCv.height = mh; }
    maskCtx.clearRect(0, 0, MASK_W, mh);
    maskCtx.drawImage(m, 0, 0, MASK_W, mh);
    const d = maskCtx.getImageData(0, 0, MASK_W, mh).data;
    // 결과 이미지가 확률을 알파에 담는지 빨강에 담는지 한 번 판별
    if (maskUseAlpha === null) {
      let alphaVaries = false;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { alphaVaries = true; break; }
      maskUseAlpha = alphaVaries;
    }
    const out = new Uint8Array(MASK_W * mh);
    for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = maskUseAlpha ? d[i + 3] : d[i];
    mask = out; maskH = mh; maskAt = performance.now();
  }

  function pumpSeg(now) {
    if (!segReady || segBusy || !stream || video.readyState < 2) return;
    if (now - lastSegAt < 1000 / SEG_FPS) return;
    lastSegAt = now; segBusy = true;
    seg.send({ image: video }).catch(() => {}).finally(() => { segBusy = false; });
  }

  // 화면 좌표 → 인식 결과 값(0~255). 화면은 좌우 반전 + 가득 채우기(cover)로 표시됨
  function bodyAt(x, y) {
    if (!mask || performance.now() - maskAt > 1000) return 0;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return 0;
    const sc = Math.max(W / vw, H / vh);
    const offX = (W - vw * sc) / 2, offY = (H - vh * sc) / 2;
    const vx = ((W - x) - offX) / sc, vy = (y - offY) / sc;
    const mx = Math.floor(vx / vw * MASK_W), my = Math.floor(vy / vh * maskH);
    if (mx < 0 || my < 0 || mx >= MASK_W || my >= maskH) return 0;
    return mask[my * MASK_W + mx];
  }

  const RING = (() => {
    const pts = [[0, 0]];
    for (let i = 0; i < 8; i++) pts.push([0.5 * Math.cos(i * Math.PI / 4), 0.5 * Math.sin(i * Math.PI / 4)]);
    for (let i = 0; i < 12; i++) pts.push([0.85 * Math.cos(i * Math.PI / 6 + 0.26), 0.85 * Math.sin(i * Math.PI / 6 + 0.26)]);
    return pts;
  })();

  // 원 안에서 몸이 차지하는 비율(0~1)
  function coverage(x, y, r) {
    if (DEBUG && debugPointers.size) {
      for (const p of debugPointers.values()) if (Math.hypot(p.x - x, p.y - y) < r + H * 0.08) return 1;
    }
    let hit = 0;
    for (const [dx, dy] of RING) if (bodyAt(x + dx * r, y + dy * r) > 128) hit++;
    return hit / RING.length;
  }

  if (DEBUG) {
    cv.addEventListener('pointerdown', e => debugPointers.set(e.pointerId, { x: e.clientX, y: e.clientY }));
    cv.addEventListener('pointermove', e => { if (debugPointers.has(e.pointerId)) debugPointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
    const up = e => debugPointers.delete(e.pointerId);
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  }

  // ---------- 플레이어 ----------
  function makePlayers() {
    const keys = settings.players === 2 ? ['l', 'r'] : ['s'];
    players = keys.map(k => ({ key: k, diff: settings.diff[k], score: 0, bubbles: [], spawnT: 0, goldT: 0, hold: 0, done: false }));
    layoutPlayers();
  }

  function layoutPlayers() {
    players.forEach((p, i) => {
      const n = players.length;
      p.x0 = W * i / n; p.x1 = W * (i + 1) / n;
      p.cx = (p.x0 + p.x1) / 2;
    });
  }

  function resetRound() {
    players.forEach(p => {
      p.score = 0; p.bubbles = []; p.spawnT = 0.2; p.goldT = rand(5, 8); p.hold = 0; p.done = false;
    });
    particles = []; texts = [];
    timeLeft = GAME_SECONDS; lastTick = Math.ceil(GAME_SECONDS);
  }

  function setState(s) {
    state = s; stateT = 0;
    if (s === 'ready' || s === 'result') players.forEach(p => { p.hold = 0; p.done = false; });
    if (s === 'countdown') { resetRound(); Sound.beep(660, 0.15); }
  }

  // ---------- 방울 ----------
  function rand(a, b) { return a + Math.random() * (b - a); }

  function spawn(p, gold) {
    const cfg = DIFF[p.diff];
    const widthFactor = (p.x1 - p.x0) / (W / 2);       // 1인(전체 화면)은 더 많이
    if (!gold && p.bubbles.filter(b => !b.gold).length >= Math.round(cfg.max * Math.max(1, widthFactor * 0.8))) return;
    const r = gold ? H * 0.07 : H * cfg.r * rand(0.85, 1.15);
    const top = H * HUD_TOP;
    const x = rand(p.x0 + r, p.x1 - r);
    const y = rand(top + r, H - r);
    const sp = H * (gold ? 0.22 : cfg.speed) * rand(0.8, 1.2);
    const a = rand(0, Math.PI * 2);
    p.bubbles.push({ x, y, r, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0,
      life: gold ? 4.5 : cfg.life * rand(0.85, 1.15), gold, ph: rand(0, 6.28) });
  }

  function updateBubbles(p, dt) {
    const top = H * HUD_TOP;
    for (let i = p.bubbles.length - 1; i >= 0; i--) {
      const b = p.bubbles[i];
      b.age += dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.vy += Math.sin(b.age * 1.7 + b.ph) * H * 0.02 * dt;  // 살랑살랑
      if (b.x < p.x0 + b.r) { b.x = p.x0 + b.r; b.vx = Math.abs(b.vx); }
      if (b.x > p.x1 - b.r) { b.x = p.x1 - b.r; b.vx = -Math.abs(b.vx); }
      if (b.y < top + b.r) { b.y = top + b.r; b.vy = Math.abs(b.vy); }
      if (b.y > H - b.r) { b.y = H - b.r; b.vy = -Math.abs(b.vy); }
      if (b.age > b.life) { p.bubbles.splice(i, 1); continue; }
      // 나타난 직후 0.45초는 안 터짐(갑자기 생기자마자 터지는 것 방지)
      if (b.age > 0.45 && b.age < b.life - 0.2 && coverage(b.x, b.y, b.r) >= 0.2) {
        pop(p, b);
        p.bubbles.splice(i, 1);
      }
    }
  }

  function pop(p, b) {
    const pts = b.gold ? GOLD_POINTS : 1;
    p.score += pts;
    if (b.gold) Sound.gold(); else Sound.pop();
    const n = b.gold ? 16 : 9;
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + rand(-0.2, 0.2), s = rand(0.6, 1.2) * b.r * 3;
      particles.push({ x: b.x + Math.cos(a) * b.r * 0.8, y: b.y + Math.sin(a) * b.r * 0.8,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5, age: 0, gold: b.gold, size: rand(3, 6) * H / 600 });
    }
    texts.push({ x: b.x, y: b.y, t: '+' + pts, age: 0, gold: b.gold, color: COLORS[p.key] });
  }

  // ---------- 방울 그림(미리 그려두고 재사용) ----------
  const spriteCache = new Map();
  function sprite(r, gold) {
    const R = Math.max(6, Math.round(r));
    const key = R + (gold ? 'g' : 'n');
    if (spriteCache.has(key)) return spriteCache.get(key);
    const s = Math.ceil(R * 2 + 6) * DPR;
    const c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    g.scale(DPR, DPR);
    const m = R + 3;
    const fill = g.createRadialGradient(m - R * 0.3, m - R * 0.3, R * 0.1, m, m, R);
    if (gold) {
      fill.addColorStop(0, 'rgba(255,250,210,0.75)');
      fill.addColorStop(0.7, 'rgba(255,205,60,0.65)');
      fill.addColorStop(1, 'rgba(255,160,0,0.95)');
    } else {
      fill.addColorStop(0, 'rgba(255,255,255,0.04)');
      fill.addColorStop(0.75, 'rgba(200,235,255,0.18)');
      fill.addColorStop(1, 'rgba(170,215,255,0.55)');
    }
    g.fillStyle = fill;
    g.beginPath(); g.arc(m, m, R, 0, Math.PI * 2); g.fill();
    // 무지갯빛 테두리
    let rim;
    try {
      rim = g.createConicGradient(0, m, m);
      const cols = gold ? ['#fff3a0', '#ffb300', '#ffe680', '#ff9800', '#fff3a0']
                        : ['#ff9ad5', '#9ad0ff', '#a6ffcb', '#fff59a', '#ff9ad5'];
      cols.forEach((col, i) => rim.addColorStop(i / (cols.length - 1), col));
    } catch (e) { rim = gold ? '#ffb300' : 'rgba(255,255,255,0.8)'; }
    g.strokeStyle = rim; g.lineWidth = Math.max(2, R * 0.06);
    g.beginPath(); g.arc(m, m, R - g.lineWidth / 2, 0, Math.PI * 2); g.stroke();
    // 반짝이
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath(); g.ellipse(m - R * 0.38, m - R * 0.42, R * 0.22, R * 0.12, -0.7, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(m + R * 0.42, m + R * 0.38, R * 0.06, 0, Math.PI * 2); g.fill();
    if (gold) {
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.font = `900 ${Math.round(R * 0.9)}px sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('★', m, m + R * 0.05);
    }
    const out = { c, m };
    spriteCache.set(key, out);
    return out;
  }

  function drawBubble(b, t) {
    let a = 1;
    if (b.age < 0.45) a = b.age / 0.45;
    else if (b.age > b.life - 0.6) a = Math.max(0, (b.life - b.age) / 0.6);
    const wob = 1 + 0.04 * Math.sin(t * 3 + b.ph);
    const sp = sprite(b.r, b.gold);
    ctx.globalAlpha = a;
    const w = (sp.m * 2) * wob, h = (sp.m * 2) / wob;
    ctx.drawImage(sp.c, b.x - w / 2, b.y - h / 2, w, h);
    ctx.globalAlpha = 1;
  }

  // ---------- 효과음 (파일 없이 즉석 합성) ----------
  const Sound = (() => {
    let ac = null;
    function unlock() {
      try {
        if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
        if (ac.state === 'suspended') ac.resume();
      } catch (e) { ac = null; }
    }
    function tone(freq, start, dur, type = 'sine', vol = 0.25, endFreq) {
      if (!ac) return;
      const t0 = ac.currentTime + start;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t0);
      if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(ac.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
    let noiseBuf = null;
    function noise(start, dur, vol, freq) {
      if (!ac) return;
      if (!noiseBuf) {
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.2, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const t0 = ac.currentTime + start;
      const s = ac.createBufferSource(); s.buffer = noiseBuf;
      const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
      const g = ac.createGain();
      g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      s.connect(f).connect(g).connect(ac.destination);
      s.start(t0); s.stop(t0 + dur + 0.02);
    }
    return {
      unlock,
      pop() { const f = rand(500, 750); tone(f, 0, 0.09, 'sine', 0.35, f * 0.35); noise(0, 0.05, 0.25, 2500); },
      gold() { [880, 1175, 1568, 2093].forEach((f, i) => tone(f, i * 0.07, 0.22, 'triangle', 0.22)); noise(0, 0.06, 0.2, 3000); },
      beep(f = 660, d = 0.15) { tone(f, 0, d, 'square', 0.12); },
      tick() { tone(1200, 0, 0.05, 'square', 0.06); },
      ready() { tone(523, 0, 0.12, 'triangle', 0.2); tone(784, 0.1, 0.18, 'triangle', 0.2); },
      end() {
        [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.13, 0.3, 'triangle', 0.22));
        tone(1047, 0.55, 0.6, 'triangle', 0.2); tone(1319, 0.55, 0.6, 'sine', 0.12);
      },
    };
  })();

  // ---------- 오늘 최고 기록 ----------
  function todayKey(diff) {
    const d = new Date();
    return `best-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${diff}`;
  }
  function getBest(diff) { try { return +(localStorage.getItem(todayKey(diff)) || 0); } catch (e) { return 0; } }
  function setBest(diff, v) { try { localStorage.setItem(todayKey(diff), String(v)); } catch (e) {} }

  // ---------- 진행 ----------
  function finish() {
    Sound.end();
    if (players.length === 1) {
      const p = players[0];
      const prev = getBest(p.diff);
      const isNew = p.score > prev;
      if (isNew) setBest(p.diff, p.score);
      resultInfo = { single: true, score: p.score, best: Math.max(prev, p.score), isNew, diff: p.diff };
    } else {
      const [l, r] = players;
      resultInfo = { single: false, l: l.score, r: r.score, winner: l.score === r.score ? null : (l.score > r.score ? 'l' : 'r') };
    }
    // 축하 종이꽃가루
    for (let i = 0; i < 70; i++) {
      particles.push({ x: rand(0, W), y: rand(-H * 0.3, 0), vx: rand(-30, 30), vy: rand(H * 0.25, H * 0.5),
        life: 2.5, age: 0, confetti: true, size: rand(5, 9) * H / 600,
        color: ['#ff4d6d', '#2f8cff', '#ffc531', '#36d399', '#a26bff'][i % 5], rot: rand(0, 6) });
    }
    setState('result');
  }

  function update(dt, now) {
    stateT += dt;
    if (state !== 'setup' && state !== 'loading') pumpSeg(now);

    if (state === 'ready' || (state === 'result' && stateT > 3)) {
      const ty = H * 0.3, tr = H * 0.13;
      let allDone = true;
      players.forEach(p => {
        if (!p.done) {
          const c = coverage(p.cx, ty, tr);
          p.hold = c >= 0.2 ? p.hold + dt : Math.max(0, p.hold - dt * 1.5);
          if (p.hold >= 0.8) { p.done = true; Sound.ready(); }
        }
        if (!p.done) allDone = false;
      });
      if (allDone) setState('countdown');
    }

    if (state === 'countdown') {
      const n = Math.floor(stateT);
      if (n !== Math.floor(stateT - dt) && n >= 1 && n <= 3) Sound.beep(n === 3 ? 990 : 660, n === 3 ? 0.3 : 0.15);
      if (stateT >= 3.4) setState('play');
    }

    if (state === 'play') {
      timeLeft = Math.max(0, GAME_SECONDS - stateT);
      const sec = Math.ceil(timeLeft);
      if (sec !== lastTick) { lastTick = sec; if (sec <= 10 && sec > 0) Sound.tick(); }
      players.forEach(p => {
        p.spawnT -= dt;
        if (p.spawnT <= 0) { spawn(p, false); p.spawnT = DIFF[p.diff].every * rand(0.7, 1.3); }
        p.goldT -= dt;
        if (p.goldT <= 0) { if (!p.bubbles.some(b => b.gold)) spawn(p, true); p.goldT = rand(6, 9); }
        updateBubbles(p, dt);
      });
      if (timeLeft <= 0) finish();
    } else if (state === 'result' || state === 'countdown') {
      // 남은 방울은 천천히 사라짐
      players.forEach(p => p.bubbles.forEach(b => { b.age = Math.max(b.age, b.life - 0.6); b.age += dt; }));
      players.forEach(p => { p.bubbles = p.bubbles.filter(b => b.age < b.life); });
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.age += dt; q.x += q.vx * dt; q.y += q.vy * dt;
      if (!q.confetti) { q.vx *= 0.92; q.vy = q.vy * 0.92 + H * 0.6 * dt; } else q.rot += dt * 6;
      if (q.age > q.life) particles.splice(i, 1);
    }
    for (let i = texts.length - 1; i >= 0; i--) {
      texts[i].age += dt; texts[i].y -= H * 0.12 * dt;
      if (texts[i].age > 0.8) texts.splice(i, 1);
    }
  }

  // ---------- 그리기 ----------
  function font(px, w = 900) { return `${w} ${Math.round(px)}px "Samsung Sans","SamsungOneKorean","Noto Sans KR",sans-serif`; }

  function outlinedText(t, x, y, px, fill, stroke = 'rgba(0,0,0,0.55)') {
    ctx.font = font(px);
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, px * 0.14);
    ctx.strokeStyle = stroke; ctx.strokeText(t, x, y);
    ctx.fillStyle = fill; ctx.fillText(t, x, y);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawHUD() {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const y = H * 0.07;
    // 타이머
    const sec = state === 'play' ? Math.ceil(timeLeft) : (state === 'result' ? 0 : GAME_SECONDS);
    const urgent = state === 'play' && sec <= 10;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(W / 2 - H * 0.09, y - H * 0.055, H * 0.18, H * 0.11, H * 0.03); ctx.fill();
    outlinedText(String(sec), W / 2, y + H * 0.004, H * 0.08, urgent ? '#ff5a5a' : '#fff');
    // 점수
    players.forEach(p => {
      const px = players.length === 2 ? (p.key === 'l' ? W * 0.16 : W * 0.84) : W * 0.14;
      ctx.fillStyle = COLORS[p.key];
      roundRect(px - H * 0.16, y - H * 0.055, H * 0.32, H * 0.11, H * 0.03); ctx.fill();
      const label = NAMES[p.key] ? NAMES[p.key] + ' ' : '점수 ';
      ctx.font = font(H * 0.04, 800);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.textAlign = 'right'; ctx.fillText(label, px - H * 0.01, y + H * 0.004);
      ctx.textAlign = 'left'; outlinedText(String(p.score), px, y + H * 0.004, H * 0.075, '#fff', 'rgba(0,0,0,0.3)');
      ctx.textAlign = 'center';
    });
  }

  function drawDivider() {
    if (players.length !== 2) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 4;
    ctx.setLineDash([H * 0.03, H * 0.02]);
    ctx.beginPath(); ctx.moveTo(W / 2, H * HUD_TOP); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.restore();
    // 좌우 아주 옅은 색
    ctx.fillStyle = 'rgba(47,140,255,0.06)'; ctx.fillRect(0, H * HUD_TOP, W / 2, H);
    ctx.fillStyle = 'rgba(255,77,109,0.06)'; ctx.fillRect(W / 2, H * HUD_TOP, W / 2, H);
  }

  function drawReadyTargets(t, again) {
    const ty = H * 0.3, tr = H * 0.13;
    players.forEach(p => {
      const sp = sprite(tr, false);
      const wob = 1 + 0.05 * Math.sin(t * 4);
      ctx.globalAlpha = p.done ? 0.5 : 1;
      ctx.drawImage(sp.c, p.cx - sp.m * wob, ty - sp.m * wob, sp.m * 2 * wob, sp.m * 2 * wob);
      ctx.globalAlpha = 1;
      // 진행 고리
      ctx.lineWidth = H * 0.018; ctx.lineCap = 'round';
      ctx.strokeStyle = COLORS[p.key];
      const prog = p.done ? 1 : Math.min(1, p.hold / 0.8);
      if (prog > 0) { ctx.beginPath(); ctx.arc(p.cx, ty, tr + H * 0.02, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke(); }
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (p.done) outlinedText('준비 완료 ✓', p.cx, ty, H * 0.05, '#fff');
      else {
        outlinedText('✋', p.cx, ty - H * 0.02, H * 0.08, '#fff', 'rgba(0,0,0,0)');
        outlinedText('손으로 터치!', p.cx, ty + H * 0.065, H * 0.04, '#fff');
      }
      if (players.length === 2) outlinedText(NAMES[p.key], p.cx, ty + tr + H * 0.07, H * 0.05, COLORS[p.key], '#fff');
    });
    if (!again) {
      const msg = players.length === 2 ? '두 사람 모두 위의 방울을 손으로 터치하면 시작해요' : '위의 방울을 손으로 터치하면 시작해요';
      outlinedText(msg, W / 2, H * 0.9, H * 0.045, '#fff');
    } else {
      outlinedText(players.length === 2 ? '둘 다 방울을 터치하면 다시 시작!' : '방울을 터치하면 다시 시작!', W / 2, H * 0.94, H * 0.04, '#fff');
    }
  }

  function drawResult() {
    const pw = Math.min(W * 0.7, H * 1.3), ph = H * 0.34;
    const x = W / 2 - pw / 2, y = H * 0.5;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    roundRect(x, y, pw, ph, H * 0.05); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const r = resultInfo;
    if (r.single) {
      ctx.font = font(H * 0.075); ctx.fillStyle = '#17324d';
      ctx.fillText(`🫧 ${r.score}점!`, W / 2, y + ph * 0.3);
      ctx.font = font(H * 0.045, 800);
      if (r.isNew && r.score > 0) { ctx.fillStyle = '#e67e00'; ctx.fillText('🎉 오늘 신기록!', W / 2, y + ph * 0.7); }
      else { ctx.fillStyle = '#4b6178'; ctx.fillText(`오늘 최고 기록 ${r.best}점 (${r.diff === 'easy' ? '쉬움' : '보통'})`, W / 2, y + ph * 0.7); }
    } else {
      ctx.font = font(H * 0.07);
      if (r.winner) { ctx.fillStyle = COLORS[r.winner]; ctx.fillText(`🏆 ${NAMES[r.winner]} 승리!`, W / 2, y + ph * 0.32); }
      else { ctx.fillStyle = '#17324d'; ctx.fillText('🤝 무승부!', W / 2, y + ph * 0.32); }
      ctx.font = font(H * 0.08);
      ctx.fillStyle = COLORS.l; ctx.textAlign = 'right'; ctx.fillText(String(r.l), W / 2 - H * 0.05, y + ph * 0.72);
      ctx.fillStyle = '#17324d'; ctx.textAlign = 'center'; ctx.fillText(':', W / 2, y + ph * 0.7);
      ctx.fillStyle = COLORS.r; ctx.textAlign = 'left'; ctx.fillText(String(r.r), W / 2 + H * 0.05, y + ph * 0.72);
      ctx.textAlign = 'center';
    }
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    if (state === 'setup') return;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    if (state === 'loading') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, W, H);
      outlinedText('준비 중…', W / 2, H / 2, H * 0.07, '#fff');
      return;
    }

    drawDivider();
    players.forEach(p => p.bubbles.forEach(b => drawBubble(b, t)));

    for (const q of particles) {
      const a = 1 - q.age / q.life;
      ctx.globalAlpha = Math.max(0, a);
      if (q.confetti) {
        ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(q.rot);
        ctx.fillStyle = q.color; ctx.fillRect(-q.size, -q.size / 2, q.size * 2, q.size);
        ctx.restore();
      } else {
        ctx.fillStyle = q.gold ? '#ffd24a' : 'rgba(220,240,255,0.95)';
        ctx.beginPath(); ctx.arc(q.x, q.y, q.size, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    for (const tx of texts) {
      ctx.globalAlpha = Math.max(0, 1 - tx.age / 0.8);
      outlinedText(tx.t, tx.x, tx.y, H * (tx.gold ? 0.09 : 0.06), tx.gold ? '#ffd24a' : '#fff', tx.color);
    }
    ctx.globalAlpha = 1;

    drawHUD();

    if (state === 'ready') drawReadyTargets(t, false);
    if (state === 'countdown') {
      const n = 3 - Math.floor(stateT);
      const label = n >= 1 ? String(n) : '시작!';
      const k = 1 + 0.3 * (1 - (stateT % 1));
      outlinedText(label, W / 2, H * 0.5, H * 0.25 * (n >= 1 ? k : 1), '#fff', '#17324d');
    }
    if (state === 'result') {
      drawResult();
      if (stateT <= 3) outlinedText('끝!', W / 2, H * 0.3, H * 0.12, '#fff', '#17324d');
      else {
        // 결과 패널 위로 다시 하기 방울 표시
        drawReadyTargets(t, true);
      }
    }

    if (DEBUG) {
      for (const p of debugPointers.values()) {
        ctx.strokeStyle = '#0f0'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p.x, p.y, H * 0.08, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.font = '12px monospace'; ctx.fillStyle = '#0f0'; ctx.textAlign = 'left';
      ctx.fillText(`state=${state} mask=${mask ? 'Y' : 'N'} alpha=${maskUseAlpha}`, 8, H - 10);
    }
  }

  // ---------- 메인 루프 ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt, now);
    draw(now / 1000);
    requestAnimationFrame(frame);
  }

  resize();
  requestAnimationFrame(frame);

  window.__bubble = { get state() { return state; }, players: () => players, finish };
})();
