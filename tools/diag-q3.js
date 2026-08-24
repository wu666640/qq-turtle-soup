const host = require('../src/host');
const saved = require('../data/saved-puzzles.json');
const p = saved[0];
(async () => {
  const kp = await host.extractKeyPoints(p.bottom);
  for (const q of ['药是治疗我的病的吗？', '眼药水让他复明了吗？', '他能看见了吗？', '他是因为那个药水才复明的吗？']) {
    const r = await host.judgeQuestion(p.bottom, p.surface, kp, q);
    console.log('「' + q + '」=> ' + r.verdict + ' 触及:' + JSON.stringify(r.touched) + ' 重点:' + r.important);
  }
})();
