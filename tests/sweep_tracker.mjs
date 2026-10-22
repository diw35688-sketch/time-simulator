// 调参用：在 check_tracker 的同一组合成数据上扫参数，打印关键指标。node tests/sweep_tracker.mjs [pos|roll]
import { runNew, metrics, CHECKS } from './check_tracker.mjs';
const which = process.argv[2] || 'pos', rows = [];
const fails = m => CHECKS.filter(([k, , ok]) => m[k] === null || !ok(m[k])).map(([k]) => k).join(',') || '-';
if (which === 'pos') {
  for (const lead of [0.75, 0.9, 1.0]) for (const velK of [0.5, 0.7]) for (const tauPos of [0.012, 0.02]) {
    const m = metrics(runNew({ lead, velK, tauPos, rollLead: 0.6, roll: [3.0, 8, 2.0] }, { tauT: 0.015 }));
    rows.push({ lead, velK, tauPos, lag: m.lagMs.toFixed(1), lagFast: m.lagFastMs.toFixed(1), smooth: m.smoothLagMs.toFixed(1), cv: m.stepCV.toFixed(3),
      over: m.overshoot.toFixed(1), smOver: m.smoothOver.toFixed(1), jit: m.jitter.toFixed(2), twist: m.twistLagMs.toFixed(0), twOver: m.twistOver.toFixed(3), fails: fails(m) });
  }
} else {
  for (const rollLead of [0.4, 0.6, 0.8, 1.0]) for (const rollMinSpeed of [0.15, 0.3]) for (const beta of [2, 4, 8]) for (const tauT of [0.015, 0.025]) {
    const m = metrics(runNew({ rollLead, rollMinSpeed, roll: [3.0, beta, 2.0] }, { tauT }));
    rows.push({ rollLead, minS: rollMinSpeed, beta, tauT, tLag: m.tLagMs.toFixed(0), quick: m.quickLagMs.toFixed(0), roll: m.rollLagMs.toFixed(0), over: m.quickOver.toFixed(3),
      endBack: m.tEndBack.toFixed(3), settle: m.settleMs.toFixed(0), drift: m.holdDrift.toFixed(3), rev: m.reverseFrames, t60: m.tAfter60.toFixed(3), fails: fails(m) });
  }
}
console.table(rows);
