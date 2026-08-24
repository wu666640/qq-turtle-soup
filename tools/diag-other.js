const host = require('../src/host');
const { PUZZLES } = require('../src/puzzles');
(async () => {
  const tests = [
    { name: '电梯', p: PUZZLES[3], q: '他是被电梯夹死的吗？' },
    { name: '镜中人', p: PUZZLES[5], q: '她有人格分裂吗？' },
    { name: '葬礼上的男人', p: PUZZLES[1], q: '她杀了姐姐吗？' },
    { name: '酒吧的水', p: PUZZLES[2], q: '酒保治好了他的打嗝吗？' },
    { name: '雨夜搭车', p: PUZZLES[4], q: '女孩是鬼吗？' },
  ];
  for (const t of tests) {
    const kp = await host.extractKeyPoints(t.p.bottom);
    const r = await host.judgeQuestion(t.p.bottom, t.p.surface, kp, t.q);
    console.log(t.name + '：' + t.q + ' => ' + r.verdict + ' 触及:' + JSON.stringify(r.touched) + ' 重点:' + r.important);
  }
})();
