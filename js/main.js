import * as THREE from 'three';
import { HandTracker, Interaction, coverMap, clamp, approach } from './tracker.js';

const params = new URLSearchParams(location.search);
const OBJECT_URL = params.get('object');
const USE_CAM = params.get('nocam') === null;
const GLOW = '#1dff5e', CORE = '#dcffe6';
// 整个生命周期（t 从 -1 到 1）需要手腕转的角度，?deg= 可调
const LIFE_DEG = clamp(+(params.get('deg') || 150), 30, 720), LIFE_RAD = LIFE_DEG * Math.PI / 180;
const $ = id => document.getElementById(id);
const tracker = new HandTracker(), ia = new Interaction(LIFE_RAD);

let bannerSlow = false;
const banner = (msg, link) => {
  const b = $('banner');
  b.textContent = msg;
  if (link) {
    const a = Object.assign(document.createElement('a'), { href: link.href, target: '_blank', rel: 'noopener', textContent: link.text });
    a.style.cssText = 'color:#9dffbe;margin-left:10px;text-decoration:underline';
    b.appendChild(a);
  }
  b.style.display = msg ? 'block' : 'none';
  bannerSlow = false;
};
if (location.protocol === 'file:') banner('当前是双击打开的文件，浏览器不允许调用摄像头。请双击 start.bat，或打开 http://127.0.0.1:8765/');

// ---------- 物品层：每个物品是一个独立页面，嵌入模式下透明叠在摄像头画面上 ----------
let objFrame = null, stages = null, sentT = NaN;
function pushTime(t, force) {
  if (t === sentT && !force) return;
  sentT = t;
  objFrame?.contentWindow?.postMessage({ type: 'timespell:setTime', t }, '*');
}
function objectRect() {
  const s = Math.min(innerWidth, innerHeight) * 0.35;
  return { cx: innerWidth * 0.5, cy: innerHeight * 0.6, size: s };
}
// 物品都是 AI 生成或别人贡献的代码，一律放进不带 allow-same-origin 的沙箱：拿不到本页的存储，读不到 API Key
function setObject(o) {
  objFrame?.remove();
  stages = null;
  objFrame = document.createElement('iframe');
  objFrame.id = 'objFrame';
  objFrame.sandbox = 'allow-scripts';
  objFrame.src = o.src + (o.src.includes('?') ? '&' : '?') + 'embed=1';
  document.body.insertBefore(objFrame, $('gl'));
  objFrame.addEventListener('load', () => pushTime(ia.t, true));
}
addEventListener('message', e => {
  if (e.data?.type === 'timespell:stages' && e.source === objFrame?.contentWindow && Array.isArray(e.data.stages)) stages = e.data.stages.slice(0, 12);
});
const stageAt = t => {
  if (!stages?.length) return null;
  let best = stages[0];
  for (const s of stages) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
};
const stageName = t => String(stageAt(t)?.name ?? '').slice(0, 16);
window.timespell = { setObject, getTime: () => ia.t, stage: () => stageName(ia.t), stageT: () => stageAt(ia.t)?.t ?? 0 };
if (OBJECT_URL) setObject({ src: OBJECT_URL });
else if (!document.querySelector('script[src="studio.js"]')) setObject({ src: 'objects/apple3d.html' });

// ---------- three.js：透视相机，z=0 平面上 1 单位 = 1 CSS 像素 ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
const skel = $('skel'), sctx = skel.getContext('2d');
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.position.set(0, 0, (innerHeight / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.updateProjectionMatrix();
  skel.width = innerWidth; skel.height = innerHeight;
}
addEventListener('resize', resize); resize();
const toWorld = (x, y, z = 0) => new THREE.Vector3(x - innerWidth / 2, innerHeight / 2 - y, z);

// ---------- 纹理绘制：每层先画绿色光晕，再画浅色线芯 ----------
function rng(seed) { return () => (seed = (seed * 16807) % 2147483647) / 2147483647; }
function paint(c, draw, unit) {
  const g = c.getContext('2d');
  g.lineCap = g.lineJoin = 'round';
  for (const pass of ['glow', 'core']) {
    g.save();
    unit(g);
    g.strokeStyle = g.fillStyle = pass === 'glow' ? GLOW : CORE;
    g.shadowColor = GLOW;
    g.shadowBlur = pass === 'glow' ? c.width * .018 : c.width * .005;
    g.globalAlpha = pass === 'glow' ? .55 : 1;
    g.lineWidth = pass === 'glow' ? 0.016 : 0.0055;
    draw(g, pass);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}
function discTexture(draw, size = 1536) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  return paint(c, draw, g => { g.translate(size / 2, size / 2); g.scale(size / 2, size / 2); });
}
const circle = (g, r) => { g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); };
function square(g, r, rot) {
  g.beginPath();
  for (let i = 0; i <= 4; i++) { const a = rot + Math.PI / 4 + i * Math.PI / 2; i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.stroke();
}
function glyph(g, x, y, s, rand) {
  const pts = []; for (let i = 0; i < 9; i++) pts.push([(i % 3 - 1) * s, (Math.floor(i / 3) - 1) * s * 1.3]);
  g.beginPath();
  let p = pts[Math.floor(rand() * 9)]; g.moveTo(x + p[0], y + p[1]);
  for (let k = 2 + Math.floor(rand() * 3); k >= 0; k--) { p = pts[Math.floor(rand() * 9)]; g.lineTo(x + p[0], y + p[1]); }
  g.stroke();
  if (rand() < .3) { g.beginPath(); g.arc(x, y - s * 1.7, s * .22, 0, Math.PI * 2); g.stroke(); }
}
function glyphBand(g, r0, r1, n, seed) {
  circle(g, r0); circle(g, r1);
  const rand = rng(seed), s = (r1 - r0) * .26, rm = (r0 + r1) / 2;
  for (let i = 0; i < n; i++) { g.save(); g.rotate(i / n * Math.PI * 2); glyph(g, 0, -rm, s, rand); g.restore(); }
}

// 主盘四层：外圈符文带 / 双方形八角星 / 内圈符文带 / 内星与圆心。
// 每层的角度 = 自转（idle，rad/s）× 时间 + 齿轮比（gear）× 拨盘角度：手转多少，外圈就跟着转多少，里面几层按比例联动
const DISC_LAYERS = [
  { idle: .06, gear: 1, tex: discTexture(g => { glyphBand(g, .9, .985, 54, 11); }) },
  { idle: -.05, gear: -.6, tex: discTexture(g => { circle(g, .86); square(g, .86, 0); square(g, .86, Math.PI / 4); }) },
  { idle: .1, gear: 1.7, tex: discTexture(g => { glyphBand(g, .56, .64, 30, 23); }) },
  { idle: -.16, gear: -2.8, tex: discTexture(g => {
      square(g, .52, 0); square(g, .52, Math.PI / 4); circle(g, .22); circle(g, .15);
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; g.beginPath(); g.moveTo(Math.cos(a) * .15, Math.sin(a) * .15); g.lineTo(Math.cos(a) * .22, Math.sin(a) * .22); g.stroke(); }
    }) },
];
function radialTexture(stops, size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const FILL_TEX = radialTexture([[0, 'rgba(40,255,110,.28)'], [.55, 'rgba(30,255,95,.14)'], [.96, 'rgba(30,255,95,.2)'], [1, 'rgba(30,255,95,0)']], 512);
const KNOB_TEX = radialTexture([[0, 'rgba(255,255,255,1)'], [.18, 'rgba(220,255,230,.95)'], [.4, 'rgba(60,255,120,.35)'], [1, 'rgba(30,255,95,0)']]);

// 前臂符文环：圆柱侧面贴图，上下边线 + 符文 + 链状交叉纹
function bandTexture(seed, lattice) {
  const W = 2048, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  return paint(c, g => {
    const rand = rng(seed);
    g.beginPath(); g.moveTo(0, .1); g.lineTo(W / H, .1); g.moveTo(0, .9); g.lineTo(W / H, .9); g.stroke();
    const n = lattice ? 28 : 26, w = (W / H) / n;
    if (lattice) { g.beginPath(); for (let i = 0; i < n; i++) { g.moveTo(i * w, .2); g.lineTo((i + 1) * w, .8); g.moveTo(i * w, .8); g.lineTo((i + 1) * w, .2); } g.stroke(); }
    else for (let i = 0; i < n; i++) glyph(g, (i + .5) * w, .52, .1, rand);
  }, g => g.scale(H, H));
}
const BAND_TEX = [bandTexture(5, false), bandTexture(9, true), bandTexture(13, false)];
const additive = (map, extra = {}) => new THREE.MeshBasicMaterial({ map, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, ...extra });

// 生命周期刻度：正上方是“现在”，顺时针是未来、逆时针是过去，两端是尽头；亮弧是已经拨过的部分。
// 用着色器按角度画，拨动时不用每帧重建几何体
const TRACK_R = [1.03, 1.075];
function trackMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uHalf: { value: LIFE_RAD / 2 }, uOpacity: { value: 1 }, uLock: { value: 0 }, uGlow: { value: new THREE.Color(GLOW) }, uCore: { value: new THREE.Color(CORE) } },
    vertexShader: 'varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uT, uHalf, uOpacity, uLock; uniform vec3 uGlow, uCore; varying vec2 vP;
      void main() {
        float r = length(vP), a = atan(vP.x, vP.y);
        float band = smoothstep(${TRACK_R[0]}, ${TRACK_R[0]} + .012, r) * (1. - smoothstep(${TRACK_R[1]} - .012, ${TRACK_R[1]}, r));
        float inRange = step(abs(a), uHalf), cur = uT * uHalf;
        float filled = step(min(0., cur), a) * step(a, max(0., cur));
        float ticks = min(1., (1. - smoothstep(0., .014, abs(abs(a) - uHalf))) + (1. - smoothstep(0., .01, abs(a))));
        float alpha = band * (inRange * (.16 + .14 * uLock) + filled * (.55 + .3 * uLock) + ticks * .7);
        gl_FragColor = vec4(mix(uGlow, uCore, filled), alpha * uOpacity);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}
const PLANE = new THREE.PlaneGeometry(2, 2), TRACK_GEO = new THREE.RingGeometry(TRACK_R[0] - .01, TRACK_R[1] + .01, 256, 1);
const BAND_GEO = new THREE.CylinderGeometry(1, 1, .16, 96, 1, true);

function makeRig() {
  const root = new THREE.Group(), disc = new THREE.Group();
  const fill = new THREE.Mesh(new THREE.CircleGeometry(1, 96), additive(FILL_TEX));
  const layers = DISC_LAYERS.map(L => { const m = new THREE.Mesh(PLANE, additive(L.tex)); m.userData = L; return m; });
  const track = new THREE.Mesh(TRACK_GEO, trackMaterial());
  const knob = new THREE.Mesh(PLANE, additive(KNOB_TEX));
  disc.add(fill, ...layers, track, knob);
  root.add(disc);
  const rings = [[.25, .5, 0], [.55, .55, 1], [.85, .6, 2]].map(([along, rad, ti], i) => {
    const m = new THREE.Mesh(BAND_GEO, additive(BAND_TEX[ti]));
    m.userData = { along, rad, idle: i % 2 ? -.8 : .6, gear: [2.2, -2.6, 3][i] };
    root.add(m); return m;
  });
  root.visible = false;
  scene.add(root);
  return { root, disc, fill, layers, track, knob, rings, quat: new THREE.Quaternion(), lock: 0, flash: 0, summoned: false,
    want: 0, presence: 0, locked: false, x: innerWidth / 2, y: innerHeight / 2, radius: 120, roll: 0, key: null,
    hand: false, handLen: 80, n: [0, 0, 1], arm: [0, 1], armLen: 180, armOk: false, wx: 0, wy: 0 };
}
const rigs = [makeRig(), makeRig()];

// 锁定标记：法阵锁定物品时，物品外围亮起一圈反向转动的符文
const objRing = new THREE.Group();
const objRingA = new THREE.Mesh(PLANE, additive(DISC_LAYERS[0].tex)), objRingB = new THREE.Mesh(PLANE, additive(DISC_LAYERS[2].tex));
objRing.add(objRingA, objRingB); objRing.visible = false; scene.add(objRing);
let lockGlow = 0;

// ---------- 火花粒子（三维，落在法阵平面上沿切向飞出） ----------
const MAXP = 900;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(MAXP * 3), pAlpha = new Float32Array(MAXP), pVel = new Float32Array(MAXP * 3), pLife = new Float32Array(MAXP);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('alpha', new THREE.BufferAttribute(pAlpha, 1));
const pMat = new THREE.ShaderMaterial({
  uniforms: { color: { value: new THREE.Color(CORE).lerp(new THREE.Color(GLOW), .4) }, px: { value: renderer.getPixelRatio() } },
  vertexShader: `attribute float alpha; varying float vA; uniform float px;
    void main(){ vA = alpha; gl_PointSize = (1.5 + 3.5 * alpha) * px; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform vec3 color; varying float vA;
    void main(){ float d = length(gl_PointCoord - .5); if (d > .5) discard; gl_FragColor = vec4(color, vA * smoothstep(.5, 0., d)); }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
scene.add(new THREE.Points(pGeo, pMat));
let pNext = 0;
const _ax = new THREE.Vector3(), _ay = new THREE.Vector3();
// cw：1 顺时针（时间往前），-1 逆时针
function spawn(r, n, speed, cw) {
  _ax.set(1, 0, 0).applyQuaternion(r.quat); _ay.set(0, 1, 0).applyQuaternion(r.quat);
  const c = r.disc.position;
  for (let k = 0; k < n; k++) {
    const i = pNext = (pNext + 1) % MAXP, a = Math.random() * Math.PI * 2, rr = r.radius * (.86 + Math.random() * .14);
    const ca = Math.cos(a), sa = Math.sin(a), sp = 30 + Math.random() * 110 + speed * 140;
    const ox = _ax.x * ca + _ay.x * sa, oy = _ax.y * ca + _ay.y * sa, oz = _ax.z * ca + _ay.z * sa;
    const tx = _ax.x * sa - _ay.x * ca, ty = _ax.y * sa - _ay.y * ca, tz = _ax.z * sa - _ay.z * ca;
    pPos[i * 3] = c.x + ox * rr; pPos[i * 3 + 1] = c.y + oy * rr; pPos[i * 3 + 2] = c.z + oz * rr;
    pVel[i * 3] = tx * sp * cw + ox * 25; pVel[i * 3 + 1] = ty * sp * cw + oy * 25; pVel[i * 3 + 2] = tz * sp * cw + oz * 25;
    pLife[i] = .4 + Math.random() * .8;
  }
}
function stepParticles(dt) {
  const damp = Math.pow(.95, dt * 60);
  for (let i = 0; i < MAXP; i++) {
    if (pLife[i] <= 0) { pAlpha[i] = 0; continue; }
    pLife[i] -= dt;
    for (let j = 0; j < 3; j++) { pPos[i * 3 + j] += pVel[i * 3 + j] * dt; pVel[i * 3 + j] *= damp; }
    pAlpha[i] = Math.max(pLife[i], 0) * 1.3;
  }
  pGeo.attributes.position.needsUpdate = pGeo.attributes.alpha.needsUpdate = true;
}

// ---------- 摄像头 ----------
const video = $('cam');
let camOk = false, camLabel = '', handStatus = USE_CAM ? '启动中' : '已关闭';
const VIRTUAL_CAM = /todesk|virtual|obs|droidcam|screen|manycam|xsplit|nvidia broadcast|向日葵|sunlogin/i;
const camSelect = $('camSel');
async function openCamera(deviceId) {
  video.srcObject?.getTracks().forEach(t => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) } });
  video.srcObject = stream;
  await video.play();
  camLabel = stream.getVideoTracks()[0]?.label || '';
  return stream.getVideoTracks()[0]?.getSettings().deviceId;
}
// 远程桌面类软件（ToDesk 等）会注册虚拟摄像头，浏览器可能默认选中它：自动换成真实摄像头，并提供下拉框手选
async function pickCamera() {
  let saved = null; try { saved = localStorage.getItem('timespell.cam'); } catch {}
  let current = await openCamera(saved || undefined).catch(() => openCamera());
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  if (!saved && VIRTUAL_CAM.test(camLabel)) {
    const real = cams.find(d => !VIRTUAL_CAM.test(d.label));
    if (real) current = await openCamera(real.deviceId);
  }
  camSelect.innerHTML = cams.map((d, i) => `<option value="${d.deviceId}">${(d.label || '摄像头 ' + (i + 1)).replace(/</g, '&lt;')}</option>`).join('');
  camSelect.value = current;
  camSelect.hidden = cams.length < 2;
  camSelect.onchange = async () => {
    try { localStorage.setItem('timespell.cam', camSelect.value); } catch {}
    try { await openCamera(camSelect.value); banner(''); } catch (e) { banner(`切换摄像头失败：${e.name}，可能被其他程序占用`); }
  };
  if (VIRTUAL_CAM.test(camLabel)) banner(`当前是虚拟摄像头「${camLabel}」，画面可能是黑的。请在左下角换成真实摄像头，或在 ToDesk 设置里关闭虚拟摄像头。`);
}
async function startCamera() {
  // 摄像头和模型分开启动：模型失败也能看到画面
  try {
    handStatus = '请求摄像头';
    await pickCamera();
    camOk = true;
  } catch (err) {
    const why = { NotAllowedError: '摄像头权限被拒绝，请点地址栏左侧的图标允许摄像头后刷新',
      NotReadableError: '摄像头被其他程序占用（ToDesk、微信视频、会议软件等），关掉后刷新',
      NotFoundError: '没有检测到摄像头' }[err.name] || `摄像头启动失败：${err.name} ${err.message}`;
    // 嵌在别的网页里（比如魔搭创空间的页面）时，外层可能不允许 iframe 用摄像头：给一个新窗口打开的入口
    const framed = window.self !== window.top && ['NotAllowedError', 'SecurityError'].includes(err.name);
    banner(why + '。当前可用鼠标 + 滚轮体验。', framed ? { href: location.href, text: '在新窗口打开就能用摄像头' } : null);
    handStatus = '摄像头不可用'; video.style.display = 'none';
    return;
  }
  startDetector();
}

// ---------- 识别：优先放在后台线程（Worker），不支持时退回主线程 ----------
const det = { mode: '', delegate: '', ready: false, busy: false, worker: null, hand: null, poser: null, vw: 16, vh: 9, bench: Infinity,
  sentAt: 0, pumping: false, lastTs: 0, n: 0, cost: 0, latency: 0, rate: 0, count: 0, rateAt: performance.now(),
  sent: 0, got: 0, dropped: 0, t0: 0, readyMs: 0, gpuMs: 0, poseMs: 0 };
// 手臂（姿态）识别单独一个 GPU 线程：每 3 帧、看到手时才识别，只用来摆前臂环，不拖慢手的识别
const poseDet = { ready: false, busy: false, worker: null, n: 0, sentAt: 0 };
const LOCAL_MP = new URL('../vendor/mediapipe/', import.meta.url).href, CDN_MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/';
const HAND_MODELS = [
  { base: LOCAL_MP, hand: LOCAL_MP + 'hand_landmarker.task', local: true },
  { base: CDN_MP, hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task', local: false },
];
const POSE_MODELS = [{ base: LOCAL_MP, pose: LOCAL_MP + 'pose_landmarker_lite.task', local: true }];

// 起一个识别线程，预热完成后给出 { w, delegate, bench }（bench：预热后单帧耗时 ms）
function spawnWorker(candidates, delegate) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./detector-worker.js', import.meta.url));
    const fail = err => { w.terminate(); reject(err); };
    w.onerror = e => fail(new Error(e.message || '识别线程启动失败'));
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'error') fail(new Error(m.message));
      else if (m.type === 'ready') resolve({ w, delegate: m.delegate, bench: m.bench });
    };
    w.postMessage({ type: 'init', candidates, delegate });
  });
}
function withTimeout(promise, ms, msg) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
    .catch(err => { promise.then(info => info.w.terminate(), () => {}); throw err; });
}
function updateStatus() {
  handStatus = '就绪 ' + (det.mode === 'worker' ? '后台' : '主线程') + ' ' + det.delegate + (poseDet.ready || det.poser ? ' + 手臂' : '');
}
function useWorker(info) {
  const old = det.worker;
  Object.assign(det, { mode: 'worker', worker: info.w, delegate: info.delegate, bench: info.bench, ready: true, busy: false });
  info.w.onerror = e => console.error('识别线程出错', e.message);
  info.w.onmessage = ev => {
    if (ev.data.type !== 'result' || ev.target !== det.worker) return;
    det.busy = false; det.got++;
    if (ev.data.error) return console.warn('识别出错', ev.data.error);
    handleResult(ev.data.ts, ev.data.hands || [], ev.data.cost);
  };
  if (old && old !== info.w) old.terminate();
  updateStatus();
}
// 先起 CPU 线程，马上能用；再起 GPU 线程预热（编译着色器，第一次可能要十几秒，浏览器缓存后会快很多），
// 好了而且比 CPU 实际跑起来快就换过去，40 秒还没好就放弃。手的 GPU 线程就绪后再起手臂识别线程
async function startWorkers(only) {
  const first = only || 'CPU';
  det.t0 = performance.now();
  try { useWorker(await spawnWorker(HAND_MODELS, first)); det.readyMs = performance.now() - det.t0; }
  catch (err) { if (only) throw err; console.warn('CPU 识别线程不可用：', err.message); }
  if (only === 'CPU') return;
  if (det.delegate === 'GPU') { startPose(); return; }
  const upgrade = withTimeout(spawnWorker(HAND_MODELS, 'GPU'), 40000, 'GPU 预热超过 40 秒').then(info => {
    const cpuCost = det.cost > 0 ? det.cost : det.bench;
    if (!det.ready || info.bench < cpuCost * 0.8) { useWorker(info); det.gpuMs = performance.now() - det.t0; startPose(); }
    else { console.info(`GPU 单帧 ${info.bench.toFixed(0)}ms，不比 CPU 的 ${cpuCost.toFixed(0)}ms 快，继续用 CPU`); info.w.terminate(); }
  }, err => console.warn('GPU 识别线程不用了：', err.message));
  if (!det.ready) await upgrade;
  if (!det.ready) throw new Error('识别线程都没能启动');
}
async function startPose() {
  if (poseDet.worker) return;
  try {
    const info = await withTimeout(spawnWorker(POSE_MODELS, 'GPU'), 40000, '手臂识别预热超过 40 秒');
    Object.assign(poseDet, { worker: info.w, ready: true });
    det.poseMs = performance.now() - det.t0;
    info.w.onmessage = ev => {
      if (ev.data.type !== 'result') return;
      poseDet.busy = false;
      if (ev.data.pose && !ev.data.error) handlePose(ev.data.pose, ev.data.ts);
    };
    updateStatus();
  } catch (err) { console.warn('手臂识别不可用，前臂环按手的方向估算：', err.message); }
}
async function startMainThread() {
  let lastErr;
  for (const c of HAND_MODELS) {
    try {
      const mp = await import(c.base + 'vision_bundle.mjs');
      const fs = await mp.FilesetResolver.forVisionTasks(c.base + 'wasm');
      const make = (Task, model, delegate, extra) => Task.createFromOptions(fs, { baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO', ...extra });
      const opts = { numHands: 2, minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5 };
      det.delegate = 'GPU';
      try { det.hand = await make(mp.HandLandmarker, c.hand, 'GPU', opts); } catch { det.delegate = 'CPU'; det.hand = await make(mp.HandLandmarker, c.hand, 'CPU', opts); }
      if (c.local) try { det.poser = await make(mp.PoseLandmarker, POSE_MODELS[0].pose, det.delegate, { numPoses: 1 }); } catch { det.poser = null; }
      Object.assign(det, { mode: 'main', ready: true });
      updateStatus();
      return;
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}
async function startDetector(only = params.get('delegate')?.toUpperCase()) {
  handStatus = '加载手势模型';
  const slow = setTimeout(() => {
    if (det.ready) return;
    banner('手势模型加载很慢（国内常见）。请运行 python download_models.py 把模型下载到本地后刷新；现在可先用鼠标 + 滚轮。');
    bannerSlow = true;
  }, 20000);
  try {
    if (params.get('detector') !== 'main' && typeof Worker === 'function' && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
      await startWorkers(only).catch(err => console.warn('后台线程识别不可用，改在主线程识别：', err.message));
    }
    if (!det.ready) await startMainThread();
    if (bannerSlow) banner('');
    if (!det.pumping) { det.pumping = true; pumpFrames(); }
  } catch (err) {
    console.error(err);
    banner(`手势模型加载失败（${err.message || err}）。请运行 python download_models.py 把模型下载到本地后刷新；现在可先用鼠标 + 滚轮。`);
    handStatus = '模型失败';
  } finally { clearTimeout(slow); }
}
// 看门狗：识别线程 3 秒没回应（个别显卡驱动会卡住），手的识别换成只用 CPU 重来，手臂识别直接关掉
function watchdog(now) {
  if (poseDet.busy && now - poseDet.sentAt > 3000) {
    console.warn('手臂识别线程 3 秒没有回应，关掉');
    poseDet.worker?.terminate();
    Object.assign(poseDet, { ready: false, busy: false, worker: null });
    updateStatus();
  }
  if (det.mode !== 'worker' || !det.busy || now - det.sentAt < 3000) return;
  console.warn('识别线程 3 秒没有回应，换 CPU 重启');
  det.worker?.terminate();
  Object.assign(det, { ready: false, busy: false, worker: null, mode: '' });
  startDetector('CPU');
}
// 每来一帧摄像头画面就送去识别；上一帧还没识别完就丢掉这一帧，不排队，延迟不会越积越大
function pumpFrames() {
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const cb = (now, meta) => { onVideoFrame(meta.captureTime || now); video.requestVideoFrameCallback(cb); };
    video.requestVideoFrameCallback(cb);
  } else {
    let last = -1;
    const poll = () => { if (video.currentTime !== last) { last = video.currentTime; onVideoFrame(performance.now()); } requestAnimationFrame(poll); };
    poll();
  }
}
function sendFrame(target, ts) {
  target.busy = true;
  const k = Math.min(1, 640 / det.vw);
  createImageBitmap(video, { resizeWidth: Math.round(det.vw * k), resizeHeight: Math.round(det.vh * k), resizeQuality: 'low' })
    .then(bitmap => { target.sentAt = performance.now(); target.worker.postMessage({ type: 'frame', ts, bitmap }, [bitmap]); })
    .catch(() => { target.busy = false; });
}
function onVideoFrame(capTs) {
  if (!det.ready || video.readyState < 2 || !video.videoWidth) return;
  let ts = Math.round(capTs);
  if (ts <= det.lastTs) ts = det.lastTs + 1;
  det.lastTs = ts; det.vw = video.videoWidth; det.vh = video.videoHeight;
  const seen = tracker.slots.some(s => s.seen);
  if (det.mode === 'worker') {
    if (det.busy) det.dropped++; else { det.sent++; sendFrame(det, ts); }
    if (poseDet.ready && !poseDet.busy && seen && poseDet.n++ % 3 === 0) sendFrame(poseDet, ts);
    return;
  }
  const t0 = performance.now(), r = det.hand.detectForVideo(video, ts), hd = r.handedness || r.handednesses || [];
  const hands = (r.landmarks || []).map((lm, i) => ({ lm, handed: hd[i]?.[0]?.categoryName || '', score: hd[i]?.[0]?.score ?? 1 }));
  handleResult(ts, hands, performance.now() - t0);
  if (det.poser && seen && det.n++ % 3 === 0) {
    const p = det.poser.detectForVideo(video, ts).landmarks?.[0];
    if (p) handlePose([[15, 13], [16, 14]].map(([w, e]) => ({ wrist: [p[w].x, p[w].y], elbow: [p[e].x, p[e].y], vis: Math.min(p[w].visibility ?? 1, p[e].visibility ?? 1) })), ts);
  }
}
function handleResult(ts, hands, cost) {
  tracker.ingest({ ts, hands }, coverMap(innerWidth, innerHeight, det.vw, det.vh), performance.now());
  det.cost += (cost - det.cost) * .1;
  det.latency += (performance.now() - ts - det.latency) * .1;
  det.count++;
}
function handlePose(arms, ts) {
  const map = coverMap(innerWidth, innerHeight, det.vw, det.vh);
  tracker.ingestArms(arms.map(a => ({ wrist: [map.x(a.wrist[0]), map.y(a.wrist[1])], elbow: [map.x(a.elbow[0]), map.y(a.elbow[1])], vis: a.vis })), ts);
}
if (USE_CAM && location.protocol !== 'file:') startCamera(); else video.style.display = 'none';

// ---------- 声音：背景乐 + 实时合成音效。浏览器要求先有一次点击/按键 ----------
// 仓库不带背景乐（版权原因）。把自己的音乐放到下面的路径就会自动用上；没有的话用原创的合成氛围音
const BGM_FILES = ['assets/audio/bgm_a.mp3', 'assets/audio/bgm_b.mp3'];
const audio = { ctx: null, on: false, muted: false, tracks: null, track: 0, tickIdx: 0, tickAt: 0 };
const soundEl = $('sound');
function noiseBuffer(ctx, sec) {
  const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
// 合成氛围音：D 小调铺底（成对微失谐），低通缓慢扫频，加一路回声
function buildPad(ctx, out) {
  const g = ctx.createGain(); g.gain.value = 0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = .8;
  const lfo = ctx.createOscillator(); lfo.frequency.value = .04;
  const depth = ctx.createGain(); depth.gain.value = 400; lfo.connect(depth).connect(lp.frequency); lfo.start();
  [73.42, 110, 146.83, 174.61, 220, 293.66].forEach((f, i) => [-7, 7].forEach(cents => {
    const o = ctx.createOscillator(); o.type = i < 3 ? 'sawtooth' : 'triangle';
    o.frequency.value = f; o.detune.value = cents;
    const v = ctx.createGain(); v.gain.value = .035 / (1 + i * .4);
    o.connect(v).connect(lp); o.start();
  }));
  const delay = ctx.createDelay(1); delay.delayTime.value = .42;
  const fb = ctx.createGain(); fb.gain.value = .38;
  lp.connect(g); g.connect(out); g.connect(delay); delay.connect(fb).connect(delay); delay.connect(out);
  return g;
}
function trackName() { const s = audio.tracks?.[audio.track]; return !s ? '' : s === 'pad' ? '合成氛围' : '曲目 ' + (audio.track + 1); }
function soundText() { return audio.muted ? '已静音 · M 恢复' : `声音开 · ${trackName()} · M 静音 · B 换背景乐`; }
function playTrack() {
  const src = audio.tracks[audio.track], now = audio.ctx.currentTime;
  audio.pad.gain.setTargetAtTime(src === 'pad' ? .55 : 0, now, src === 'pad' ? 1.5 : .2);
  if (src === 'pad') audio.el.pause();
  else { audio.el.src = src; audio.el.play().catch(e => console.warn('背景乐播放失败', e)); }
  soundEl.textContent = soundText();
}
function initAudio() {
  if (audio.ctx) return;
  // AudioContext 必须在点击/按键的同步阶段创建，否则浏览器不让出声
  const ctx = audio.ctx = new AudioContext();
  const master = audio.master = ctx.createGain(); master.gain.value = .9; master.connect(ctx.destination);
  // 背景乐过低通：法阵出现时变亮，锁定物体时完全打开
  audio.bgmLP = ctx.createBiquadFilter(); audio.bgmLP.type = 'lowpass'; audio.bgmLP.frequency.value = 900;
  const bg = ctx.createGain(); bg.gain.value = .4;
  audio.bgmLP.connect(bg).connect(master);
  audio.el = new Audio(); audio.el.loop = true;
  ctx.createMediaElementSource(audio.el).connect(audio.bgmLP);
  audio.pad = buildPad(ctx, audio.bgmLP);
  // 法阵嗡鸣：三个低频正弦 + 带通噪声，音量跟法阵存在感走
  audio.hum = ctx.createGain(); audio.hum.gain.value = 0; audio.hum.connect(master);
  [[55, .5], [82.4, .3], [110.3, .15]].forEach(([f, v]) => { const o = ctx.createOscillator(); o.frequency.value = f; const g = ctx.createGain(); g.gain.value = v; o.connect(g).connect(audio.hum); o.start(); });
  audio.noise = noiseBuffer(ctx, 2);
  const n = ctx.createBufferSource(); n.buffer = audio.noise; n.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 3;
  const ng = ctx.createGain(); ng.gain.value = .12; n.connect(bp).connect(ng).connect(audio.hum); n.start();
  audio.on = true;
  soundEl.textContent = '声音开';
  // 直接试着播背景乐文件，放不了（不存在或格式不支持）就从列表里去掉；合成氛围音永远排在最后
  audio.tracks = [...BGM_FILES, 'pad'];
  audio.el.addEventListener('error', () => {
    if (audio.tracks[audio.track] === 'pad') return;
    audio.tracks.splice(audio.track, 1);
    audio.track = Math.min(audio.track, audio.tracks.length - 1);
    playTrack();
  });
  audio.track = Math.min(+(params.get('bgm') || 0) || 0, audio.tracks.length - 1);
  audio.tickIdx = Math.round(ia.t * LIFE_DEG / 6);
  playTrack();
}
function tone(freq, type, gain, start, decay, dest = audio.master) {
  const ctx = audio.ctx, o = ctx.createOscillator(), e = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  e.gain.setValueAtTime(0, start); e.gain.linearRampToValueAtTime(gain, start + .01); e.gain.exponentialRampToValueAtTime(.0005, start + decay);
  o.connect(e).connect(dest); o.start(start); o.stop(start + decay + .05);
}
function sfxSummon() {
  const ctx = audio.ctx, t0 = ctx.currentTime;
  const n = ctx.createBufferSource(); n.buffer = audio.noise;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
  bp.frequency.setValueAtTime(300, t0); bp.frequency.exponentialRampToValueAtTime(4000, t0 + .7);
  const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.35, t0 + .15); g.gain.exponentialRampToValueAtTime(.001, t0 + .9);
  n.connect(bp).connect(g).connect(audio.master); n.start(t0); n.stop(t0 + 1);
  [523.25, 783.99, 1046.5, 1567.98].forEach((f, i) => tone(f, 'sine', .07, t0 + .12 + i * .06, 2.2));
}
// 拨盘每转过 3° 响一下，像转动带棘轮的旋钮：往未来调高，往过去调低
function sfxTick(forward) {
  const ctx = audio.ctx, t0 = ctx.currentTime;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 800; hp.connect(audio.master);
  tone(forward ? 2400 : 1500, 'triangle', .1, t0, .05, hp);
}
function sfxEngage() { const t0 = audio.ctx.currentTime; tone(1318.5, 'sine', .08, t0, .35); tone(1975.5, 'sine', .05, t0 + .05, .4); tone(110, 'sine', .15, t0, .25); }
function sfxGong() { const t0 = audio.ctx.currentTime; [98, 196.6, 293.1, 392.9].forEach((f, i) => tone(f, 'sine', .18 / (i + 1), t0, 3.5)); }
function updateAudio(res) {
  if (!audio.on) return;
  const now = audio.ctx.currentTime, pres = Math.max(...rigs.map(r => r.presence)), locked = rigs.some(r => r.locked);
  audio.hum.gain.setTargetAtTime(pres * (locked ? .09 : .05) * (1 + Math.min(Math.abs(res.speed), 2) * .3), now, .1);
  audio.bgmLP.frequency.setTargetAtTime(locked ? 9000 : pres > .5 ? 2500 : 900, now, .3);
  const idx = Math.round(res.t * LIFE_DEG / 6);
  if (idx !== audio.tickIdx && now - audio.tickAt > .025) { sfxTick(idx > audio.tickIdx); audio.tickIdx = idx; audio.tickAt = now; }
  rigs.forEach(r => {
    if (r.want && r.presence > .15 && !r.summoned) { r.summoned = true; sfxSummon(); }
    if (r.presence < .05) r.summoned = false;
  });
  if (res.engaged) sfxEngage();
  if (res.endHit) sfxGong();
}

// ---------- 输入 ----------
const mouse = { x: innerWidth / 2, y: innerHeight * .4, inside: false, wheel: 0, last: -1e9 };
addEventListener('pointermove', e => Object.assign(mouse, { x: e.clientX, y: e.clientY, inside: true, last: performance.now() }));
document.addEventListener('pointerleave', () => { mouse.inside = false; });
addEventListener('wheel', e => { mouse.wheel += e.deltaY * (e.deltaMode === 1 ? 33 : 1); mouse.last = performance.now(); e.preventDefault(); }, { passive: false });
let showDbg = params.has('debug'), skelDirty = false;
addEventListener('pointerdown', initAudio);
addEventListener('keydown', e => {
  initAudio();
  const k = e.key.toLowerCase();
  if (k === 'd') showDbg = !showDbg;
  if (k === 'm') { audio.muted = !audio.muted; audio.master.gain.value = audio.muted ? 0 : .9; soundEl.textContent = soundText(); }
  if (k === 'b' && audio.tracks) { audio.track = (audio.track + 1) % audio.tracks.length; playTrack(); }
});
const MOUSE_N = [0, Math.sin(.45), Math.cos(.45)], MOUSE_ARM = [.33, .94];

// ---------- 画法阵 ----------
const Z = new THREE.Vector3(0, 0, 1), Y = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _arm = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _tilt = new THREE.Quaternion(), _spinQ = new THREE.Quaternion();
// 法阵跟着掌面倾斜（缩小到 80%，最多约 55°），但平面里的“正上方”固定朝屏幕上方：刻度的零点（现在）始终在顶上
function orient(r, dt, snap) {
  _n.set(r.n[0], r.n[1], r.n[2]);
  const ang = Math.min(Math.acos(clamp(_n.z, -1, 1)) * .8, .95);
  _x.crossVectors(Z, _n);
  if (_x.lengthSq() < 1e-8) _n.copy(Z); else _n.copy(Z).applyQuaternion(_tilt.setFromAxisAngle(_x.normalize(), ang));
  _y.copy(Y).addScaledVector(_n, -_n.y).normalize();
  _x.crossVectors(_y, _n);
  _q.setFromRotationMatrix(_m.makeBasis(_x, _y, _n));
  if (snap) r.quat.copy(_q); else r.quat.slerp(_q, 1 - Math.exp(-dt / .05));
}
let speedVis = 0;
function drawRigs(now, dt, res, obj) {
  const el = now / 1000, dial = res.t * LIFE_RAD / 2, cw = res.speed >= 0 ? 1 : -1;
  speedVis = approach(speedVis, Math.abs(res.speed), dt, .15);
  if (res.engaged && rigs[ia.owner]) rigs[ia.owner].flash = 1;
  if (res.endHit) rigs.forEach(r => { if (r.locked) r.flash = 1; });
  for (const r of rigs) {
    const appear = 1 - Math.pow(1 - r.presence, 3);
    r.root.visible = r.presence > .01;
    if (!r.root.visible) continue;
    r.lock = approach(r.lock, r.locked ? 1 : 0, dt, .12);
    r.flash = Math.max(0, r.flash - dt * 2.5);
    const bright = (.85 + .3 * r.lock) * appear + r.flash * .5;
    orient(r, dt, r.presence < .05);
    r.disc.position.copy(toWorld(r.x, r.y));
    r.disc.quaternion.copy(r.quat);
    r.disc.scale.setScalar(r.radius * (.55 + .45 * appear));
    r.fill.material.opacity = bright * .9;
    r.layers.forEach((m, i) => {
      const L = m.userData;
      m.rotation.z = L.idle * el - L.gear * dial;
      m.material.opacity = bright * clamp(r.presence * 4 - i * .55, 0, 1);   // 由外向内依次点亮
    });
    const u = r.track.material.uniforms;
    u.uT.value = res.t; u.uOpacity.value = bright; u.uLock.value = r.lock;
    r.knob.position.set(Math.sin(dial) * 1.0525, Math.cos(dial) * 1.0525, .001);
    r.knob.scale.setScalar(.075 * (1 + r.flash * .8 + r.lock * .25));
    r.knob.material.opacity = bright;
    // 前臂环：屏幕坐标的前臂方向转成世界坐标（y 取反），再往镜头外偏一点，圆柱就呈椭圆环套在手臂上
    _arm.set(r.arm[0], -r.arm[1], -.55).normalize();
    _q.setFromUnitVectors(Y, _arm);
    const wrist = toWorld(r.wx, r.wy);
    r.rings.forEach((m, i) => {
      const U = m.userData, along = r.armOk ? r.armLen * (.18 + .28 * i) : r.handLen * (.3 + U.along * .9);
      m.position.copy(wrist).addScaledVector(_arm, along);
      m.quaternion.copy(_q).multiply(_spinQ.setFromAxisAngle(Y, U.idle * el + U.gear * dial));
      const rad = r.handLen * U.rad * (r.armOk ? 1 - i * .08 : 1);
      m.scale.set(rad, r.handLen * 1.2, rad);
      m.material.opacity = bright * clamp(r.presence * 3 - i * .4, 0, 1) * .9;
    });
    if (r.presence > .5) spawn(r, Math.floor((r.locked ? 2.5 : .8) + Math.min(speedVis, 3) * 25 * Math.random()), Math.min(speedVis, 3), cw);
  }
  lockGlow = approach(lockGlow, rigs.some(r => r.locked) ? 1 : 0, dt, .15);
  objRing.visible = lockGlow > .01;
  if (objRing.visible) {
    objRing.position.copy(toWorld(obj.cx, obj.cy, -2));
    objRing.scale.setScalar(obj.size * .62);
    objRingA.rotation.z = .05 * el - dial * .5; objRingB.rotation.z = -.08 * el + dial * 1.3;
    objRingA.material.opacity = lockGlow * .45; objRingB.material.opacity = lockGlow * .3;
  }
}

// ---------- 骨架、阶段字幕、状态栏 ----------
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
function drawSkeleton(slots) {
  if (!showDbg) { if (skelDirty) { sctx.clearRect(0, 0, skel.width, skel.height); skelDirty = false; } return; }
  sctx.clearRect(0, 0, skel.width, skel.height); skelDirty = true;
  for (const s of slots) {
    if (!s.seen || !s.S) continue;
    sctx.strokeStyle = s.open ? 'rgba(120,255,170,.55)' : 'rgba(255,190,90,.6)'; sctx.lineWidth = 1.5;
    sctx.beginPath(); for (const [a, b] of BONES) { sctx.moveTo(...s.S[a]); sctx.lineTo(...s.S[b]); } sctx.stroke();
    sctx.fillStyle = '#fff'; for (const [x, y] of s.S) { sctx.beginPath(); sctx.arc(x, y, 2.5, 0, 7); sctx.fill(); }
  }
}
let lastStage = '', captionAt = 0;
function updateCaption(now, res) {
  const st = stageAt(res.t), name = stageName(res.t), el = $('caption');
  if (name && name !== lastStage) {
    if (lastStage) { el.textContent = (st.t > 0 ? '未来 · ' : st.t < 0 ? '过去 · ' : '现在 · ') + name; el.classList.add('show'); captionAt = now; }
    lastStage = name;
  }
  if (captionAt && Math.abs(res.speed) > .02) captionAt = now;
  if (captionAt && now - captionAt > 1800) { el.classList.remove('show'); captionAt = 0; }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function updateHud(slots, res) {
  const st = stageName(res.t), locked = rigs.some(r => r.locked);
  const detTxt = det.ready ? ` · 识别 ${det.rate.toFixed(0)}Hz ${det.cost.toFixed(0)}ms · 延迟 ${det.latency.toFixed(0)}ms` : '';
  $('hud').innerHTML = `FPS ${fps.toFixed(0)}${detTxt}<br>t ${res.t >= 0 ? '+' : ''}${res.t.toFixed(2)}${st ? ' ' + esc(st) : ''}${locked ? ' · 锁定' : ''} · 全程 ${LIFE_DEG}°` +
    `<br>摄像头 ${camOk ? esc(camLabel.slice(0, 18)) || '开' : '关'} · 手势 ${handStatus}` +
    `<br>手 ${slots.filter(s => s.seen).length} 只` + slots.map((s, k) => (s.seen ? ` · ${k ? '左' : '右'}${s.open ? '张' : '握'}${s.d.armOk ? '·臂' : ''}` : '')).join('');
}

// ---------- 主循环 ----------
let last = 0, fps = 60, frames = 0, fpsT = 0, hudAt = 0;
const rec = { on: false, rows: [], t0: 0 }, perf = { deltas: [], longTasks: 0 };
function frame(now) {
  const dt = Math.min((now - last) / 1000, .05) || 1 / 60; last = now;
  frames++; fpsT += dt; if (fpsT >= .5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  perf.deltas.push(dt * 1000); if (perf.deltas.length > 900) perf.deltas.shift();
  if (now - det.rateAt > 1000) { det.rate = det.count * 1000 / (now - det.rateAt); det.count = 0; det.rateAt = now; }
  watchdog(now);

  const slots = tracker.update(now, dt), anyHand = slots.some(s => s.seen);
  const useMouse = !anyHand && (!camOk || !det.ready || now - mouse.last < 3000) && (mouse.inside || now - mouse.last < 3000);
  const obj = objectRect(), minSide = Math.min(innerWidth, innerHeight);
  rigs.forEach((r, k) => {
    const s = slots[k], hidden = r.presence < .02;
    if (s.seen) {
      const d = s.d;
      Object.assign(r, { hand: true, want: s.open ? 1 : 0, x: d.x, y: d.y, roll: d.roll, key: s.epoch, handLen: d.len, n: d.n, arm: d.arm, armLen: d.armLen, armOk: d.armOk, wx: d.wx, wy: d.wy });
      r.radius = clamp(d.len * 1.55, 60, minSide * .45);
    } else if (k === 0 && useMouse) {
      r.x = hidden ? mouse.x : approach(r.x, mouse.x, dt, .03); r.y = hidden ? mouse.y : approach(r.y, mouse.y, dt, .03);
      r.radius = minSide * .2; r.handLen = r.radius / 1.55;
      Object.assign(r, { hand: false, want: 1, roll: 0, key: null, n: MOUSE_N, arm: MOUSE_ARM, armLen: r.handLen * 2.2, armOk: false,
        wx: r.x + MOUSE_ARM[0] * r.handLen, wy: r.y + MOUSE_ARM[1] * r.handLen });
    } else { r.want = 0; r.key = null; }
  });
  const res = ia.step(dt, rigs, obj, mouse.wheel);
  mouse.wheel = 0;
  pushTime(res.t);
  drawRigs(now, dt, res, obj);
  stepParticles(dt);
  updateAudio(res);
  renderer.render(scene, camera);
  drawSkeleton(slots);
  updateCaption(now, res);
  if (now - hudAt > 120) { hudAt = now; updateHud(slots, res); }
  if (rec.on) rec.rows.push({ r: now - rec.t0, t: res.t, target: res.target, rigs: rigs.map(g => ({ x: g.x, y: g.y, presence: g.presence, locked: g.locked })) });
  requestAnimationFrame(frame);
}
requestAnimationFrame(now => { last = now; frame(now); });
setTimeout(() => { $('tip').style.opacity = 0; }, 10000);

// ---------- 自动化测试用 ----------
window.__timespell = () => ({ t: ia.t, tTarget: ia.target, locked: rigs.some(r => r.locked), fps, camOk, handStatus,
  detector: { mode: det.mode, delegate: det.delegate, pose: poseDet.ready || !!det.poser, rate: det.rate, cost: det.cost, latency: det.latency, sent: det.sent, got: det.got, dropped: det.dropped, busy: det.busy, readyMs: det.readyMs, gpuMs: det.gpuMs, poseMs: det.poseMs },
  hands: tracker.slots.filter(s => s.seen).length, presence: rigs[0].presence, audio: audio.on, tracks: audio.tracks, track: audio.track,
  lifeDeg: LIFE_DEG, dialAngle: ia.t * LIFE_RAD / 2, rings: rigs[0].rings.map(m => m.position.toArray().map(Math.round)) });
window.__setTime = t => { ia.set(t); pushTime(ia.t, true); };
window.__timespellTest = {
  record() { Object.assign(rec, { on: true, rows: [], t0: performance.now() }); },
  stop() { rec.on = false; return rec.rows; },
  perf() {
    const d = [...perf.deltas].sort((a, b) => a - b), q = p => d[Math.min(d.length - 1, Math.floor(d.length * p))];
    return { n: d.length, p50: q(.5), p95: q(.95), p99: q(.99), over25: perf.deltas.filter(v => v > 25).length, longTasks: perf.longTasks };
  },
  resetPerf() { perf.deltas.length = 0; perf.longTasks = 0; },
};
try { new PerformanceObserver(l => { perf.longTasks += l.getEntries().length; }).observe({ type: 'longtask' }); } catch {}
