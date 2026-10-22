// 手部跟踪与拨时间的场景测试（Node 直接跑，不需要浏览器）：用合成的手部关键点和姿态（带抖动、丢帧、左右手标签翻转、
// 识别延迟、手腕弯曲）驱动 js/tracker.js，和旧算法逐项对比。用法：node tests/check_tracker.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HandTracker, Interaction, OneEuro, coverMap, clamp, angDiff } from '../js/tracker.js';

const W = 1280, H = 720, MAP = coverMap(W, H, W, H), LIFE_RAD = 150 * Math.PI / 180;
const OBJ = { cx: W * 0.5, cy: H * 0.6, size: Math.min(W, H) * 0.35 };
const deg = d => d * Math.PI / 180, todeg = r => r * 180 / Math.PI;
const radiusOf = len => clamp(len * 1.55, 40, Math.min(W, H) * 0.9);

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const R = rng(20261022);
const gauss = () => Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R());

// 手的骨架：(u, v)，u 沿手指方向，v 指向手的右侧；单位是手掌长度（手腕到中指根）
const OPEN = [[0, 0], [.25, -.3], [.45, -.5], [.65, -.62], [.85, -.72], [.95, -.25], [1.35, -.3], [1.6, -.32], [1.82, -.34], [1, 0], [1.45, 0], [1.72, 0], [1.95, 0],
  [.95, .22], [1.35, .25], [1.6, .27], [1.8, .28], [.85, .4], [1.15, .47], [1.35, .51], [1.52, .55]];
const FIST = [[0, 0], [.25, -.3], [.45, -.45], [.55, -.35], [.7, -.2], [.95, -.25], [1.15, -.27], [.95, -.27], [.8, -.25], [1, 0], [1.2, 0], [.98, 0], [.82, 0],
  [.95, .22], [1.15, .24], [.95, .25], [.8, .25], [.85, .4], [1, .45], [.85, .45], [.72, .44]];
const L = 130, A = [380, 300], O = [OBJ.cx, OBJ.cy], B = [1000, 250];
// 前臂：转手时 30% 靠手腕弯、70% 靠整条前臂转（最多弯 35°），前臂往镜头里倾斜 0.7 rad
const ROLL0 = deg(-90), BEND0 = deg(15), BEND_K = 0.3, BEND_MAX = deg(35), ARM_RATIO = 2.6, ARM_TILT = 0.7;

// 场景：seg(时长 ms, 状态函数, 名字)；状态 = 手掌中心、手指方向（屏幕角度）、是否张开、大小倍数
const lerp = (a, b, k) => a + (b - a) * k;
const SEG = [], SEGT = {};
let segT = 0;
const seg = (ms, fn, name) => { if (name) SEGT[name] = [segT, segT + ms]; SEG.push([segT, segT + ms, fn]); segT += ms; };
const at = (x, y, rollDeg, open = true, scale = 1) => ({ x, y, roll: deg(rollDeg), open, scale });
seg(500, () => null);
seg(2000, () => at(A[0], A[1], -90), 'stillA');
seg(1000, k => at(lerp(A[0], O[0], k), lerp(A[1], O[1], k), -90), 'moveAO');
seg(1000, () => at(O[0], O[1], -90), 'arrive');
seg(2000, k => at(O[0], O[1], lerp(-90, -30, k)), 'rot60');
seg(1000, () => at(O[0], O[1], -30), 'hold60');
seg(2000, k => at(O[0], O[1], lerp(-30, -90, k)), 'rotBack');
seg(1000, () => at(O[0], O[1], -90), 'holdBack');
seg(6000, k => at(O[0], O[1], lerp(-90, -60, k)), 'slow');
seg(500, () => at(O[0], O[1], -60));
seg(300, () => at(O[0], O[1], -60, false), 'fist');
seg(1000, k => at(O[0], O[1], lerp(-60, -90, k), false), 'fistTurn');
seg(1000, () => at(O[0], O[1], -90), 'reopen');
seg(1000, k => at(O[0], O[1], lerp(-90, 30, k)), 'overEnd');
seg(700, k => at(O[0], O[1], lerp(30, 10, k)), 'endBack');
seg(1000, () => at(O[0], O[1], 10));
seg(500, k => at(lerp(O[0], B[0], k), lerp(O[1], B[1], k), 10), 'moveOB');
seg(1000, () => at(B[0], B[1], 10), 'holdB');
seg(1000, k => at(B[0], B[1], lerp(10, -20, k)), 'farTurn');
seg(500, () => at(B[0], B[1], -20), 'farHold');
seg(600, k => at(B[0], B[1], -20, true, lerp(1, 1.6, k)), 'grow');
seg(800, () => at(B[0], B[1], -20, true, 1.6), 'grown');
const END = segT;
const truth = t => { for (const [a, b, fn] of SEG) if (t >= a && t < b) return fn((t - a) / (b - a)); return SEG.at(-1)[2](1); };
const DROPS = [[1550, 1620], [5450, 5560], [13000, 13070]], FLIPS = [[1950, 2060]];
const inWin = (t, wins) => wins.some(([a, b]) => t >= a && t < b);
const wristOf = st => {
  const Ls = L * st.scale, U = [Math.cos(st.roll), Math.sin(st.roll)], V = [-Math.sin(st.roll), Math.cos(st.roll)];
  return [st.x - Ls * (0.75 * U[0] + 0.074 * V[0]), st.y - Ls * (0.75 * U[1] + 0.074 * V[1])];
};
const armAngleOf = st => st.roll + Math.PI + BEND0 + clamp(BEND_K * angDiff(st.roll, ROLL0), -BEND_MAX, BEND_MAX);

function landmarks(st) {
  const Ls = L * st.scale, U = [Math.cos(st.roll), Math.sin(st.roll)], V = [-Math.sin(st.roll), Math.cos(st.roll)], [wx, wy] = wristOf(st);
  const g = [gauss() * 1.2, gauss() * 1.2], out = R() < 0.01 ? [12 * (R() - .5) * 2, 12 * (R() - .5) * 2] : [0, 0];
  return (st.open ? OPEN : FIST).map(([u, v], i) => {
    const sx = wx + Ls * (u * U[0] + v * V[0]) + g[0] + out[0] + gauss() * 1.5, sy = wy + Ls * (u * U[1] + v * V[1]) + g[1] + out[1] + gauss() * 1.5;
    return { x: 0.5 - (sx - W / 2) / MAP.w, y: 0.5 + (sy - H / 2) / MAP.h, z: (i > 4 && i % 4 === 0 ? -0.02 : 0) + gauss() * 0.004 };
  });
}
function poseOf(st) {
  const [wx, wy] = wristOf(st), a = armAngleOf(st), l = ARM_RATIO * L * st.scale * Math.cos(ARM_TILT);
  return [{ wrist: [wx + gauss() * 6, wy + gauss() * 6], elbow: [wx + Math.cos(a) * l + gauss() * 8, wy + Math.sin(a) * l + gauss() * 8], vis: 0.9 }];
}
// 摄像头按 fps 采集：手势识别每帧都有，姿态识别每 3 帧一次、结果更晚到
function makeCaps(fps, latency, spread) {
  const caps = [];
  for (let c = 0, k = 0; c < END; k++, c = k * 1000 / fps + (R() - .5) * 2) {
    const st = truth(c), present = st && !inWin(c, DROPS);
    const handed = inWin(c, FLIPS) ? 'Right' : 'Left';
    caps.push({ c, arrive: c + latency + R() * spread, hands: present ? [{ lm: landmarks(st), handed, score: 0.95 }] : [] });
    if (present && k % 3 === 0) caps.push({ c, arrive: c + latency + 45 + R() * spread * 2, arms: poseOf(st) });
  }
  return caps.sort((a, b) => a.arrive - b.arrive);
}
const CAPS = makeCaps(30, 22, 16);
// 慢电脑：每秒只识别 8 次，结果晚 120ms 左右才到
const SLOW_CAPS = makeCaps(8, 110, 30);
const RENDERS = [];
for (let r = 0, i = 0; r < END; i++, r = i * 1000 / 60 + (R() - .5) * .6) RENDERS.push(r);

// 新算法：js/tracker.js 的 HandTracker + Interaction，和 js/main.js 里的调用方式一致。
// 同时按上一版的做法算一份前臂方向（有新鲜的姿态结果就朝手肘，否则朝手指反方向，再平滑 80ms）拿来对比
function runNew(trackParams = {}, interactParams = {}, caps = CAPS) {
  const tracker = new HandTracker(trackParams), ia = new Interaction(LIFE_RAD, interactParams);
  const rigs = [0, 1].map(() => ({ want: 0, roll: 0, key: null, presence: 0, locked: false, x: 0, y: 0, radius: 100 }));
  const rec = [];
  let ci = 0, prev = 0, prevPose = null, prevPoseAt = -Infinity, prevArm = null;
  for (const r of RENDERS) {
    const dt = Math.min((r - prev) / 1000, 0.05) || 1 / 60; prev = r;
    while (ci < caps.length && caps[ci].arrive <= r) {
      const c = caps[ci++];
      if (c.arms) {
        tracker.ingestArms(c.arms, c.c);
        prevPose = [c.arms[0].elbow[0] - c.arms[0].wrist[0], c.arms[0].elbow[1] - c.arms[0].wrist[1]]; prevPoseAt = r;
      } else tracker.ingest({ ts: c.c, hands: c.hands }, MAP, r);
    }
    const slots = tracker.update(r, dt);
    slots.forEach((s, k) => {
      const g = rigs[k];
      if (s.seen) Object.assign(g, { want: s.open ? 1 : 0, x: s.d.x, y: s.d.y, radius: radiusOf(s.d.len), roll: s.d.roll, key: s.epoch });
      else Object.assign(g, { want: 0, key: null });
    });
    const res = ia.step(dt, rigs);
    const s0 = slots[0], d = s0.d;
    let arm = null, pArm = null, wrist = null;
    if (s0.seen) {
      arm = Math.atan2(d.arm[1], d.arm[0]); wrist = [d.wx, d.wy];
      const tgt = prevPose && r - prevPoseAt < 600 ? Math.atan2(prevPose[1], prevPose[0]) : d.roll + Math.PI;
      prevArm = prevArm === null ? tgt : prevArm + angDiff(tgt, prevArm) * (1 - Math.exp(-dt / 0.08));
      pArm = prevArm;
    }
    rec.push({ r, rigs: rigs.map(g => ({ x: g.x, y: g.y, presence: g.presence, locked: g.locked, radius: g.radius })), t: res.t, target: res.target, arm, pArm, wrist });
  }
  return rec;
}

// 旧算法：照搬最早一版 index.html 的 readHands 和 frame（识别结果在渲染帧里同步处理，OneEuro 用渲染帧间隔，要靠近物品才锁定）
const HAND_CAPS = CAPS.filter(c => c.hands).sort((a, b) => a.c - b.c);
function runOld() {
  const mk = () => ({ seen: false, open: false, fx: new OneEuro(1.2, .02, 1), fy: new OneEuro(1.2, .02, 1), fl: new OneEuro(.8, .005, 1), angle: null, acc: 0, prevF: 0, palm: [0, 0], len: 0, rawAngle: 0 });
  const hands = [mk(), mk()], rigs = [0, 1].map(() => ({ x: 0, y: 0, presence: 0, want: 0, locked: false, radius: 100 }));
  const time = { t: 0, vel: 0 }, rec = [];
  let ci = -1, prev = 0;
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const r of RENDERS) {
    const dt = Math.min((r - prev) / 1000, 0.05) || 1 / 60; prev = r;
    let k = ci; while (k + 1 < HAND_CAPS.length && HAND_CAPS[k + 1].c <= r - 4) k++;
    if (k !== ci) {
      ci = k;
      const byRig = [null, null];
      for (const h of HAND_CAPS[k].hands) { const side = h.handed === 'Right' ? 1 : 0; byRig[byRig[side] ? 1 - side : side] = h.lm; }
      hands.forEach((Hd, i) => {
        const lm = byRig[i];
        if (!lm) { if (Hd.seen) { Hd.fx.reset(); Hd.fy.reset(); Hd.fl.reset(); Hd.angle = null; } Hd.seen = false; return; }
        const S = lm.map(p => [MAP.x(p.x), MAP.y(p.y)]), P = lm.map((p, j) => [S[j][0], -S[j][1], -p.z * MAP.w]);
        const palm = [0, 5, 9, 13, 17].reduce((s, j) => [s[0] + S[j][0] / 5, s[1] + S[j][1] / 5], [0, 0]);
        const len = d3(P[0], P[9]), open = [8, 12, 16, 20].reduce((s, j) => s + d3(P[j], P[0]), 0) / 4 / len;
        Hd.open = Hd.open ? open > 1.25 : open > 1.55; Hd.seen = true;
        Hd.palm = [Hd.fx.filter(palm[0], dt), Hd.fy.filter(palm[1], dt)]; Hd.len = Hd.fl.filter(len, dt);
        Hd.rawAngle = Math.atan2(S[9][1] - S[0][1], S[9][0] - S[0][0]);
      });
    }
    let driveT = 0;
    rigs.forEach((g, i) => {
      const Hd = hands[i];
      if (Hd.seen) {
        g.x = Hd.palm[0]; g.y = Hd.palm[1]; g.radius = clamp(Hd.len * 1.55, 60, Math.min(W, H) * .45); g.want = Hd.open ? 1 : 0;
        if (Hd.angle === null) { Hd.angle = Hd.rawAngle; Hd.acc = 0; Hd.prevF = 0; }
        Hd.acc += angDiff(Hd.rawAngle, Hd.angle); Hd.angle = Hd.rawAngle;
        let d = (Hd.acc - Hd.prevF) * .5; Hd.prevF += d;
        if (Math.abs(d) < .003) d = 0;
        if (Hd.open && g.locked) driveT += d / LIFE_RAD * 2;
        if (!Hd.open) time.vel = 0;
      } else g.want = 0;
      g.locked = g.presence > .5 && Math.hypot(g.x - OBJ.cx, g.y - OBJ.cy) < g.radius + OBJ.size * .25;
    });
    const locked = rigs.some(g => g.locked);
    if (driveT !== 0) { time.t += driveT; time.vel = time.vel + (driveT / dt - time.vel) * .3; }
    else { time.vel = locked ? time.vel * Math.pow(.001, dt) : 0; time.t += time.vel * dt; }
    time.t = clamp(time.t, -1, 1);
    rigs.forEach(g => { g.presence += (g.want - g.presence) * (1 - Math.exp(-(g.want ? 5 : 4) * dt)); });
    rec.push({ r, rigs: rigs.map(g => ({ x: g.x, y: g.y, presence: g.presence, locked: g.locked, radius: g.radius })), t: time.t, target: time.t, arm: null, pArm: null, wrist: null });
  }
  return rec;
}

const mean = a => a.reduce((s, v) => s + v, 0) / Math.max(a.length, 1);
const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
function armMetrics(rec, key) {
  const win = (a, b) => rec.filter(f => f.r >= a && f.r < b && f[key] !== null);
  const err = rows => mean(rows.map(f => Math.abs(todeg(angDiff(f[key], armAngleOf(truth(f.r - 16)))))));
  return {
    armErrRot: err([...win(SEGT.rot60[0] + 100, SEGT.rot60[1]), ...win(SEGT.rotBack[0] + 100, SEGT.rotBack[1])]),
    armErrHold: err([...win(SEGT.hold60[0] + 200, SEGT.hold60[1]), ...win(SEGT.holdBack[0] + 200, SEGT.holdBack[1])]),
  };
}
function metrics(rec) {
  const at = t => rec.reduce((b, f) => (Math.abs(f.r - t) < Math.abs(b.r - t) ? f : b));
  const win = (a, b) => rec.filter(f => f.r >= a && f.r < b);
  const vis = f => (f.rigs[0].presence >= f.rigs[1].presence ? 0 : 1);
  const m = {};
  const still = win(1000, 2400).map(f => f.rigs[0]), sx = mean(still.map(p => p.x)), sy = mean(still.map(p => p.y));
  m.jitter = Math.sqrt(mean(still.map(p => (p.x - sx) ** 2 + (p.y - sy) ** 2)));
  m.dropPresence = Math.min(...DROPS.flatMap(([a, b]) => win(a, b + 150).map(f => f.rigs[vis(f)].presence)));
  // 只有一只手时，第二个法阵（重影）最亮到多少
  m.ghost = Math.max(...win(600, END).map(f => Math.min(f.rigs[0].presence, f.rigs[1].presence)));
  m.engageFar = mean(win(1300, 2400).map(f => (f.rigs[0].locked ? 1 : 0)));
  const lag = (a, b, from, to, ms) => {
    const fr = win(a, b), speed = Math.hypot(to[0] - from[0], to[1] - from[1]) / (ms / 1000);
    const err = fr.map(f => { const tr = truth(f.r - 16); return Math.hypot(f.rigs[vis(f)].x - tr.x, f.rigs[vis(f)].y - tr.y); });
    const steps = fr.slice(1).map((f, i) => Math.hypot(f.rigs[vis(f)].x - fr[i].rigs[vis(fr[i])].x, f.rigs[vis(f)].y - fr[i].rigs[vis(fr[i])].y));
    return { ms: mean(err) / speed * 1000, cv: std(steps) / mean(steps) };
  };
  const slow = lag(2700, 3300, A, O, 1000), fast = lag(22150, 22450, O, B, 500);
  m.lagMs = slow.ms; m.stepCV = slow.cv; m.lagFastMs = fast.ms; m.stepCVFast = fast.cv;
  const u = [(O[0] - A[0]), (O[1] - A[1])], ul = Math.hypot(...u);
  m.overshoot = Math.max(0, ...win(3500, 4000).map(f => ((f.rigs[0].x - O[0]) * u[0] + (f.rigs[0].y - O[1]) * u[1]) / ul));
  m.tAfter60 = at(6900).t; m.tBack = at(9900).t; m.tSlowHalf = at(13500).t - at(10500).t; m.tSlow = at(16900).t;
  const fistRef = at(17150).t;
  m.fistDrift = Math.max(...win(17150, 18250).map(f => Math.abs(f.t - fistRef)));
  m.reopenJump = Math.abs(at(19250).t - fistRef);
  m.tEnd = at(20250).t; m.tEndBack = at(21600).t;
  const final = at(7450).t, hold = win(6500, 7450);
  const settle = hold.findIndex((f, i) => hold.slice(i).every(g => Math.abs(g.t - final) <= 0.01));
  m.settleMs = settle < 0 ? 999 : hold[settle].r - 6500;
  m.holdDrift = Math.max(...win(6800, 7450).map(f => Math.abs(f.t - final)));
  const turn = win(4700, 6400);
  m.reverseFrames = turn.slice(1).filter((f, i) => f.t < turn[i].t - 2e-4).length;
  m.farDelta = at(SEGT.farHold[1] - 50).t - at(SEGT.farTurn[0] - 50).t;
  // 法阵大小：手往镜头前推（手掌变大到 1.6 倍）时，法阵半径落后多少、最后差多少
  const r0 = radiusOf(L), r1 = radiusOf(L * 1.6), grow = win(SEGT.grow[0] + 100, SEGT.grow[1]);
  m.sizeLagMs = mean(grow.map(f => Math.abs(f.rigs[0].radius - radiusOf(L * truth(f.r - 16).scale)))) / ((r1 - r0) / 0.6) * 1000;
  m.sizeErr = mean(win(SEGT.grown[0] + 400, SEGT.grown[1]).map(f => Math.abs(f.rigs[0].radius - r1)));
  const wr = [...win(SEGT.rot60[0] + 100, SEGT.rot60[1]), ...win(SEGT.rotBack[0] + 100, SEGT.rotBack[1])].filter(f => f.wrist);
  m.wristErr = wr.length ? mean(wr.map(f => { const w = wristOf(truth(f.r - 16)); return Math.hypot(f.wrist[0] - w[0], f.wrist[1] - w[1]); })) : null;
  Object.assign(m, rec.some(f => f.arm !== null) ? armMetrics(rec, 'arm') : { armErrRot: null, armErrHold: null });
  return m;
}

const CHECKS = [
  ['jitter', '静止时法阵抖动（像素，RMS）', v => v <= 1.0],
  ['dropPresence', '丢 2–3 帧时法阵亮度最低值', v => v >= 0.9],
  ['ghost', '左右手标签翻转时冒出的第二个法阵亮度', v => v <= 0.05],
  ['engageFar', '离物品很远时，张开手就能控制（时间占比）', v => v >= 0.95],
  ['lagMs', '移动中落后真实手的时间（ms，290px/s）', v => v <= 45],
  ['lagFastMs', '快速移动落后的时间（ms，800px/s）', v => v <= 45],
  ['stepCV', '每帧位移的波动（越小越顺，290px/s）', v => v <= 0.35],
  ['stepCVFast', '每帧位移的波动（800px/s）', v => v <= 0.35],
  ['overshoot', '停下时冲过头（像素）', v => v <= 6],
  ['tAfter60', '顺时针转 60° 后的时间（应为 0.80）', v => Math.abs(v - 0.8) <= 0.04],
  ['tBack', '再转回 60° 后的时间（应回到 0）', v => Math.abs(v) <= 0.05],
  ['tSlowHalf', '每秒 5° 慢转 3 秒走的时间（应为 0.20）', v => Math.abs(v - 0.2) <= 0.05],
  ['tSlow', '慢转 30° 后的时间（应为 0.40）', v => Math.abs(v - 0.4) <= 0.05],
  ['settleMs', '手停下后时间稳住要多久（ms）', v => v <= 300],
  ['holdDrift', '手停下 0.3 秒后时间还在动的量', v => v <= 0.01],
  ['reverseFrames', '单向转动时时间倒退的帧数', v => v <= 2],
  ['fistDrift', '握拳后转手，时间被带动的量', v => v <= 0.01],
  ['reopenJump', '重新张开手时时间跳变', v => v <= 0.01],
  ['tEnd', '转过头时停在尽头（应为 1.00）', v => v >= 0.99],
  ['tEndBack', '尽头往回转 20°（应为 0.73）', v => Math.abs(v - 0.733) <= 0.05],
  ['farDelta', '远离物品时逆时针转 30°（应为 −0.40）', v => Math.abs(v + 0.4) <= 0.05],
  ['sizeLagMs', '手往镜头前推时法阵变大落后的时间（ms）', v => v <= 70],
  ['sizeErr', '推近后法阵大小的误差（像素）', v => v <= 4],
  ['armErrRot', '转手时前臂方向的误差（度）', v => v <= 8],
  ['armErrHold', '手停下后前臂方向的误差（度）', v => v <= 4],
  ['wristErr', '转手时手腕位置的误差（像素）', v => v <= 10],
];
const SLOW = [['dropPresence', '慢电脑：丢帧时法阵亮度最低值', v => v >= 0.9], ['ghost', '慢电脑：重影法阵亮度', v => v <= 0.05],
  ['tAfter60', '慢电脑：转 60° 后的时间', v => Math.abs(v - 0.8) <= 0.05], ['tBack', '慢电脑：转回后的时间', v => Math.abs(v) <= 0.06],
  ['tSlow', '慢电脑：慢转 30° 后', v => Math.abs(v - 0.4) <= 0.06], ['farDelta', '慢电脑：远离物品转 30°', v => Math.abs(v + 0.4) <= 0.06],
  ['sizeErr', '慢电脑：推近后法阵大小误差', v => v <= 6], ['armErrHold', '慢电脑：停下后前臂方向误差', v => v <= 5]];

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const newRec = runNew(), newM = metrics(newRec), oldM = { ...metrics(runOld()), ...armMetrics(newRec, 'pArm') };
  const slowM = metrics(runNew({}, {}, SLOW_CAPS));
  const fmt = v => (v === null || v === undefined ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));
  let fail = 0;
  console.log('指标'.padEnd(30, '　'), '旧版'.padStart(8), '新版'.padStart(8), '  结果');
  for (const [k, name, ok] of CHECKS) {
    const pass = newM[k] !== null && ok(newM[k]); if (!pass) fail++;
    console.log(name.padEnd(30, '　'), fmt(oldM[k]).padStart(8), fmt(newM[k]).padStart(8), pass ? '  通过' : '  不通过');
  }
  for (const [k, name, ok] of SLOW) {
    const pass = slowM[k] !== null && ok(slowM[k]); if (!pass) fail++;
    console.log(name.padEnd(30, '　'), '-'.padStart(8), fmt(slowM[k]).padStart(8), pass ? '  通过' : '  不通过');
  }
  console.log(fail ? `${fail} 项不通过` : '全部通过');
  process.exit(fail ? 1 : 0);
}
export { runNew, runOld, metrics, armMetrics, CHECKS };
