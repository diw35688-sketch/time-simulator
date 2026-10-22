// 在后台线程里跑 MediaPipe 手势和姿态识别：主线程只负责画画面，识别再慢也不会卡住动画。
// 必须是普通（classic）Worker：MediaPipe 用 importScripts 加载 wasm 胶水代码，module Worker 里不能用
let hands = null, pose = null;

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') init(m.candidates, m.delegate);
  else if (m.type === 'frame') detect(m);
};

async function init(candidates, only) {
  let lastErr = null;
  for (const c of candidates) {
    try {
      const mp = await import(c.base + 'vision_bundle.mjs');
      const fs = await mp.FilesetResolver.forVisionTasks(c.base + 'wasm');
      const make = (Task, model, delegate, extra) => Task.createFromOptions(fs, { baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO', ...extra });
      const handOpts = { numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 };
      let delegate = only || 'GPU';
      try { hands = await make(mp.HandLandmarker, c.hand, delegate, handOpts); }
      catch (err) { if (only) throw err; delegate = 'CPU'; hands = await make(mp.HandLandmarker, c.hand, 'CPU', handOpts); }
      if (c.pose) {
        try { pose = await make(mp.PoseLandmarker, c.pose, delegate, { numPoses: 1 }); } catch (err) { pose = null; }
      }
      // 预热：第一次推理要编译着色器（GPU 上可能要好几秒），在报“就绪”之前做完，免得手第一次出现时卡住
      const blank = new OffscreenCanvas(640, 360);
      blank.getContext('2d').fillRect(0, 0, 640, 360);
      const frame = () => createImageBitmap(blank);
      let bmp = await frame(); hands.detectForVideo(bmp, 1); if (pose) pose.detectForVideo(bmp, 1); bmp.close();
      bmp = await frame();
      const t0 = performance.now(); hands.detectForVideo(bmp, 2); const bench = performance.now() - t0; bmp.close();
      self.postMessage({ type: 'ready', delegate, pose: !!pose, local: !!c.local, bench });
      return;
    } catch (err) { lastErr = err; }
  }
  self.postMessage({ type: 'error', message: String((lastErr && lastErr.message) || lastErr) });
}

function detect({ bitmap, ts, wantPose }) {
  const t0 = performance.now(), out = { type: 'result', ts, hands: [], pose: null };
  try {
    const r = hands.detectForVideo(bitmap, ts), hd = r.handedness || r.handednesses || [];
    out.hands = (r.landmarks || []).map((lm, i) => ({
      lm: lm.map(p => ({ x: p.x, y: p.y, z: p.z })),
      handed: hd[i] && hd[i][0] ? hd[i][0].categoryName : '', score: hd[i] && hd[i][0] ? hd[i][0].score : 1,
    }));
    if (pose && wantPose && out.hands.length) {
      const p = pose.detectForVideo(bitmap, ts).landmarks;
      if (p && p[0]) out.pose = [[15, 13], [16, 14]].map(([w, e]) => ({ wrist: [p[0][w].x, p[0][w].y], elbow: [p[0][e].x, p[0][e].y], vis: Math.min(p[0][w].visibility ?? 1, p[0][e].visibility ?? 1) }));
    }
  } catch (err) { out.error = String((err && err.message) || err); }
  bitmap.close();
  out.cost = performance.now() - t0;
  self.postMessage(out);
}
