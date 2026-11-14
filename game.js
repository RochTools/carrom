/* Carrom — canvas game on top of board/carrom-board.svg (800 x 800 board units).
   Fast by design: the board is pre-rendered once, coins are pre-rendered sprites, the loop only runs while something moves. */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Constants (board units: the SVG viewBox is 800 x 800)               */
  /* ------------------------------------------------------------------ */
  const BOARD = 800, CX = 400, CY = 400;
  const WALL_MIN = 58, WALL_MAX = 742;                 // cushion: coin edges bounce here
  const POCKETS = [{ x: 88, y: 88 }, { x: 712, y: 88 }, { x: 712, y: 712 }, { x: 88, y: 712 }];
  const POCKET_R = 26;                                  // a body whose centre gets this close to a pocket centre drops in
  const COIN_R = 16.5, STRIKER_R = 20.5;
  const COIN_M = 1, STRIKER_M = 2.6;
  const BASE_LINE = [629, 629, 171, 171];                // baseline position for each side: 0 bottom, 1 right, 2 top, 3 left
  const INWARD = [[0, -1], [-1, 0], [0, 1], [1, 0]];    // direction pointing from a side's baseline into the board
  const baseXY = (side, u) => (side % 2 === 0 ? [u, BASE_LINE[side]] : [BASE_LINE[side], u]);   // u slides along the baseline
  // Seats play in this order. Seat i belongs to team i % 2 (White = even seats, Black = odd seats), so partners sit opposite each other.
  const MODES = {
    pvp:   { sides: [0, 2],       cpu: [false, false] },
    cpu:   { sides: [0, 2],       cpu: [false, true] },
    vs2ai: { sides: [0, 1, 2, 3], cpu: [false, true, false, true] },   // two people (bottom + top) against two AIs (right + left)
    four:  { sides: [0, 1, 2, 3], cpu: [false, false, false, false] }  // four people, partners opposite
  };
  const BASE_X0 = 205, BASE_X1 = 595;
  const DRAG_K = 2.4;                                   // velocity decay per second (powdery board: things glide)
  const STOP_V = 12;
  const MAX_V = 2300;                                   // striker speed at 100 % power
  const E_COIN = 0.93, E_WALL = 0.78;
  const PULL_MAX = 240, PULL_MIN = 22;                  // board units of drag for full power / cancel threshold
  const SUB_DT = 1 / 240;

  /* ------------------------------------------------------------------ */
  /* DOM                                                                 */
  /* ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const canvas = $('board'), ctx = canvas.getContext('2d', { alpha: false });
  const ui = {
    hud: $('hud'), chips: [$('player-1'), $('player-2')], names: [$('player-1-name'), $('player-2-name')],
    counts: [$('player-1-count'), $('player-2-count')], queenChip: $('queen-chip'), queenState: $('queen-state'),
    toast: $('toast'), menu: $('menu-button'), slider: $('slider'), knob: $('slider-knob'),
    start: $('start-overlay'), end: $('end-overlay'), endTitle: $('end-title'), endReason: $('end-reason'),
    resume: $('resume-button'), sound: $('sound-button'), install: $('install-button'),
    help: $('help-dialog')
  };

  /* ------------------------------------------------------------------ */
  /* Audio: optional mp3 files in sounds/, built-in synth otherwise       */
  /* ------------------------------------------------------------------ */
  const audio = {
    ctx: null, enabled: true, buf: {}, loading: false, last: {},
    FILES: { strike: ['strike', 'shot'], coin: ['coin', 'ball'], wall: ['wall', 'cushion'], pocket: ['pocket'], foul: ['foul', 'wrong'], win: ['win', 'gameover'], tick: ['tick'] },
    VOL: { strike: 1, coin: 0.9, wall: 0.6, pocket: 0.9, foul: 1, win: 1, tick: 0.5 },
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
        try { this.ctx = new AC(); } catch (_) { return null; }
        setTimeout(() => this.load(), 0);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    },
    async load() {
      if (this.loading || !this.ctx) return; this.loading = true;
      await Promise.all(Object.keys(this.FILES).map(async (key) => {
        for (const name of this.FILES[key]) {
          try { const r = await fetch('sounds/' + name + '.mp3'); if (!r.ok) continue; this.buf[key] = await this.ctx.decodeAudioData(await r.arrayBuffer()); return; }
          catch (_) { /* try the next name */ }
        }
      }));
    },
    play(key, vol) {
      const b = this.buf[key]; if (!b || !this.enabled) return false;
      const c = this.ensure(); if (!c) return false;
      const src = c.createBufferSource(); src.buffer = b;
      const g = c.createGain(); g.gain.value = Math.min(1, (this.VOL[key] || 1) * (vol === undefined ? 1 : vol));
      src.connect(g).connect(c.destination); src.start(); return true;
    },
    tone(freq, to, dur, vol, type) {
      const c = this.ensure(); if (!c || !this.enabled) return;
      const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    /* rate-limited so a cluster of collisions in one frame is one sound */
    sfx(key, strength) {
      const now = performance.now(); if (now - (this.last[key] || 0) < 28) return; this.last[key] = now;
      const v = Math.max(0.15, Math.min(1, strength));
      if (this.play(key, v)) return;
      switch (key) {
        case 'strike': this.tone(900, 300, 0.07, 0.25 * v + 0.05, 'triangle'); break;
        case 'coin': this.tone(1500 + Math.random() * 300, 700, 0.05, 0.2 * v + 0.04, 'triangle'); break;
        case 'wall': this.tone(260, 120, 0.07, 0.2 * v + 0.03, 'sine'); break;
        case 'pocket': this.tone(520, 160, 0.16, 0.22, 'sine'); break;
        case 'tick': this.tone(2600, 1500, 0.03, 0.07, 'square'); break;
        case 'foul': this.tone(220, 110, 0.3, 0.2, 'sawtooth'); break;
        case 'win': [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, f, 0.25, 0.2, 'triangle'), i * 120)); break;
        default: break;
      }
    },
    toggle() { this.enabled = !this.enabled; if (this.enabled) this.ensure(); }
  };

  /* ------------------------------------------------------------------ */
  /* Game state                                                          */
  /* ------------------------------------------------------------------ */
  const game = {
    mode: 'pvp', state: 'menu',            // menu | aim | rolling | over
    sides: [0, 2], cpu: [false, false],    // per seat: which side of the board it shoots from, and whether the computer plays it
    bodies: [], striker: null,
    current: 0,                            // seat whose turn it is
    pocketed: { w: [], b: [] },            // coins sitting in pockets, by colour (they count for that colour's owner)
    queen: { state: 'center', owner: null },   // center | pending | covered
    debt: [0, 0],                          // coins a team owes back after a foul with nothing to return
    turn: null,
    strikerX: [400, 400, 400, 400],
    winner: null, started: false,
    ai: null,
    sinks: []
  };
  const kindOf = (team) => (team === 0 ? 'w' : 'b');
  const teamOfSeat = (seat) => seat % 2;
  const seatCount = () => game.sides.length;
  const seatName = (i) => {
    if (game.mode === 'cpu') return i === 0 ? 'You' : 'Computer';
    if (game.mode === 'vs2ai') return ['Player 1', 'AI 1', 'Player 2', 'AI 2'][i];
    return `Player ${i + 1}`;
  };
  const seatShort = (i) => {
    if (game.mode === 'cpu') return i === 0 ? 'You' : 'CPU';
    if (game.mode === 'vs2ai') return ['P1', 'AI 1', 'P2', 'AI 2'][i];
    return `P${i + 1}`;
  };
  const teamName = (t) => {
    if (game.mode === 'cpu') return t === 0 ? 'You' : 'Computer';
    if (game.mode === 'vs2ai') return t === 0 ? 'Players' : 'AI team';
    if (game.mode === 'four') return t === 0 ? 'P1 + P3' : 'P2 + P4';
    return `Player ${t + 1}`;
  };
  const teamShort = (t) => {
    if (game.mode === 'cpu') return t === 0 ? 'You' : 'CPU';
    if (game.mode === 'vs2ai') return t === 0 ? 'Players' : 'AIs';
    if (game.mode === 'four') return t === 0 ? 'P1 + P3' : 'P2 + P4';
    return `P${t + 1}`;
  };
  const isCpuTurn = () => !!game.cpu[game.current];
  // If a coin already sits on the baseline, the striker hops to the free spot beside it (left or right, whichever is nearer)
  function freeU(seat, u) {
    const side = game.sides[seat], vertical = side % 2 === 1, minD = STRIKER_R + COIN_R + 0.5, blockers = [];
    for (const o of game.bodies) {
      if (!o.in || o === game.striker) continue;
      const h = Math.abs((vertical ? o.x : o.y) - BASE_LINE[side]);
      if (h < minD) blockers.push({ cu: vertical ? o.y : o.x, w: Math.sqrt(minD * minD - h * h) });
    }
    const ok = (v) => v >= BASE_X0 && v <= BASE_X1 && blockers.every((b) => Math.abs(v - b.cu) >= b.w - 0.01);
    if (ok(u)) return u;
    let best = null;
    for (const b of blockers) for (const v of [b.cu - b.w, b.cu + b.w]) {
      const vv = Math.max(BASE_X0, Math.min(BASE_X1, v));
      if (ok(vv) && (best === null || Math.abs(vv - u) < Math.abs(best - u))) best = vv;
    }
    return best === null ? u : best;
  }
  const placeStriker = (seat, u) => { u = freeU(seat, u); game.strikerX[seat] = u; const [x, y] = baseXY(game.sides[seat], u); game.striker.x = x; game.striker.y = y; };

  function makeBody(kind, x, y) {
    const striker = kind === 's';
    return { kind, x, y, vx: 0, vy: 0, r: striker ? STRIKER_R : COIN_R, m: striker ? STRIKER_M : COIN_M, in: true, rot: Math.random() * 6.28 };
  }

  function setupCoins() {
    const list = [], d = 2 * COIN_R + 0.4;
    list.push(makeBody('q', CX, CY));
    // inner ring (6) and outer ring (12), colours alternate going around
    const ring = [];
    for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + k * Math.PI / 3; ring.push({ a, dist: d }); ring.push({ a: a + Math.PI / 6, dist: d * Math.sqrt(3) }); ring.push({ a, dist: 2 * d }); }
    const inner = ring.filter((p) => p.dist === d).sort((p, q) => p.a - q.a);
    const outer = ring.filter((p) => p.dist !== d).sort((p, q) => p.a - q.a);
    inner.forEach((p, i) => list.push(makeBody(i % 2 ? 'b' : 'w', CX + Math.cos(p.a) * p.dist, CY + Math.sin(p.a) * p.dist)));
    outer.forEach((p, i) => list.push(makeBody(i % 2 ? 'b' : 'w', CX + Math.cos(p.a) * p.dist, CY + Math.sin(p.a) * p.dist)));
    return list;
  }

  function newGame(mode) {
    game.mode = MODES[mode] ? mode : (MODES[game.mode] ? game.mode : 'pvp');
    game.sides = MODES[game.mode].sides.slice(); game.cpu = MODES[game.mode].cpu.slice();
    game.bodies = setupCoins();
    game.striker = makeBody('s', 400, BASE_LINE[0]);
    game.bodies.push(game.striker);
    game.pocketed = { w: [], b: [] }; game.queen = { state: 'center', owner: null }; game.debt = [0, 0];
    game.current = 0; game.winner = null; game.turn = null; game.sinks.length = 0; game.ai = null;
    game.strikerX = [400, 400, 400, 400]; game.started = true;
    ui.names[0].textContent = teamShort(0); ui.names[1].textContent = teamShort(1);
    ui.chips[0].classList.remove('winner'); ui.chips[1].classList.remove('winner');
    ui.start.hidden = true; ui.end.hidden = true;
    beginTurn();
    toast(seatCount() === 4 ? `${seatName(0)} shoots first` : 'White shoots first', seatCount() === 4 ? 'Partners sit opposite each other' : 'Slide the striker, then drag back and let go', '');
  }

  function beginTurn() {
    const s = game.striker, p = game.current;
    s.in = true; s.vx = s.vy = 0; placeStriker(p, game.strikerX[p]);
    game.turn = { player: p, pocketed: [], strikerIn: false, pendingBefore: game.queen.state === 'pending' && game.queen.owner === teamOfSeat(p) };
    setState('aim');
    placeSlider(); syncSlider(); updateHud(); invalidate();
    if (isCpuTurn()) scheduleAi();
  }

  // The striker slider sits below the board for the bottom seats and above it for the top seats
  function placeSlider() { root.setProperty('--sl-y', px(game.sides[game.current] >= 2 ? view.slTop : view.slBottom)); }

  function setState(s) {
    game.state = s;
    const human = s === 'aim' && !isCpuTurn();
    ui.slider.classList.toggle('disabled', !human);
    canvas.classList.toggle('busy', !human);
  }

  /* ------------------------------------------------------------------ */
  /* Layout                                                              */
  /* ------------------------------------------------------------------ */
  const view = { w: 0, h: 0, dpr: 1, bx: 0, by: 0, S: 0, sc: 1, land: false, boardImg: null, boardCv: null, ready: false };
  const root = document.documentElement.style;
  const setVars = (o) => { for (const k in o) root.setProperty(k, o[k]); };
  const px = (v) => `${Math.round(v)}px`;

  function layout() {
    const w = window.innerWidth, h = window.innerHeight;
    view.w = w; view.h = h; view.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const land = w > h * 1.15; view.land = land;
    document.body.classList.toggle('land', land);
    const SL = 46, GAP = 8;                                      // slider height / gap
    let S;
    if (land) {
      S = Math.min(h - 2 * SL - 4 * GAP - 4, w - 250); S = Math.max(160, S);
      view.bx = Math.round((w - S) / 2); view.by = Math.round(GAP + SL + GAP);
      setVars({
        '--hud-x': px(8), '--hud-w': px(Math.max(100, view.bx - 16)), '--hud-y': px(60),
        '--menu-x': px(8), '--menu-y': px(10),
        '--sl-x': px(view.bx + S / 2), '--sl-w': px(Math.min(S, 420)), '--sl-b': 'auto',
        '--toast-x': px(w - Math.max(110, view.bx - 14) / 2 - 6), '--toast-y': px(h / 2)
      });
    } else {
      const top = 52 + 8 + SL + GAP, bottom = SL + 3 * GAP;
      S = Math.max(160, Math.min(w - 8, h - top - bottom));
      view.bx = Math.round((w - S) / 2); view.by = Math.round(top + Math.max(0, (h - top - bottom - S) / 2));
      setVars({
        '--hud-x': '0px', '--hud-w': '100%', '--hud-y': px(10),
        '--menu-x': px(8), '--menu-y': px(10),
        '--sl-x': px(w / 2), '--sl-w': px(Math.min(w - 24, 420)), '--sl-b': 'auto',
        '--toast-x': '50%', '--toast-y': px(Math.max(66, view.by - 30))
      });
    }
    view.S = Math.round(S); view.sc = view.S / BOARD;
    view.slTop = view.by - GAP - SL; view.slBottom = view.by + view.S + GAP;
    canvas.width = Math.round(w * view.dpr); canvas.height = Math.round(h * view.dpr);
    buildBoardLayer(); buildSprites(); placeSlider(); syncSlider(); invalidate();
  }

  function buildBoardLayer() {
    if (!view.boardImg || !view.boardImg.complete || !view.boardImg.naturalWidth) { view.ready = false; return; }
    const n = Math.round(view.S * view.dpr);
    const cv = view.boardCv && view.boardCv.width === n ? view.boardCv : document.createElement('canvas');
    cv.width = n; cv.height = n;
    cv.getContext('2d').drawImage(view.boardImg, 0, 0, n, n);
    view.boardCv = cv; view.ready = true;
  }

  const toScreen = (x, y) => [view.bx + x * view.sc, view.by + y * view.sc];
  const toBoard = (cx, cy) => [(cx - view.bx) / view.sc, (cy - view.by) / view.sc];

  /* ------------------------------------------------------------------ */
  /* Sprites                                                             */
  /* ------------------------------------------------------------------ */
  const sprites = {};
  function buildSprites() {
    const k = view.sc * view.dpr;
    sprites.k = k;
    sprites.w = coinSprite('w', COIN_R, k); sprites.b = coinSprite('b', COIN_R, k);
    sprites.q = coinSprite('q', COIN_R, k); sprites.s = coinSprite('s', STRIKER_R, k);
  }
  // Photo-style PNG/WebP pieces (pieces/*.webp). The drawn sprites below are the fallback while they load.
  const pieceImgs = {};
  ['striker:s', 'queen:q', 'white:w', 'black:b'].forEach((e) => {
    const [file, kind] = e.split(':'), im = new Image();
    im.onload = () => { if (view.sc) { buildSprites(); invalidate(); } };
    im.src = `pieces/${file}.webp`; pieceImgs[kind] = im;
  });
  function pieceSprite(kind, r, k) {
    const im = pieceImgs[kind]; if (!im || !im.complete || !im.naturalWidth) return null;
    const R = r * k, D = Math.ceil(R * 2 * 1.25), cv = document.createElement('canvas'); cv.width = D; cv.height = D;
    const g = cv.getContext('2d'), w = R * 2 * 1.08;
    g.imageSmoothingQuality = 'high'; g.drawImage(im, D / 2 - w / 2, D / 2 - w / 2 - w * 0.025, w, w);
    cv.half = D / 2; return cv;
  }
  function coinSprite(kind, r, k) {
    const photo = pieceSprite(kind, r, k); if (photo) return photo;
    const pad = 7, R = r * k, D = Math.ceil((R + pad) * 2), cv = document.createElement('canvas');
    cv.width = D; cv.height = D;
    const g = cv.getContext('2d'), c = D / 2, TAU = Math.PI * 2;
    const circle = (rad, ox, oy) => { g.beginPath(); g.arc(c + (ox || 0), c + (oy || 0), rad, 0, TAU); };
    const P = {
      w: { rim: ['#ffffff', '#efe2c0', '#b9a273'], face: ['#fffdf5', '#f6ecd0', '#dccaa0'], groove: 'rgba(120,90,45,.55)', glow: 'rgba(255,255,255,.9)', edge: '#5b4524' },
      b: { rim: ['#6c6c72', '#26262b', '#050506'], face: ['#4a4a50', '#222226', '#0b0b0d'], groove: 'rgba(0,0,0,.85)', glow: 'rgba(255,255,255,.55)', edge: '#000' },
      q: { rim: ['#ffb3a6', '#e0452f', '#7a0f08'], face: ['#ff7b64', '#d7301d', '#8f160d'], groove: 'rgba(70,0,0,.55)', glow: 'rgba(255,230,220,.8)', edge: '#3c0500' },
      s: { rim: ['#fff4b8', '#e2b23e', '#7a4f0c'], face: ['#fff0a8', '#e9bc4a', '#b9801f'], groove: 'rgba(90,50,0,.55)', glow: 'rgba(255,255,235,.9)', edge: '#4a2c00' }
    }[kind];
    // contact shadow
    g.save(); g.shadowColor = 'rgba(15,6,0,.55)'; g.shadowBlur = R * 0.35; g.shadowOffsetX = R * 0.10; g.shadowOffsetY = R * 0.20;
    g.fillStyle = P.edge; circle(R * 0.98); g.fill(); g.restore();
    // bevelled outer rim (light from the top-left)
    const rim = g.createLinearGradient(c - R, c - R, c + R, c + R);
    rim.addColorStop(0, P.rim[0]); rim.addColorStop(0.5, P.rim[1]); rim.addColorStop(1, P.rim[2]);
    g.fillStyle = rim; circle(R * 0.98); g.fill();
    // sunken face, lit the opposite way so the rim reads as raised
    const fr = R * 0.80, face = g.createLinearGradient(c - fr, c - fr, c + fr, c + fr);
    face.addColorStop(0, P.face[2]); face.addColorStop(0.5, P.face[1]); face.addColorStop(1, P.face[0]);
    g.fillStyle = face; circle(fr); g.fill();
    g.lineWidth = Math.max(1, R * 0.05); g.strokeStyle = 'rgba(0,0,0,.35)'; circle(fr); g.stroke();
    // domed centre
    const dome = g.createRadialGradient(c - R * 0.22, c - R * 0.26, R * 0.02, c, c, fr * 0.92);
    dome.addColorStop(0, P.face[0]); dome.addColorStop(0.55, P.face[1]); dome.addColorStop(1, P.face[2]);
    g.fillStyle = dome; circle(fr * 0.9); g.fill();
    // engraved rings: a dark groove with a light lip
    const groove = (rad) => {
      g.lineWidth = Math.max(1, R * 0.055); g.strokeStyle = P.groove; circle(rad); g.stroke();
      g.lineWidth = Math.max(0.8, R * 0.03); g.strokeStyle = kind === 'b' ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.65)'; circle(rad + R * 0.05); g.stroke();
    };
    groove(R * 0.64); groove(R * 0.40);
    if (kind === 'q' || kind === 's') {            // eight-petal flower in the middle
      g.save(); g.translate(c, c);
      for (let i = 0; i < 8; i++) {
        g.rotate(TAU / 8); g.beginPath(); g.ellipse(R * 0.19, 0, R * 0.15, R * 0.065, 0, 0, TAU);
        g.fillStyle = kind === 'q' ? 'rgba(255,225,150,.9)' : 'rgba(110,60,0,.55)'; g.fill();
        g.lineWidth = Math.max(0.6, R * 0.02); g.strokeStyle = 'rgba(60,20,0,.5)'; g.stroke();
      }
      g.restore();
      g.fillStyle = kind === 'q' ? '#ffe9a8' : '#fff2b0'; circle(R * 0.085); g.fill();
    } else {
      g.fillStyle = kind === 'b' ? 'rgba(255,255,255,.18)' : 'rgba(120,90,45,.35)'; circle(R * 0.11); g.fill();
    }
    if (kind === 'q') {                            // gold ring around the queen
      g.lineWidth = Math.max(1.2, R * 0.07); g.strokeStyle = '#f7d46b'; circle(R * 0.9); g.stroke();
    }
    if (kind === 's') {                            // brass rim ticks
      g.lineWidth = Math.max(0.8, R * 0.035); g.strokeStyle = 'rgba(70,35,0,.6)'; g.beginPath();
      for (let i = 0; i < 24; i++) { const a = i * TAU / 24; g.moveTo(c + Math.cos(a) * R * 0.84, c + Math.sin(a) * R * 0.84); g.lineTo(c + Math.cos(a) * R * 0.94, c + Math.sin(a) * R * 0.94); }
      g.stroke();
    }
    // crisp outline
    g.lineWidth = Math.max(1, R * 0.06); g.strokeStyle = P.edge; circle(R - g.lineWidth * 0.5); g.stroke();
    // glossy highlight + soft bottom reflection
    const hl = g.createRadialGradient(c - R * 0.38, c - R * 0.44, 0, c - R * 0.38, c - R * 0.44, R * 0.62);
    hl.addColorStop(0, P.glow); hl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hl; circle(R * 0.96); g.fill();
    const rf = g.createRadialGradient(c + R * 0.35, c + R * 0.5, 0, c + R * 0.35, c + R * 0.5, R * 0.5);
    rf.addColorStop(0, kind === 'b' ? 'rgba(160,170,255,.28)' : 'rgba(255,255,255,.25)'); rf.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rf; circle(R * 0.95); g.fill();
    cv.half = D / 2;
    return cv;
  }

  /* ------------------------------------------------------------------ */
  /* Physics                                                             */
  /* ------------------------------------------------------------------ */
  let impactLoud = 0;
  function stepPhysics(dt) {
    const bodies = game.bodies, n = bodies.length;
    const damp = Math.exp(-DRAG_K * dt);
    for (let i = 0; i < n; i++) {
      const b = bodies[i]; if (!b.in) continue;
      if (b.vx !== 0 || b.vy !== 0) {
        b.x += b.vx * dt; b.y += b.vy * dt; b.vx *= damp; b.vy *= damp;
        if (b.vx * b.vx + b.vy * b.vy < STOP_V * STOP_V) { b.vx = 0; b.vy = 0; }
      }
      // pockets
      for (let p = 0; p < 4; p++) {
        const dx = b.x - POCKETS[p].x, dy = b.y - POCKETS[p].y;
        if (dx * dx + dy * dy < POCKET_R * POCKET_R) { sink(b, POCKETS[p]); break; }
      }
      if (!b.in) continue;
      // cushions
      const lo = WALL_MIN + b.r, hi = WALL_MAX - b.r;
      if (b.x < lo) { b.x = lo; if (b.vx < 0) { wallHit(-b.vx); b.vx = -b.vx * E_WALL; } }
      else if (b.x > hi) { b.x = hi; if (b.vx > 0) { wallHit(b.vx); b.vx = -b.vx * E_WALL; } }
      if (b.y < lo) { b.y = lo; if (b.vy < 0) { wallHit(-b.vy); b.vy = -b.vy * E_WALL; } }
      else if (b.y > hi) { b.y = hi; if (b.vy > 0) { wallHit(b.vy); b.vy = -b.vy * E_WALL; } }
    }
    // body vs body
    for (let i = 0; i < n; i++) {
      const a = bodies[i]; if (!a.in) continue;
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j]; if (!b.in) continue;
        const dx = b.x - a.x, dy = b.y - a.y, rr = a.r + b.r;
        if (dx > rr || dx < -rr || dy > rr || dy < -rr) continue;
        const d2 = dx * dx + dy * dy; if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.0001, nx = dx / d, ny = dy / d;
        const overlap = rr - d, ma = a.m, mb = b.m, tm = ma + mb;
        a.x -= nx * overlap * (mb / tm); a.y -= ny * overlap * (mb / tm);
        b.x += nx * overlap * (ma / tm); b.y += ny * overlap * (ma / tm);
        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn < 0) {
          const jimp = -(1 + E_COIN) * rvn / (1 / ma + 1 / mb);
          a.vx -= jimp * nx / ma; a.vy -= jimp * ny / ma; b.vx += jimp * nx / mb; b.vy += jimp * ny / mb;
          const loud = -rvn / 900; if (loud > impactLoud) impactLoud = loud;
          if (a.kind === 's' || b.kind === 's') audio.sfx('strike', -rvn / 900); else audio.sfx('coin', -rvn / 700);
        }
      }
    }
  }
  function wallHit(v) { audio.sfx('wall', v / 900); }

  function sink(b, pocket) {
    b.in = false; b.vx = b.vy = 0;
    game.sinks.push({ b, px: pocket.x, py: pocket.y, x0: b.x, y0: b.y, t: 0 });
    audio.sfx('pocket', 1);
    if (game.turn) { if (b.kind === 's') game.turn.strikerIn = true; else game.turn.pocketed.push(b); }
  }

  function anyMoving() {
    const bodies = game.bodies;
    for (let i = 0; i < bodies.length; i++) { const b = bodies[i]; if (b.in && (b.vx !== 0 || b.vy !== 0)) return true; }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Shooting                                                            */
  /* ------------------------------------------------------------------ */
  function shoot(dirx, diry, power) {
    if (game.state !== 'aim') return;
    const s = game.striker, v = MAX_V * (0.1 + 0.9 * power);
    s.vx = dirx * v; s.vy = diry * v;
    audio.ensure();
    setState('rolling'); aimPull = null; invalidate();
  }

  /* ------------------------------------------------------------------ */
  /* Turn resolution + rules                                             */
  /* ------------------------------------------------------------------ */
  function freeSpotNearCenter() {
    for (let r = 0; r < 120; r += 4) {
      const steps = r === 0 ? 1 : Math.ceil(r * 0.9);
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2, x = CX + Math.cos(a) * r, y = CY + Math.sin(a) * r;
        if (game.bodies.every((o) => !o.in || Math.hypot(o.x - x, o.y - y) > COIN_R * 2 + 1)) return [x, y];
      }
    }
    return [CX, CY];
  }
  function returnToCenter(b) {
    const [x, y] = freeSpotNearCenter();
    b.x = x; b.y = y; b.vx = b.vy = 0; b.in = true;
    const list = game.pocketed[b.kind]; const i = list ? list.indexOf(b) : -1; if (i >= 0) list.splice(i, 1);
  }

  function resolveTurn() {
    const t = game.turn, seat = t.player, me = teamOfSeat(seat), opp = 1 - me, mk = kindOf(me), ok = kindOf(opp);   // me / opp are teams
    const msgs = [];
    let foul = t.strikerIn, tone = '';
    const q = t.pocketed.find((b) => b.kind === 'q');
    let own = t.pocketed.filter((b) => b.kind === mk);
    const foe = t.pocketed.filter((b) => b.kind === ok);
    own.forEach((b) => game.pocketed[mk].push(b));
    foe.forEach((b) => game.pocketed[ok].push(b));

    // a coin owed from an earlier foul goes straight back
    let effOwn = own.slice();
    while (!foul && game.debt[me] > 0 && effOwn.length) {
      const b = effOwn.pop(); game.debt[me]--; returnToCenter(b); msgs.push('Coin returned (earlier foul)');
    }
    if (foul && game.debt[me] > 0 && own.length) { /* the coins pocketed while fouling just stay in; penalty handled below */ }

    // queen that had to be covered on this shot
    if (t.pendingBefore) {
      const queen = game.bodies.find((b) => b.kind === 'q');
      if (!foul && effOwn.length) { game.queen = { state: 'covered', owner: me }; msgs.push('Queen covered!'); tone = 'good'; }
      else { returnToCenter(queen); game.queen = { state: 'center', owner: null }; msgs.push('Queen not covered — back to the centre'); tone = 'foul'; }
    }
    // queen pocketed on this shot
    if (q) {
      if (foul) { returnToCenter(q); game.queen = { state: 'center', owner: null }; msgs.push('Queen goes back (foul)'); }
      else if (effOwn.length) { game.queen = { state: 'covered', owner: me }; msgs.push('Queen pocketed and covered!'); tone = 'good'; }
      else { game.queen = { state: 'pending', owner: me }; msgs.push('Queen! Now pocket one of your coins'); tone = 'good'; }
    }

    if (foul) {
      tone = 'foul'; audio.sfx('foul', 1);
      const mine = game.pocketed[mk];
      if (mine.length) { returnToCenter(mine[mine.length - 1]); msgs.unshift('Striker pocketed — one of your coins goes back'); }
      else { game.debt[me]++; msgs.unshift('Striker pocketed — you owe a coin'); }
    }
    if (!foul && foe.length) msgs.push(`${foe.length} ${opp === 0 ? 'white' : 'black'} coin${foe.length > 1 ? 's' : ''} went in for ${teamName(opp)}`);

    // win / early finish
    const winner = checkWin(me, msgs);
    updateHud();
    if (winner !== null) return endGame(winner);

    const qPending = game.queen.state === 'pending' && game.queen.owner === me;
    const cont = !foul && (effOwn.length > 0 || qPending);
    if (!cont) game.current = (seat + 1) % seatCount();
    if (cont && !msgs.length) msgs.push('Pocketed!');
    if (!cont && !msgs.length) msgs.push('No coin pocketed');
    toast(msgs[0], msgs[1] || (cont ? `${seatName(seat)} shoots again` : `${seatName(game.current)} to shoot`), tone);
    beginTurn();
  }

  function checkWin(me, msgs) {
    const mk = kindOf(me), ok = kindOf(1 - me);
    if (game.pocketed[mk].length >= 9) {
      if (game.queen.state === 'covered' && game.queen.owner === me) return me;
      const last = game.pocketed[mk][game.pocketed[mk].length - 1]; returnToCenter(last);
      msgs.push('Cover the queen first — last coin goes back');
    }
    if (game.pocketed[ok].length >= 9 && game.queen.state === 'covered' && game.queen.owner === 1 - me) return 1 - me;
    return null;
  }

  function endGame(w) {
    game.winner = w; setState('over'); audio.sfx('win', 1);
    ui.endTitle.textContent = game.mode === 'cpu' ? (w === 0 ? 'You win!' : 'Computer wins')
      : game.mode === 'vs2ai' ? (w === 0 ? 'You two win!' : 'The AI team wins')
      : game.mode === 'four' ? `Team ${teamName(w)} wins!` : `${teamName(w)} wins!`;
    ui.endReason.textContent = `All 9 ${w === 0 ? 'white' : 'black'} coins pocketed and the queen covered${seatCount() === 4 ? ' by the team' : ''}.`;
    ui.chips[w].classList.add('winner');
    setTimeout(() => { ui.end.hidden = false; }, 700);
  }

  /* ------------------------------------------------------------------ */
  /* HUD + toast                                                         */
  /* ------------------------------------------------------------------ */
  function updateHud() {
    [0, 1].forEach((i) => {
      ui.counts[i].textContent = `${game.pocketed[kindOf(i)].length}/9`;
      ui.chips[i].classList.toggle('active', teamOfSeat(game.current) === i && game.state !== 'over');
      ui.chips[i].classList.toggle('winner', game.winner === i);
    });
    const q = game.queen;
    ui.queenState.textContent = q.state === 'center' ? 'Centre' : q.state === 'pending' ? `Cover · ${teamShort(q.owner)}` : `${teamShort(q.owner)}`;
  }

  function toast() { /* pop-up notifications are switched off */ }

  /* ------------------------------------------------------------------ */
  /* Striker slider                                                      */
  /* ------------------------------------------------------------------ */
  const slide = { id: null, x0: 0, k0: 0, lastTick: 0 };
  const KNOB = 38;
  const sliderRange = () => Math.max(40, ui.slider.clientWidth - KNOB - 6);
  function syncSlider() {
    const t = (game.strikerX[game.current] - BASE_X0) / (BASE_X1 - BASE_X0);
    ui.knob.style.transform = `translateX(${3 + t * sliderRange()}px)`;
  }
  ui.knob.addEventListener('pointerdown', (e) => {
    if (game.state !== 'aim' || isCpuTurn() || slide.id !== null) return;
    e.preventDefault(); audio.ensure();
    slide.id = e.pointerId; slide.x0 = e.clientX; slide.k0 = (game.strikerX[game.current] - BASE_X0) / (BASE_X1 - BASE_X0);
    try { ui.knob.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  ui.knob.addEventListener('pointermove', (e) => {
    if (e.pointerId !== slide.id) return;
    const t = Math.max(0, Math.min(1, slide.k0 + (e.clientX - slide.x0) / sliderRange()));
    const x = BASE_X0 + t * (BASE_X1 - BASE_X0), p = game.current;
    if (Math.abs(x - game.strikerX[p]) > 0.05) {
      const before = Math.floor(game.strikerX[p] / 12); placeStriker(p, x);
      if (Math.floor(x / 12) !== before) audio.sfx('tick', 0.5);
      syncSlider(); invalidate();
    }
  });
  const endSlide = (e) => { if (e.pointerId === slide.id) slide.id = null; };
  ui.knob.addEventListener('pointerup', endSlide); ui.knob.addEventListener('pointercancel', endSlide);

  /* ------------------------------------------------------------------ */
  /* Pull-to-shoot on the board                                          */
  /* ------------------------------------------------------------------ */
  let aimPull = null;        // { id, x0, y0, x, y } in board units
  canvas.addEventListener('pointerdown', (e) => {
    if (game.state !== 'aim' || isCpuTurn() || aimPull) return;
    e.preventDefault(); audio.ensure();
    const [x, y] = toBoard(e.clientX, e.clientY);
    aimPull = { id: e.pointerId, x0: x, y0: y, x, y };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    invalidate();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!aimPull || e.pointerId !== aimPull.id) return;
    const [x, y] = toBoard(e.clientX, e.clientY); aimPull.x = x; aimPull.y = y; invalidate();
  });
  const releasePull = (e, cancelled) => {
    if (!aimPull || e.pointerId !== aimPull.id) return;
    const p = aimPull; aimPull = null;
    const vx = p.x0 - p.x, vy = p.y0 - p.y, len = Math.hypot(vx, vy);
    if (!cancelled && len >= PULL_MIN && game.state === 'aim' && !isCpuTurn()) shoot(vx / len, vy / len, Math.min(1, len / PULL_MAX));
    invalidate();
  };
  canvas.addEventListener('pointerup', (e) => releasePull(e, false));
  canvas.addEventListener('pointercancel', (e) => releasePull(e, true));
  canvas.addEventListener('lostpointercapture', (e) => { if (aimPull && e.pointerId === aimPull.id) releasePull(e, true); });

  /* ------------------------------------------------------------------ */
  /* Computer player                                                     */
  /* ------------------------------------------------------------------ */
  function scheduleAi() { game.ai = { t: 0, phase: 'think', plan: null }; invalidate(); }

  function clearSegment(ax, ay, bx, by, rad, skipA, skipB) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    for (const o of game.bodies) {
      if (!o.in || o === skipA || o === skipB || o === game.striker) continue;
      let t = ((o.x - ax) * dx + (o.y - ay) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px2 = ax + dx * t - o.x, py2 = ay + dy * t - o.y;
      if (px2 * px2 + py2 * py2 < (rad + o.r) * (rad + o.r)) return false;
    }
    return true;
  }

  function planShot() {
    const seat = game.current, mk = kindOf(teamOfSeat(seat)), side = game.sides[seat], inw = INWARD[side];
    const targets = game.bodies.filter((b) => b.in && (b.kind === mk || (b.kind === 'q' && game.queen.state === 'center')));
    let best = null;
    for (let u = BASE_X0; u <= BASE_X1; u += 15) {
      const [sx, sy] = baseXY(side, u);
      for (const c of targets) {
        for (const p of POCKETS) {
          const ux = p.x - c.x, uy = p.y - c.y, dcp = Math.hypot(ux, uy) || 1, nx = ux / dcp, ny = uy / dcp;
          const gx = c.x - nx * (c.r + STRIKER_R), gy = c.y - ny * (c.r + STRIKER_R);
          if (gx < WALL_MIN + STRIKER_R || gx > WALL_MAX - STRIKER_R || gy < WALL_MIN + STRIKER_R || gy > WALL_MAX - STRIKER_R) continue;
          const dsx = gx - sx, dsy = gy - sy, dsg = Math.hypot(dsx, dsy) || 1;
          const cos = (dsx * nx + dsy * ny) / dsg;
          if (cos < 0.3) continue;
          if (!clearSegment(sx, sy, gx, gy, STRIKER_R, c, null)) continue;
          if (!clearSegment(c.x, c.y, p.x, p.y, COIN_R, c, null)) continue;
          // aim must head away from our own baseline (towards the board)
          if (dsx * inw[0] + dsy * inw[1] < 0) continue;
          const score = cos * 100 - (dsg + dcp) * 0.06 + (c.kind === 'q' ? 8 : 0) + Math.random() * 6;
          if (!best || score > best.score) best = { score, u, gx, gy, cos, dsg, dcp, dirx: dsx / dsg, diry: dsy / dsg };
        }
      }
    }
    if (best) {
      const vCoin = best.dcp * DRAG_K + 260, v0 = vCoin / (1.3 * Math.max(0.5, best.cos)) + DRAG_K * best.dsg;
      const power = Math.max(0.25, Math.min(1, (v0 / MAX_V - 0.1) / 0.9));
      const err = (Math.random() - 0.5) * 2 * (1.2 * Math.PI / 180);               // CPU aim error: about 1 degree
      const a = Math.atan2(best.diry, best.dirx) + err;
      return { u: best.u, dirx: Math.cos(a), diry: Math.sin(a), power };
    }
    // no clean shot: hit the nearest own coin as it lies
    const u0 = game.strikerX[seat], [s0x, s0y] = baseXY(side, u0);
    let nearest = null, nd = 1e9;
    for (const c of targets) { const d = Math.hypot(c.x - s0x, c.y - s0y); if (d < nd && (c.x - s0x) * inw[0] + (c.y - s0y) * inw[1] > 0) { nd = d; nearest = c; } }
    const tx = nearest ? nearest.x : CX, ty = nearest ? nearest.y : CY;
    const u = Math.max(BASE_X0, Math.min(BASE_X1, u0 + (Math.random() - 0.5) * 80)), [sx, sy] = baseXY(side, u), d = Math.hypot(tx - sx, ty - sy) || 1;
    return { u, dirx: (tx - sx) / d, diry: (ty - sy) / d, power: 0.55 + Math.random() * 0.3 };
  }

  function updateAi(dt) {
    const ai = game.ai; if (!ai || game.state !== 'aim' || !isCpuTurn()) return false;
    const seat = game.current;
    ai.t += dt;
    if (ai.phase === 'think' && ai.t > 0.6) { ai.plan = planShot(); ai.from = game.strikerX[seat]; ai.phase = 'move'; ai.t = 0; }
    else if (ai.phase === 'move') {
      const k = Math.min(1, ai.t / 0.45), e = k * k * (3 - 2 * k), u = ai.from + (Math.max(BASE_X0, Math.min(BASE_X1, ai.plan.u)) - ai.from) * e;
      placeStriker(seat, u);
      if (k >= 1) { ai.phase = 'aim'; ai.t = 0; }
    } else if (ai.phase === 'aim' && ai.t > 0.55) {
      const p = ai.plan; game.ai = null; shoot(p.dirx, p.diry, p.power); return true;
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */
  let dirty = true, rafId = 0, lastT = 0, acc = 0;
  function invalidate() { dirty = true; if (!rafId) rafId = requestAnimationFrame(frame); }

  function frame(t) {
    rafId = 0;
    let dt = lastT ? (t - lastT) / 1000 : 1 / 60; lastT = t; if (dt > 0.05) dt = 0.05;
    let busy = false;
    if (game.state === 'menu' || ui.help.open) { lastT = 0; if (dirty) { draw(); dirty = false; } return; }

    if (game.state === 'rolling') {
      acc += dt;
      while (acc >= SUB_DT) { stepPhysics(SUB_DT); acc -= SUB_DT; }
      busy = true;
    }
    if (game.sinks.length) {
      for (let i = game.sinks.length - 1; i >= 0; i--) { const s = game.sinks[i]; s.t += dt / 0.22; if (s.t >= 1) game.sinks.splice(i, 1); }
      busy = true;
    }
    if (updateAi(dt)) busy = true;
    if (game.state === 'rolling' && !anyMoving() && !game.sinks.length) { acc = 0; resolveTurn(); busy = true; }
    if (busy || dirty) { draw(); dirty = false; }
    if (busy || (game.state === 'aim' && isCpuTurn())) rafId = requestAnimationFrame(frame); else lastT = 0;
  }

  function draw() {
    const d = view.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createRadialGradient(canvas.width / 2, canvas.height * 0.42, 0, canvas.width / 2, canvas.height * 0.42, Math.max(canvas.width, canvas.height) * 0.75);
    bg.addColorStop(0, '#2f86ff'); bg.addColorStop(0.45, '#1559e0'); bg.addColorStop(0.8, '#0a2d96'); bg.addColorStop(1, '#061a66');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!view.ready) return;
    ctx.drawImage(view.boardCv, view.bx * d, view.by * d);
    const k = sprites.k;
    const blit = (b, scale, alpha) => {
      const spr = sprites[b.kind], hs = spr.half, ox = (view.bx + b.x * view.sc) * d, oy = (view.by + b.y * view.sc) * d;
      if (scale === 1 && alpha === 1) { ctx.drawImage(spr, ox - hs, oy - hs); return; }
      ctx.globalAlpha = alpha; ctx.drawImage(spr, ox - hs * scale, oy - hs * scale, hs * 2 * scale, hs * 2 * scale); ctx.globalAlpha = 1;
    };
    const bodies = game.bodies;
    for (let i = 0; i < bodies.length; i++) { const b = bodies[i]; if (b.in && b !== game.striker) blit(b, 1, 1); }
    for (const s of game.sinks) {          // coins sliding into the pocket
      const e = s.t * s.t, b = s.b, bx = b.x, by = b.y;
      b.x = s.x0 + (s.px - s.x0) * e; b.y = s.y0 + (s.py - s.y0) * e;
      blit(b, 1 - 0.45 * e, 1 - 0.7 * e); b.x = bx; b.y = by;
    }
    if (game.striker.in && game.state !== 'over') {
      if (game.state === 'aim') drawAim();
      blit(game.striker, 1, 1);
    }
  }

  function drawAim() {
    const s = game.striker, sx = (view.bx + s.x * view.sc) * view.dpr, sy = (view.by + s.y * view.sc) * view.dpr, d = view.dpr, sc = view.sc * d;
    // baseline highlight (where the striker lives)
    if (!isCpuTurn()) {
      ctx.save(); ctx.strokeStyle = 'rgba(255,235,170,.55)'; ctx.lineWidth = 2 * d; ctx.setLineDash([4 * d, 6 * d]);
      ctx.beginPath(); ctx.arc(sx, sy, (STRIKER_R + 5) * sc, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    if (seatCount() === 4) {              // who is shooting, written just outside their baseline
      const inw = INWARD[game.sides[game.current]], lx = sx - inw[0] * 44 * sc, ly = sy - inw[1] * 44 * sc, txt = seatShort(game.current);
      ctx.save(); ctx.font = `700 ${Math.round(11 * d)}px Helvetica,Arial,sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(txt).width + 14 * d, th = 20 * d;
      ctx.fillStyle = teamOfSeat(game.current) === 0 ? 'rgba(255,244,214,.92)' : 'rgba(25,22,20,.88)';
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(lx - tw / 2, ly - th / 2, tw, th, th / 2); else ctx.rect(lx - tw / 2, ly - th / 2, tw, th); ctx.fill();
      ctx.fillStyle = teamOfSeat(game.current) === 0 ? '#3a2417' : '#fff3d8'; ctx.fillText(txt, lx, ly + d * 0.5); ctx.restore();
    }
    if (!aimPull) return;
    const vx = aimPull.x0 - aimPull.x, vy = aimPull.y0 - aimPull.y, len = Math.hypot(vx, vy);
    if (len < 2) return;
    const dx = vx / len, dy = vy / len, power = Math.min(1, len / PULL_MAX), cancel = len < PULL_MIN;
    // first thing the striker will touch
    let tHit = 1e9, hitBody = null;
    for (const o of game.bodies) {
      if (!o.in || o === s) continue;
      const ox = o.x - s.x, oy = o.y - s.y, proj = ox * dx + oy * dy; if (proj <= 0) continue;
      const perp2 = ox * ox + oy * oy - proj * proj, rr = o.r + s.r; if (perp2 >= rr * rr) continue;
      const th = proj - Math.sqrt(rr * rr - perp2); if (th < tHit) { tHit = th; hitBody = o; }
    }
    let tWall = 1e9;
    if (dx > 0) tWall = Math.min(tWall, (WALL_MAX - s.r - s.x) / dx); else if (dx < 0) tWall = Math.min(tWall, (WALL_MIN + s.r - s.x) / dx);
    if (dy > 0) tWall = Math.min(tWall, (WALL_MAX - s.r - s.y) / dy); else if (dy < 0) tWall = Math.min(tWall, (WALL_MIN + s.r - s.y) / dy);
    const L = Math.min(tHit, tWall);
    ctx.save(); ctx.lineCap = 'round';
    ctx.strokeStyle = cancel ? 'rgba(200,200,200,.5)' : 'rgba(255,248,220,.9)'; ctx.lineWidth = 2.2 * d; ctx.setLineDash([2 * d, 7 * d]);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + dx * L * sc, sy + dy * L * sc); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(sx + dx * L * sc, sy + dy * L * sc, s.r * sc, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,248,220,.6)'; ctx.lineWidth = 1.5 * d; ctx.stroke();
    if (hitBody) {                       // where the coin will be sent
      const hx = s.x + dx * L, hy = s.y + dy * L, nx = hitBody.x - hx, ny = hitBody.y - hy, nl = Math.hypot(nx, ny) || 1;
      const ex = (view.bx + hitBody.x * view.sc) * d, ey = (view.by + hitBody.y * view.sc) * d;
      ctx.strokeStyle = 'rgba(255,200,120,.8)'; ctx.lineWidth = 2 * d;
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex + (nx / nl) * 60 * sc, ey + (ny / nl) * 60 * sc); ctx.stroke();
    }
    // pull band behind the striker: length and colour show the power
    const bl = (30 + power * 90) * sc;
    ctx.strokeStyle = cancel ? 'rgba(160,160,160,.7)' : `hsl(${Math.round(120 - power * 120)},70%,58%)`; ctx.lineWidth = 6 * d;
    ctx.beginPath(); ctx.moveTo(sx - dx * (s.r + 4) * sc, sy - dy * (s.r + 4) * sc); ctx.lineTo(sx - dx * (s.r + 4) * sc - dx * bl, sy - dy * (s.r + 4) * sc - dy * bl); ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Menus                                                               */
  /* ------------------------------------------------------------------ */
  document.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', () => { audio.ensure(); newGame(btn.dataset.mode); }));
  function openMenu() {
    ui.resume.hidden = !(game.started && game.state !== 'over');
    ui.start.hidden = false; prevState = game.state; game.state = game.state === 'over' ? 'over' : 'menu';
    if (game.state === 'menu') ui.slider.classList.add('disabled');
  }
  let prevState = 'aim';
  ui.menu.addEventListener('click', openMenu);
  ui.resume.addEventListener('click', () => { ui.start.hidden = true; setState(prevState === 'menu' ? 'aim' : prevState); lastT = 0; invalidate(); if (isCpuTurn() && !game.ai && prevState === 'aim') scheduleAi(); });
  $('rematch-button').addEventListener('click', () => newGame(game.mode));
  $('change-mode-button').addEventListener('click', () => { ui.end.hidden = true; ui.resume.hidden = true; ui.start.hidden = false; });
  ui.sound.addEventListener('click', () => { audio.toggle(); ui.sound.textContent = `Sound: ${audio.enabled ? 'On' : 'Off'}`; ui.sound.setAttribute('aria-pressed', String(audio.enabled)); });
  $('start-help').addEventListener('click', () => { ui.help.showModal(); });
  $('help-close').addEventListener('click', () => { ui.help.close(); invalidate(); });
  ui.help.addEventListener('close', () => invalidate());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastT = 0; invalidate(); } });

  /* PWA: install prompt, service worker */
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; ui.install.hidden = false; });
  ui.install.addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; ui.install.hidden = true; });
  window.addEventListener('appinstalled', () => { ui.install.hidden = true; });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => { try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch (_) { /* unsupported */ } });
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 60); });
  window.addEventListener('orientationchange', () => setTimeout(layout, 120));
  view.boardImg = new Image();
  view.boardImg.onload = () => { layout(); };
  view.boardImg.src = 'board/carrom-board.svg';
  game.bodies = setupCoins(); game.striker = makeBody('s', 400, BASE_LINE[0]); game.bodies.push(game.striker);   // shown behind the start menu
  updateHud(); layout();
  game.invalidate = invalidate; game.shoot = shoot; game.resolve = resolveTurn; window.__carrom = game;            // handy for debugging in the console
})();
