// 在后台线程里跑 MediaPipe 识别：主线程只负责画画面，识别再慢也不会卡住动画。
// 手和手臂（姿态）各用一个线程：两个模型各自预热、各自跑，实测比放在同一个线程里识别得更快、延迟更低。
// 必须是普通（classic）Worker：MediaPipe 用 importScripts 加载 wasm 胶水代码，module Worker 里不能用
let hands = null, pose = null;

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') init(m);
  else if (m.type === 'frame') detect(m);
};

// m：{ kind: 'hand' | 'pose', delegate, js: [{ bundle, loader, wasm }...], wasm, model（ArrayBuffer 或 null）, modelUrl, warm（预热用的手部照片）, maxHands }
async function init(m) {
  // wasm 和模型通常是主线程下载好传进来的；没有的话按地址加载
  const wasmUrl = m.wasm ? URL.createObjectURL(new Blob([m.wasm], { type: 'application/wasm' })) : null;
  const asset = m.model ? { modelAssetBuffer: new Uint8Array(m.model) } : { modelAssetPath: m.modelUrl };
  const isHand = m.kind === 'hand';
  const handOpts = n => ({ numHands: n, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
  let warm = null;
  if (m.warm) try { warm = await createImageBitmap(new Blob([m.warm])); } catch (err) { warm = null; }
  let lastErr = null;
  for (const js of m.js) {
    try {
      const mp = await import(js.bundle);
      const fileset = { wasmLoaderPath: js.loader, wasmBinaryPath: wasmUrl || js.wasm };
      let delegate = m.delegate || 'GPU';
      const create = async (Task, opts) => {
        const make = d => Task.createFromOptions(fileset, { baseOptions: { ...asset, delegate: d }, runningMode: 'VIDEO', ...opts });
        try { return await make(delegate); }
        catch (err) { if (m.delegate || delegate === 'CPU') throw err; delegate = 'CPU'; return make('CPU'); }
      };
      if (isHand) {
        // 设成认两只手时，画面里只有一只手的话，MediaPipe 每帧都要重新找手，耗时翻倍（实测 GPU 24 → 13ms，CPU 175 → 83ms）。
        // 所以平时用只认一只手的那份逐帧跟踪，每隔几帧用认两只手的那份扫一遍，发现第二只手再换过去
        const one = await create(mp.HandLandmarker, handOpts(1));
        const two = (m.maxHands || 2) > 1 ? await create(mp.HandLandmarker, handOpts(2)) : null;
        hands = { one, two, both: false, n: 0, miss: 0, scanEvery: delegate === 'GPU' ? 10 : 15 };
      } else pose = await create(mp.PoseLandmarker, { numPoses: 1 });
      // 预热：第一次推理要编译着色器（GPU 上可能要好几秒）。用一张手的照片预热，找手和描关键点两个模型都会跑到，
      // 免得手第一次出现时卡住
      const canvas = new OffscreenCanvas(640, 360), g = canvas.getContext('2d');
      const frame = withHand => {
        g.fillStyle = '#3a3c40'; g.fillRect(0, 0, 640, 360);
        if (withHand && warm) g.drawImage(warm, 180, 20, 300, 300);
        return createImageBitmap(canvas);
      };
      const tasks = isHand ? [hands.one, hands.two].filter(Boolean) : [pose];
      let ts = 1;
      for (const task of tasks) for (const withHand of [false, true, true]) { const b = await frame(withHand); task.detectForVideo(b, ts++); b.close(); }
      const b = await frame(true), t0 = performance.now();
      tasks[0].detectForVideo(b, ts++);
      const bench = performance.now() - t0;
      b.close();
      if (warm) warm.close();
      self.postMessage({ type: 'ready', delegate, kind: m.kind, bench, twoHands: !!(hands && hands.two) });
      return;
    } catch (err) { lastErr = err; }
  }
  self.postMessage({ type: 'error', message: String((lastErr && lastErr.message) || lastErr) });
}

function detectHands(bitmap, ts) {
  const H = hands;
  if (H.two && H.both) {
    const r = H.two.detectForVideo(bitmap, ts);
    if ((r.landmarks || []).length >= 2) H.miss = 0;
    else if (++H.miss >= 8) { H.both = false; H.miss = 0; }
    return r;
  }
  const r = H.one.detectForVideo(bitmap, ts);
  if (H.two && ++H.n % H.scanEvery === 0) {
    const r2 = H.two.detectForVideo(bitmap, ts);
    if ((r2.landmarks || []).length >= 2) { H.both = true; H.miss = 0; return r2; }
  }
  return r;
}

function detect({ bitmap, ts }) {
  const t0 = performance.now(), out = { type: 'result', ts, hands: null, pose: null, both: hands ? hands.both : false };
  try {
    if (hands) {
      const r = detectHands(bitmap, ts), hd = r.handedness || r.handednesses || [];
      out.hands = (r.landmarks || []).map((lm, i) => ({
        lm: lm.map(p => ({ x: p.x, y: p.y, z: p.z })),
        handed: hd[i] && hd[i][0] ? hd[i][0].categoryName : String(), score: hd[i] && hd[i][0] ? hd[i][0].score : 1,
      }));
    }
    if (pose) {
      const p = pose.detectForVideo(bitmap, ts).landmarks;
      out.pose = p && p[0] ? [[15, 13], [16, 14]].map(([w, e]) => ({ wrist: [p[0][w].x, p[0][w].y], elbow: [p[0][e].x, p[0][e].y], vis: Math.min(p[0][w].visibility ?? 1, p[0][e].visibility ?? 1) })) : [];
    }
  } catch (err) { out.error = String((err && err.message) || err); }
  bitmap.close();
  out.cost = performance.now() - t0;
  self.postMessage(out);
}
