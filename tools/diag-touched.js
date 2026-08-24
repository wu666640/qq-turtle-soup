const host = require('../src/host');
const saved = require('../data/saved-puzzles.json');
const p = saved[0];
(async () => {
  const kp = await host.extractKeyPoints(p.bottom);
  const qs = [
    ['关键', '经纪人是当初的司机吗？'],
    ['关键', '他杀死了哥哥嫂子吗？'],
    ['非关键', '他是在中国长大的吗？'],
    ['非关键', '他是男的吗？'],
    ['非关键', '汤是热的吗？'],
    ['元', '是红汤吗？'],
    ['元', '是变格吗？'],
  ];
  for (const [tag, q] of qs) {
    const r = await host.judgeQuestion(p.bottom, p.surface, kp, q);
    console.log('[' + tag + ']「' + q + '」=> ' + r.verdict + ' 触及:' + JSON.stringify(r.touched) + ' 重点:' + r.important);
  }
})();
