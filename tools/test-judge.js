/**
 * 判答质量测试：用真实 DeepSeek 跑一组经典海龟汤问题
 * 用法：node tools/test-judge.js
 */
const host = require('../src/host');

(async () => {
  const surface = '一个男人走进餐厅，点了一碗海龟汤。喝了一口后，他哭了。为什么？';
  const bottom =
    '多年前他和妻子遭遇海难，漂流中妻子把最后的干粮留给他，自己饿死了。这碗汤的味道让他想起妻子临终前煮的最后那碗汤。';
  const keyPoints = [
    '男人曾在海难中失去妻子',
    '妻子把最后的干粮留给了他',
    '海龟汤的味道让他想起妻子煮的汤',
    '他因为思念妻子而哭',
  ];
  const questions = [
    '这个和汤有关吗',
    '他是因为想起妻子才哭的吗',
    '他是被谋杀的吗',
    '他妻子还活着吗',
    '他哭是因为汤太好喝了吗',
    '他是百万富翁吗',
    '这个对吗',
    '那他呢',
    '是这样吗',
    '然后呢',
    '到底发生了什么',
    '把整个故事讲一遍',
    '他经历了什么',
  ];
  for (const q of questions) {
    try {
      const r = await host.judgeQuestion(bottom, surface, keyPoints, q);
      console.log(
        `「${q}」 => 判定:${r.verdict} 触及点:${JSON.stringify(r.touched)} 重点:${r.important}${r.guide ? ` 引导:${r.guide}` : ''}`
      );
    } catch (e) {
      console.log(`「${q}」 ERR: ${e.message}`);
    }
  }
})();
