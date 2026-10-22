// 调参用：在 check_tracker 的同一组合成数据（5 个种子取中位数）上扫参数，打印关键指标。node tests/sweep_tracker.mjs [pos|roll]
import { runNew, medianMetrics, CHECKS } from './check_tracker.mjs';
const which = process.argv[2] || 'pos', rows = [];
const fails = m => CHECKS.filter(([k, , ok]) => m[k] === null || !ok(m[k])).map(([k]) => k).join(',') || '-';
if (which === 'pos') {
  for (const lead of [0.6, 0.75, 0.9]) for (const velK of [0.5, 0.7]) {
    const m = medianMetrics(() => runNew({ lead, velK }));
    rows.push({ lead, velK, lag: m.lagMs.toFixed(1), smooth: m.smoothLagMs.toFixed(1), cv: m.stepCV.toFixed(3), over: m.overshoot.toFixed(1), smOver: m.smoothOver.toFixed(1), jit: m.jitter.toFixed(2), fails: fails(m) });
  }
} else {
  for (const rollLead of [0.4, 0.6, 0.8]) for (const tauT of [0.015, 0.025]) {
    const m = medianMetrics(() => runNew({ rollLead }, { tauT }));
    rows.push({ rollLead, tauT, tLag: m.tLagMs.toFixed(0), quick: m.quickLagMs.toFixed(0), twist: m.twistLagMs.toFixed(0), roll: m.rollLagMs.toFixed(0), over: m.quickOver.toFixed(3),
      twOver: m.twistOver.toFixed(3), endBack: m.tEndBack.toFixed(3), settle: m.settleMs.toFixed(0), fails: fails(m) });
  }
}
console.table(rows);
