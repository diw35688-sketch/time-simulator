// 调参用：在 check_tracker 的同一组合成数据上扫一遍参数，打印关键指标
import { runNew, metrics, CHECKS } from './check_tracker.mjs';
const rows = [];
for (const len of [[1.2, 0.02, 1.5], [2.0, 0.03, 1.5], [2.0, 0.06, 2.0], [3.0, 0.05, 2.0]])
  for (const tauLen of [0.02, 0.03])
    for (const tauBend of [0.12, 0.25]) {
      const m = metrics(runNew({ len, tauLen, tauBend }));
      const fails = CHECKS.filter(([k, , ok]) => m[k] === null || !ok(m[k])).map(([k]) => k);
      rows.push({ len: len.join('/'), tauLen, tauBend, sizeLag: m.sizeLagMs.toFixed(0), sizeErr: m.sizeErr.toFixed(2), jit: m.jitter.toFixed(2),
        armRot: m.armErrRot.toFixed(2), armHold: m.armErrHold.toFixed(2), wrist: m.wristErr.toFixed(1), fails: fails.join(',') || '-' });
    }
console.table(rows);
