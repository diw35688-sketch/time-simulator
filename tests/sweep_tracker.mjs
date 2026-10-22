// 调参用：在 check_tracker 的同一组合成数据上扫一遍参数，打印关键指标
import { runNew, metrics, CHECKS } from './check_tracker.mjs';
const rows = [];
for (const lead of [0.5, 0.6, 0.7])
  for (const tauPos of [0.016, 0.024, 0.032])
    for (const velK of [0.5, 0.3]) {
      const m = metrics(runNew({ lead, tauPos, velK, pos: [1.0, 0.02, 2.0], roll: [3.0, 0.4, 2.0] }, { backlash: 0.012 }));
      const fails = CHECKS.filter(([k, , ok]) => !ok(m[k])).map(([k]) => k);
      rows.push({ lead, tauPos, velK, jit: m.jitter.toFixed(2), lag: m.lagMs.toFixed(0), lagFast: m.lagFastMs.toFixed(0), cv: m.stepCV.toFixed(3), cvFast: m.stepCVFast.toFixed(3),
        over: m.overshoot.toFixed(1), fails: fails.join(',') || '-' });
    }
console.table(rows);
