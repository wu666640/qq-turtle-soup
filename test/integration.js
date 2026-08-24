/**
 * 集成测试：本地 Mock DeepSeek，端到端跑完整一局
 * 不依赖真实 API Key / QQ / NapCat，验证「消息 → 判答 → 记录 → 还原度 → 扶汤 → 复盘」全链路。
 * 运行：node test/integration.js
 */
const http = require('http');

// —— 1. 先设置环境变量，再加载业务模块 ——
const PORT = 18777;
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.MAX_QUESTIONS = '20';

const { route } = require('../src/index');

// 备份存档题文件，测试结束还原（避免测试污染真实题库）
const fs = require('fs');
const path = require('path');
const savedFile = path.join(__dirname, '..', 'data', 'saved-puzzles.json');
const savedBackup = fs.existsSync(savedFile) ? fs.readFileSync(savedFile, 'utf-8') : null;

// —— 2. Mock DeepSeek 服务器（按提示词内容返回不同结果）——
let judgeCalls = 0;
const JUDGE_ANSWERS = [
  { verdict: '是', touched: [1] },
  { verdict: '不是', touched: [2] },
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let content = '';
    try {
      content = JSON.parse(body).messages.map((m) => m.content).join('\n');
    } catch {}
    let reply = '';
    if (content.includes('玩家消息')) {
      // AI 智能识别：判为问题并返回判答 JSON
      const a = JUDGE_ANSWERS[judgeCalls % JUDGE_ANSWERS.length];
      judgeCalls += 1;
      reply = JSON.stringify({ type: 'question', verdict: a.verdict, touched: a.touched, guide: '' });
    } else if (content.includes('玩家还原')) {
      reply = JSON.stringify({
        points: [
          { i: 1, verdict: '准确', note: '对' },
          { i: 2, verdict: '准确', note: '对' },
          { i: 3, verdict: '部分', note: '差不多' },
        ],
        comment: '整体很接近',
      });
    } else if (content.includes('扶汤')) {
      reply = '提示：想想他是怎么复明的。';
    } else if (content.includes('pitfalls')) {
      // 汤底理解笔记
      reply = JSON.stringify({
        summary: '他复明后为保住光明杀了哥嫂，司机就是上帝伪装的经纪人',
        characters: [
          { name: '他', identity: '主角，天生失明后复明' },
          { name: '司机/经纪人', identity: '上帝伪装的角色' },
        ],
        keyFacts: ['司机是上帝', '眼药水用人血做成'],
        pitfalls: [
          { ask: '上帝是人扮的吗', answer: '不是', note: '上帝真实存在' },
          { ask: '他是被杀的么', answer: '模糊', note: '指代不明' },
        ],
      });
    } else if (content.includes('关键真相点')) {
      reply = JSON.stringify({ key_points: ['他天生失明', '嫂子雇人把他扔进山里', '司机给他人血做的眼药水'] });
    } else {
      reply = JSON.stringify({ type: 'question', verdict: '无关', touched: [], guide: '' });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
});

// —— 3. 断言与模拟消息 ——
let failed = 0;
function check(name, actual, expectPart) {
  const ok = typeof actual === 'string' && actual.includes(expectPart);
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) {
    failed += 1;
    console.log(`   期望包含: ${expectPart}`);
    console.log(`   实际: ${JSON.stringify(actual)}`);
  }
}

function msg(message_type, id, text) {
  return {
    post_type: 'message',
    message_type,
    user_id: id,
    group_id: message_type === 'group' ? id : undefined,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
  };
}

// —— 4. 完整一局 ——
server.listen(PORT, async () => {
  try {
    const user = 2001;
    let r = await route(
      msg('private', user, '开局 汤面：他复明了 汤底：他天生失明，嫂子雇人把他扔进山里，司机给了他人血做的眼药水'),
      '开局 汤面：他复明了 汤底：他天生失明，嫂子雇人把他扔进山里，司机给了他人血做的眼药水'
    );
    check('开局：提取到 3 个关键真相点', r, '3 个关键真相点');

    r = await route(msg('private', user, '他是天生的盲人吗？'), '他是天生的盲人吗？');
    check('提问1：判答「是」并触及点', r, '→ 是（触及关键点 +1）');
    check('提问1：还原度升至 33%', r, '33%');

    r = await route(msg('private', user, '嫂子想害他吗？'), '嫂子想害他吗？');
    check('提问2：判答「不是」并触及点', r, '→ 不是（触及关键点 +1）');
    check('提问2：还原度升至 67%', r, '67%');

    r = await route(msg('private', user, '记录'), '记录');
    check('记录：共 2 条且保留问题原文', r, '共 2 条');
    check('记录：保留问题原文', r, '盲人');

    r = await route(msg('private', user, '扶汤'), '扶汤');
    check('扶汤：给出提示', r, '提示');
    check('扶汤：点亮最后一点，还原度 100%', r, '100%');

    r = await route(msg('private', user, '复盘'), '复盘');
    check('复盘：进入等待还原', r, '完整还原');

    r = await route(msg('private', user, '他复明后成了钢琴家，司机就是上帝'), '他复明后成了钢琴家，司机就是上帝');
    check('复盘判定：大致准确', r, '大致准确');
    check('复盘：还原度 83%', r, '83%');

    r = await route(msg('private', user, '重开'), '重开');
    check('重开：重置会话', r, '已重置');

    console.log('\n结果：' + (failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`));
  } catch (e) {
    console.error('集成测试异常:', e);
    failed += 1;
  } finally {
    // 还原存档题文件（防止测试污染真实题库）
    if (savedBackup === null) {
      try { fs.rmSync(savedFile, { force: true }); } catch {}
    } else {
      try { fs.writeFileSync(savedFile, savedBackup, 'utf-8'); } catch {}
    }
    // 销毁 keep-alive 连接并关闭 mock 服务器；成功时不主动 process.exit，
    // 等句柄自然收尾（Node on Windows 下 process.exit 会触发 libuv 断言崩溃）
    server.closeAllConnections?.();
    server.close();
    if (failed > 0) process.exit(1);
  }
});
