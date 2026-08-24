const host = require('../src/host');
const saved = require('../data/saved-puzzles.json');
const p = saved[0];
(async () => {
  const kp = await host.extractKeyPoints(p.bottom);
  const qs = [
    ['关键', '他是天生盲人吗？'],
    ['关键', '经纪人就是当初的司机吗？'],
    ['无关', '今天天气好吗？'],
    ['无关', '他是外星人吗？'],
    ['无关', '地球是圆的吗？'],
    ['边缘', '他是男的吗？'],
    ['边缘', '那家餐厅好吃吗？'],
  ];
  for (const [tag, q] of qs) {
    const r = await host.judgeQuestion(p.bottom, p.surface, kp, q);
    console.log('[' + tag + ']「' + q + '」=> ' + r.verdict + ' 触及:' + JSON.stringify(r.touched) + ' 重点:' + r.important);
  }
})();
