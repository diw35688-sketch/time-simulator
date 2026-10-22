// 在后台线程里跑 MediaPipe 识别：主线程只负责画画面，识别再慢也不会卡住动画。
// 手和手臂（姿态）各用一个线程：两个模型各自预热、各自跑，实测比放在同一个线程里识别得更快、延迟更低。
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
      const create = async (Task, model, opts) => {
        try { return await make(Task, model, delegate, opts); }
        catch (err) { if (only || delegate === 'CPU') throw err; delegate = 'CPU'; return make(Task, model, 'CPU', opts); }
      };
      if (c.hand) hands = await create(mp.HandLandmarker, c.hand, handOpts);
      if (c.pose) pose = await create(mp.PoseLandmarker, c.pose, { numPoses: 1 });
      // 预热：第一次推理要编译着色器（GPU 上可能要好几秒），在报“就绪”之前做完，免得手第一次出现时卡住
      const blank = new OffscreenCanvas(640, 360);
      blank.getContext('2d').fillRect(0, 0, 640, 360);
      for (const task of [hands, pose]) if (task) { const bmp = await createImageBitmap(blank); task.detectForVideo(bmp, 1); bmp.close(); }
      const main = hands || pose, bmp = await createImageBitmap(blank);
      const t0 = performance.now(); main.detectForVideo(bmp, 2); const bench = performance.now() - t0; bmp.close();
      self.postMessage({ type: 'ready', delegate, hands: !!hands, pose: !!pose, local: !!c.local, bench });
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
        handed: hd[i] && hd[i][0] ? hd[i][0].categoryName : '', score: hd[i] && hd[i][0] ? hd[i][0].score : 1,
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
