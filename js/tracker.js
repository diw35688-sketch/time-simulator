// 手部跟踪与拨时间：把每帧识别结果变成平滑、稳定、可预测的法阵状态。
// 不依赖 DOM 和 three.js，tests/check_tracker.mjs 在 Node 里用合成数据测它。

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
export const approach = (cur, target, dt, tau) => target + (cur - target) * Math.exp(-dt / tau);
const damp = (x, y, lambda, dt) => x + (y - x) * (1 - Math.exp(-lambda * dt));
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = a => Math.hypot(a[0], a[1], a[2]);
const norm3 = a => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nlerp3 = (a, b, k) => norm3([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);

export class OneEuro {
  constructor(minCutoff, beta, dCutoff = 2) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
  reset() { this.x = null; this.dx = 0; this.a = 1; }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(v, dt) {
    if (this.x === null || !(dt > 0)) { this.x = v; this.dx = 0; this.a = 1; return v; }
    this.dx += OneEuro.alpha(this.dCutoff, dt) * ((v - this.x) / dt - this.dx);
    this.a = OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x += this.a * (v - this.x);
    return this.x;
  }
}

// 一路信号：OneEuro 去抖 + 用相邻两次滤波结果估计速度（给渲染帧外推用）
class Channel {
  constructor(cfg, velK = 0.5) { this.f = new OneEuro(...cfg); this.velK = velK; this.reset(); }
  reset() { this.f.reset(); this.x = null; this.v = 0; this.lag = 0; }
  push(raw, dt) {
    const prev = this.x;
    this.x = this.f.filter(raw, dt);
    if (prev !== null && dt > 0) this.v += this.velK * ((this.x - prev) / dt - this.v);
    this.lag = dt > 0 ? (1 - this.f.a) / this.f.a * dt : 0;   // 稳态下滤波结果落后的时间（秒）
    return this.x;
  }
}

// 视频归一化坐标 → 屏幕像素（object-fit: cover，左右镜像）
export function coverMap(viewW, viewH, srcW, srcH) {
  const sa = viewW / viewH, va = srcW / srcH;
  const w = va > sa ? viewH * va : viewW, h = va > sa ? viewH : viewW / va;
  return { w, h, x: nx => viewW / 2 + (0.5 - nx) * w, y: ny => viewH / 2 + (ny - 0.5) * h };
}

// 从 21 个关键点算出手的特征。S 是屏幕像素（y 向下），P 是 x 右、y 上、z 朝镜头的三维坐标
export function handFeatures(lm, map) {
  const S = [], P = [];
  for (let i = 0; i < 21; i++) {
    const sx = map.x(lm[i].x), sy = map.y(lm[i].y);
    S.push([sx, sy]); P.push([sx, -sy, -(lm[i].z || 0) * map.w]);
  }
  const len = len3(sub3(P[9], P[0]));
  if (!(len > 1)) return null;
  let x = 0, y = 0;
  for (const i of [0, 5, 9, 13, 17]) { x += S[i][0] / 5; y += S[i][1] / 5; }
  const m = [0, 1, 2].map(j => (P[5][j] + P[9][j] + P[13][j] + P[17][j]) / 4);
  const open = (len3(sub3(P[8], P[0])) + len3(sub3(P[12], P[0])) + len3(sub3(P[16], P[0])) + len3(sub3(P[20], P[0]))) / 4 / len;
  // 滚转角：手腕指向四个指根中心的方向。屏幕坐标 y 向下，所以顺时针转动时角度变大
  const roll = Math.atan2(-(m[1] - P[0][1]), m[0] - P[0][0]);
  let n = norm3(cross3(sub3(P[5], P[0]), sub3(P[17], P[0])));
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  return { S, x, y, len, open, roll, up: norm3(sub3(m, P[0])), n };
}

export const TRACK_DEFAULTS = {
  pos: [1.0, 0.02, 2.0],      // OneEuro：静止时的截止频率 Hz、随速度提高截止频率的系数、速度估计的截止频率
  len: [2.0, 0.06, 2.0],      // 手掌长度决定法阵大小：手往镜头前推、往后撤时要跟得上
  roll: [3.0, 8.0, 2.0],      // 转角以弧度计，速度系数要大一些，转得快时才跟得上
  // 外推：法阵要对齐的是屏幕上的手，而屏幕上的画面本身就比真实的手晚 dispLatency（摄像头拍下到显示出来），
  // 所以按速度外推到“当前显示的这一帧拍下的时刻”，而不是外推到现在（那样会跑到画面里的手前面去）
  dispLatency: 30, lead: 0.9, rollLead: 0.6, maxLead: 100, velK: 0.7,
  leadMinSpeed: 25, leadRamp: 100,   // px/s：慢于这个速度不外推，免得放大静止时的抖动
  rollMinSpeed: 0.3, rollRamp: 0.6,  // rad/s：转角同理
  tauPos: 0.012, tauRoll: 0.012, tauLen: 0.02, tauSlow: 0.035, tauN: 0.04, tauArm: 0.04,
  grace: 220, reset: 450,     // ms：短暂丢失时继续沿用；超过 reset 就当成新的一只手
  openOn: 1.55, openOff: 1.25, openFrames: 2,
  rollJump: 0.8,              // rad：两帧之间转动超过这个角度当成识别错误
  // 前臂：方向 = 手指方向的反方向 + 手腕弯曲角。弯曲角、前臂长度、前臂朝镜头倾斜的角度来自姿态识别（手肘），
  // 它们变化慢，单独平滑；前臂方向本身跟着手的转角实时走，所以不会被姿态识别的速度拖慢
  armRatio: 2.6,             // 前臂长 / 手掌长（三维）
  armTilt: 0.6,              // rad：没有姿态识别时，假设前臂往镜头里倾斜的角度
  maxBend: 1.1, tauBend: 0.06, poseHold: 1500,
};

function newSlot(k, p) {
  return {
    id: k, pref: k === 0 ? 'Left' : 'Right',   // MediaPipe 按镜像画面判断左右，送进去的是原始画面，它说的 Left 是用户的右手
    active: false, seen: false, lastTs: -Infinity, epoch: 0, open: false, openRatio: 0, openRun: 0,
    cx: new Channel(p.pos, p.velK), cy: new Channel(p.pos, p.velK), len: new Channel(p.len), roll: new Channel(p.roll),
    rollPrev: 0, rollU: 0, rollGlitch: 0, n: [0, 0, 1], up: [0, 1, 0], S: null, hist: [],
    woR: 0.55, woA: Math.PI,   // 手腕相对手掌中心的位置：距离（手掌长的倍数）、相对手指方向的角度
    bend: 0, ratio2D: p.armRatio * Math.cos(p.armTilt), tilt: p.armTilt, poseTs: -Infinity,
    d: { init: false, x: 0, y: 0, roll: 0, len: 0, n: [0, 0, 1], up: [0, 1, 0], wx: 0, wy: 0, bend: 0, arm: [0, 1], armLen: 0, armTilt: p.armTilt, armOk: false },
  };
}

export class HandTracker {
  constructor(params = {}) {
    this.p = { ...TRACK_DEFAULTS, ...params };
    this.slots = [newSlot(0, this.p), newSlot(1, this.p)];
    this.interval = 33; this.latency = 30; this.lastFrameTs = -Infinity;
  }

  // 识别越慢、结果到得越晚，丢失后等待的时间越长：慢电脑上每次识别间隔可能有 100–200ms，不能当成手丢了
  get grace() { return clamp(this.interval * 2.5 + this.latency, this.p.grace, 900); }
  get resetMs() { return Math.max(this.p.reset, this.grace * 2); }

  // frame: { ts（采集时刻 ms）, hands: [{ lm, handed, score }], arms?: [{ wrist, elbow, vis }]（arms 已是屏幕像素） }
  // now：结果送到的时刻（不传就当没有延迟）
  ingest(frame, map, now = frame.ts) {
    const p = this.p, ts = frame.ts;
    this.latency += (clamp(now - ts, 0, 1000) - this.latency) * 0.2;
    if (ts > this.lastFrameTs && this.lastFrameTs > 0) this.interval += (clamp(ts - this.lastFrameTs, 5, 1000) - this.interval) * 0.2;
    this.lastFrameTs = Math.max(this.lastFrameTs, ts);
    let dets = (frame.hands || []).map(h => { const f = handFeatures(h.lm, map); return f && Object.assign(f, { handed: h.handed, score: h.score ?? 1 }); }).filter(Boolean);
    // 同一只手偶尔会被识别成两只，离得太近就只留分数高的
    if (dets.length === 2 && Math.hypot(dets[0].x - dets[1].x, dets[0].y - dets[1].y) < 0.5 * Math.min(dets[0].len, dets[1].len)) {
      dets = [dets[0].score >= dets[1].score ? dets[0] : dets[1]];
    }
    const cost = (d, s) => {
      if (s.active && ts - s.lastTs < this.resetMs) {
        const dd = Math.hypot(d.x - s.cx.x, d.y - s.cy.x) / Math.max(s.len.x, 40);
        return dd < 3 ? dd * 0.3 : 3 + dd * 0.01;
      }
      return 1.2 + (d.handed === s.pref ? 0 : 0.5);
    };
    // 先看位置连续性，再看左右手标签：标签偶尔会翻转，不能只靠它
    let plan = [];
    if (dets.length === 1) plan = cost(dets[0], this.slots[0]) <= cost(dets[0], this.slots[1]) ? [[0, 0]] : [[0, 1]];
    else if (dets.length === 2) {
      const a = cost(dets[0], this.slots[0]) + cost(dets[1], this.slots[1]), b = cost(dets[0], this.slots[1]) + cost(dets[1], this.slots[0]);
      plan = a <= b ? [[0, 0], [1, 1]] : [[0, 1], [1, 0]];
    }
    for (const [di, si] of plan) this.ingestSlot(this.slots[si], dets[di], ts, cost(dets[di], this.slots[si]) >= 3);
    if (frame.arms) this.bindArms(frame.arms, ts, plan.map(([, si]) => this.slots[si]));
  }

  ingestSlot(s, f, ts, far) {
    const p = this.p;
    const fresh = !s.active || ts - s.lastTs > this.resetMs || far;
    const dt = fresh ? 0 : (ts - s.lastTs) / 1000;
    if (fresh) {
      for (const c of [s.cx, s.cy, s.len, s.roll]) c.reset();
      s.epoch++; s.d.init = false; s.rollPrev = f.roll; s.rollGlitch = 0;
      s.openRatio = f.open; s.open = f.open > (p.openOn + p.openOff) / 2; s.openRun = 0;
      s.n = f.n; s.up = f.up; s.hist = [];
      s.bend = 0; s.ratio2D = p.armRatio * Math.cos(p.armTilt); s.tilt = p.armTilt; s.poseTs = -Infinity;
    }
    s.active = true; s.lastTs = ts; s.S = f.S;
    s.cx.push(f.x, dt); s.cy.push(f.y, dt); s.len.push(f.len, dt);
    // 滚转角展开成连续值；一帧里跳得太离谱当成识别错误，连续出现才接受（并让拨盘重新对齐）
    const jump = fresh ? 0 : angDiff(f.roll, s.rollPrev);
    if (Math.abs(jump) > p.rollJump && ++s.rollGlitch < 3) {
      // 跳过这一帧的角度
    } else {
      if (Math.abs(jump) > p.rollJump) { s.roll.reset(); s.epoch++; s.rollU = f.roll; s.d.roll = f.roll; }
      else s.rollU = fresh ? f.roll : s.rollU + jump;
      s.rollGlitch = 0;
      s.roll.push(s.rollU, dt);
      s.rollPrev = f.roll;
    }
    const k = fresh ? 1 : 1 - Math.exp(-dt / 0.08), kn = fresh ? 1 : 1 - Math.exp(-dt / p.tauN);
    s.n = nlerp3(s.n, f.n, kn); s.up = nlerp3(s.up, f.up, kn);
    // 手腕位置记成相对手掌的极坐标（距离 / 手掌长、相对手指方向的角度），画的时候按当前转角和大小还原，转手时手腕跟着转
    const wox = f.S[0][0] - f.x, woy = f.S[0][1] - f.y;
    const woR = Math.hypot(wox, woy) / f.len, woA = angDiff(Math.atan2(woy, wox), f.roll);
    s.woR = fresh ? woR : s.woR + (woR - s.woR) * k;
    s.woA = fresh ? woA : s.woA + angDiff(woA, s.woA) * k;
    s.hist.push([ts, f.roll]); if (s.hist.length > 12) s.hist.shift();
    // 张开/握拳：比例先平滑，再加迟滞，连续几帧都一样才切换，避免单帧误判
    s.openRatio = fresh ? f.open : s.openRatio + (f.open - s.openRatio) * (1 - Math.exp(-dt / 0.05));
    const want = s.openRatio > p.openOn ? true : s.openRatio < p.openOff ? false : s.open;
    s.openRun = want !== s.open ? s.openRun + 1 : 0;
    if (s.openRun >= p.openFrames) { s.open = want; s.openRun = 0; }
  }

  // 手臂识别单独跑时，结果按位置分给当前看到的手
  ingestArms(arms, ts) {
    const slots = this.slots.filter(s => s.active && s.S);
    if (slots.length) this.bindArms(arms, ts, slots);
  }

  bindArms(arms, ts, slots) {
    const p = this.p;
    for (const s of slots) {
      const w = s.S[0];
      let best = null, bd = s.len.x * 2.5;
      for (const a of arms) {
        const d = Math.hypot(a.wrist[0] - w[0], a.wrist[1] - w[1]);
        if (a.vis > 0.5 && d < bd) { bd = d; best = a; }
      }
      if (!best) continue;
      const dx = best.elbow[0] - best.wrist[0], dy = best.elbow[1] - best.wrist[1], l = Math.hypot(dx, dy);
      if (l < 1) continue;
      // 和这一帧姿态同一时刻的手的转角（姿态识别和手势识别不一定是同一帧）
      let roll = s.rollPrev, near = Infinity;
      for (const [t, r] of s.hist) if (Math.abs(t - ts) < near) { near = Math.abs(t - ts); roll = r; }
      const bend = angDiff(Math.atan2(dy, dx), roll + Math.PI);
      if (Math.abs(bend) > p.maxBend) continue;   // 弯得太离谱，多半是把别的手臂认成了这只手的
      const ratio = l / Math.max(s.len.x, 1);
      const tilt = clamp(Math.acos(clamp(ratio / p.armRatio, 0.25, 1)), 0.35, 1.25);
      const k = s.poseTs === -Infinity ? 1 : 1 - Math.exp(-clamp(ts - s.poseTs, 0, 500) / 1000 / p.tauBend);
      s.bend += angDiff(bend, s.bend) * k;
      s.ratio2D += (ratio - s.ratio2D) * k;
      s.tilt += (tilt - s.tilt) * k;
      s.poseTs = Math.max(s.poseTs, ts);
    }
  }

  // 每个渲染帧调用：在两次识别之间按速度连续推算位置，画面不会跟着识别结果一顿一顿地跳
  update(now, dt) {
    const p = this.p, k = tau => 1 - Math.exp(-dt / tau);
    for (const s of this.slots) {
      const age = now - s.lastTs;
      if (s.active && age > this.resetMs) s.active = false;
      s.seen = s.active && age < this.grace;
      if (!s.seen) continue;
      const gate = clamp((Math.hypot(s.cx.v, s.cy.v) - p.leadMinSpeed) / p.leadRamp, 0, 1);
      const rgate = clamp((Math.abs(s.roll.v) - p.rollMinSpeed) / p.rollRamp, 0, 1);
      // 外推多久：从这次识别用的那帧拍下，到屏幕上正显示的那帧拍下，再加上滤波本身的滞后
      const ahead = c => clamp(age - p.dispLatency + c.lag * 1000, 0, p.maxLead) / 1000;
      const tx = s.cx.x + s.cx.v * ahead(s.cx) * p.lead * gate, ty = s.cy.x + s.cy.v * ahead(s.cy) * p.lead * gate;
      const troll = s.roll.x + s.roll.v * ahead(s.roll) * p.rollLead * rgate;
      const d = s.d;
      if (!d.init) {
        Object.assign(d, { init: true, x: tx, y: ty, roll: troll, len: s.len.x, n: s.n, up: s.up, bend: s.bend });
      } else {
        d.x += (tx - d.x) * k(p.tauPos); d.y += (ty - d.y) * k(p.tauPos);
        d.roll += (troll - d.roll) * k(p.tauRoll);
        d.len += (s.len.x - d.len) * k(p.tauLen);
        d.n = nlerp3(d.n, s.n, k(p.tauSlow)); d.up = nlerp3(d.up, s.up, k(p.tauSlow));
      }
      d.wx = d.x + Math.cos(d.roll + s.woA) * s.woR * d.len;
      d.wy = d.y + Math.sin(d.roll + s.woA) * s.woR * d.len;
      // 姿态识别一段时间没来，弯曲角、长度和倾斜慢慢退回默认值
      const conf = Math.exp(-Math.max(0, now - s.poseTs) / p.poseHold), ka = k(p.tauArm);
      d.bend += angDiff(s.bend * conf, d.bend) * ka;
      const ang = d.roll + Math.PI + d.bend;
      d.arm = [Math.cos(ang), Math.sin(ang)];
      const ratio = p.armRatio * Math.cos(p.armTilt) + (s.ratio2D - p.armRatio * Math.cos(p.armTilt)) * conf;
      d.armLen = d.armLen ? d.armLen + (d.len * ratio - d.armLen) * ka : d.len * ratio;
      d.armTilt += (p.armTilt + (s.tilt - p.armTilt) * conf - d.armTilt) * ka;
      d.armOk = conf > 0.5;
    }
    return this.slots;
  }
}

// 拨盘：法阵锁定物品且手张开时，手转多少度时间就走多少（全程 lifeRad 对应 t 从 -1 到 1）。
// 没有惯性；小于 backlash 的来回抖动不传到时间上；顶到头以后继续转只会打滑，往回转立刻生效
export class TimeDial {
  constructor(lifeRad, backlash = 0.012) { this.lifeRad = lifeRad; this.backlash = backlash; this.key = null; this.hit = 0; }
  update(t, angle, key) {
    this.hit = 0;
    if (key == null) { this.key = null; return t; }
    if (key !== this.key) { this.key = key; this.ref = this.knob = angle; this.base = t; return t; }
    if (angle > this.knob + this.backlash) this.knob = angle - this.backlash;
    else if (angle < this.knob - this.backlash) this.knob = angle + this.backlash;
    const k = 2 / this.lifeRad, raw = this.base + (this.knob - this.ref) * k, c = clamp(raw, -1, 1);
    if (c !== raw) { this.ref += (raw - c) / k; this.hit = Math.sign(raw); }
    return c;
  }
}

export const INTERACT_DEFAULTS = { tauT: 0.015, wheelStep: 0.001, backlash: 0.012 };

// 法阵的出现和拨时间。rigs：每个法阵 { want（张开=1）, roll, key（手的槽位+跟踪纪元，鼠标为 null） }。
// 张开手掌、法阵出来就能拨，不用靠近物品；两只手都张开时，先张开的那只说了算
export class Interaction {
  constructor(lifeRad, params = {}) {
    this.p = { ...INTERACT_DEFAULTS, ...params };
    this.dial = new TimeDial(lifeRad, this.p.backlash);
    this.t = 0; this.target = 0; this.owner = -1;
  }
  step(dt, rigs, wheel = 0) {
    const p = this.p;
    for (const r of rigs) {
      r.presence = damp(r.presence ?? 0, r.want, r.want ? 5 : 4, dt);
      r.locked = r.presence > 0.5 && r.want === 1;
    }
    const drives = r => r && r.locked && r.want === 1 && r.key != null;
    if (!drives(rigs[this.owner])) this.owner = rigs.findIndex(drives);
    const o = rigs[this.owner], prevKey = this.dial.key, prevTarget = this.target, prevT = this.t;
    this.target = this.dial.update(this.target, o ? o.roll : 0, o ? this.owner + ':' + o.key : null);
    if (wheel && rigs.some(r => r.locked && r.key == null)) this.target = clamp(this.target + wheel * p.wheelStep, -1, 1);
    this.t = approach(this.t, this.target, dt, p.tauT);
    if (Math.abs(this.t - this.target) < 1e-4) this.t = this.target;
    return {
      t: this.t, target: this.target, speed: dt > 0 ? (this.t - prevT) / dt : 0,
      engaged: this.dial.key != null && this.dial.key !== prevKey,
      endHit: Math.abs(this.target) === 1 && Math.abs(prevTarget) !== 1 ? Math.sign(this.target) : 0,
      slipping: this.dial.hit,
    };
  }
  set(t) { this.t = this.target = clamp(t, -1, 1); this.dial.key = null; }
}
