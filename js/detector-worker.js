// 在后台线程里跑 MediaPipe 识别：主线程只负责画画面，识别再慢也不会卡住动画。
// 手和手臂（姿态）各用一个线程：两个模型各自预热、各自跑，实测比放在同一个线程里识别得更快、延迟更低。
// 必须是普通（classic）Worker：MediaPipe 用 importScripts 加载 wasm 胶水代码，module Worker 里不能用
let hands = null, pose = null;

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') init(m);
  else if (m.type === 'frame') detect(m);
};

// m：{ kind: 'hand' | 'pose', delegate, js: [{ bundle, loader, wasm }...], wasm: ArrayBuffer | null, model: ArrayBuffer | null, modelUrl }
async function init(m) {
  // wasm 和模型通常是主线程下载好传进来的；没有的话按地址加载
  const wasmUrl = m.wasm ? URL.createObjectURL(new Blob([m.wasm], { type: 'application/wasm' })) : null;
  const asset = m.model ? { modelAssetBuffer: new Uint8Array(m.model) } : { modelAssetPath: m.modelUrl };
  const isHand = m.kind === 'hand';
  const opts = isHand ? { numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 } : { numPoses: 1 };
  let lastErr = null;
  for (const js of m.js) {
    try {
      const mp = await import(js.bundle);
      const fileset = { wasmLoaderPath: js.loader, wasmBinaryPath: wasmUrl || js.wasm };
      const Task = isHand ? mp.HandLandmarker : mp.PoseLandmarker;
      const make = delegate => Task.createFromOptions(fileset, { baseOptions: { ...asset, delegate }, runningMode: 'VIDEO', ...opts });
      let delegate = m.delegate || 'GPU', task;
      try { task = await make(delegate); }
      catch (err) { if (m.delegate) throw err; delegate = 'CPU'; task = await make('CPU'); }
      if (isHand) hands = task; else pose = task;
      // 预热：第一次推理要编译着色器（GPU 上可能要好几秒），在报“就绪”之前做完，免得手第一次出现时卡住
      const blank = new OffscreenCanvas(640, 360);
      blank.getContext('2d').fillRect(0, 0, 640, 360);
      let bmp = await createImageBitmap(blank); task.detectForVideo(bmp, 1); bmp.close();
      bmp = await createImageBitmap(blank);
      const t0 = performance.now(); task.detectForVideo(bmp, 2); const bench = performance.now() - t0; bmp.close();
      self.postMessage({ type: 'ready', delegate, kind: m.kind, bench });
      return;
    } catch (err) { lastErr = err; }
  }
  self.postMessage({ type: 'error', message: String((lastErr && lastErr.message) || lastErr) });
}

function detect({ bitmap, ts }) {
  const t0 = performance.now(), out = { type: 'result', ts, hands: null, pose: null };
  try {
    if (hands) {
      const r = hands.detectForVideo(bitmap, ts), hd = r.handedness || r.handednesses || [];
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
