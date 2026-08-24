/**
 * 无 Key 冒烟测试：验证指令路由与会话状态机（不调用真实 DeepSeek / QQ）。
 * 覆盖：规则 / 分步开局 / 单条开局 / 提问(降级) / 扶汤 / 记录 / 还原度 / 复盘 / 揭晓 / 重开 / 群聊。
 * 运行：node test/smoke.js
 */

// 强制无 Key：即使 .env 里配了真实 Key，本测试也只验证「无 Key 降级」路径
process.env.DEEPSEEK_API_KEY = '';

const fs = require('fs');
const path = require('path');
// 清理测试产生的记录文件
for (const k of ['p_1001', 'p_1002', 'p_2002', 'g_444', 'p_3003', 'g_777', 'p_1004']) {
  try {
    fs.rmSync(path.join(__dirname, '..', 'records', k + '.txt'), { force: true });
  } catch {}
}
// 备份存档题文件，测试结束后还原（避免污染真实数据）
const savedFile = path.join(__dirname, '..', 'data', 'saved-puzzles.json');
const savedBackup = fs.existsSync(savedFile) ? fs.readFileSync(savedFile, 'utf-8') : null;

const { route } = require('../src/index');

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

(async () => {
  // S1 私聊：规则
  let r = await route(msg('private', 1001, '规则'), '规则');
  check('S1 私聊发「规则」返回帮助', r, '海龟汤玩法');
  r = await route(msg('private', 1001, ''), '');
  check('S1 空消息/仅@ 返回玩法介绍', r, '海龟汤玩法');
  check('S1 介绍里私信存题最醒目', r, '存题 汤面');

  // S2 私聊：分步开局
  r = await route(msg('private', 1002, '开局'), '开局');
  check('S2 「开局」无题目进入等待补题', r, '请继续把内容发完');
  r = await route(msg('private', 1002, '汤面：窗外有个人'), '汤面：窗外有个人');
  check('S2 补发汤面后提示还差汤底', r, '汤底');
  r = await route(msg('private', 1002, '汤底：那人是我自己'), '汤底：那人是我自己');
  check('S2 补发汤底自动开局', r, '开局成功');
  r = await route(msg('private', 1002, '导出'), '导出');
  check('S2 「导出」返回开局档案', r, '【开局】');
  r = await route(msg('private', 1002, '我的题'), '我的题');
  check('S2 自出题自动存入题库', r, '窗外有个人');

  // S2b 多段发送（含空行）自动拼接成一题
  r = await route(msg('private', 1004, '开局'), '开局');
  check('S2b 「开局」进入拼接模式', r, '请继续把内容发完');
  r = await route(msg('private', 1004, '汤面：第一段\n\n第二段'), '汤面：第一段\n\n第二段');
  check('S2b 第一段后提示还差汤底', r, '汤底');
  r = await route(msg('private', 1004, '第三段\n汤底：真相A\n\n真相B'), '第三段\n汤底：真相A\n\n真相B');
  check('S2b 拼接完成自动开局', r, '开局成功');

  // S3 同一会话：提问（无Key优雅降级）、扶汤、记录、还原度、复盘、揭晓、重开
  r = await route(msg('private', 1002, '他是自杀的吗？'), '他是自杀的吗？');
  check('S3 提问（无Key）优雅报错且不计数', r, '这一问不计数');
  r = await route(msg('private', 1002, '记录'), '记录');
  check('S3 「记录」显示空记录提示', r, '还没有提问记录');
  r = await route(msg('private', 1002, '看下记录'), '看下记录');
  check('S3 模糊指令「看下记录」→记录', r, '还没有提问记录');
  r = await route(msg('private', 1002, '给我个提示'), '给我个提示');
  check('S3 模糊指令「给我个提示」→扶汤', r, '扶汤');
  r = await route(msg('private', 1002, '扶汤'), '扶汤');
  check('S3 「扶汤」全触及后提示直接复盘', r, '都已触及');
  r = await route(msg('private', 1002, '答案是什么'), '答案是什么');
  check('S3 「答案是什么」走AI识别（无Key降级不计数）', r, '这一问不计数');
  r = await route(msg('private', 1002, '还原度'), '还原度');
  check('S3 「还原度」返回状态行', r, '还原度');
  r = await route(msg('private', 1002, '复盘'), '复盘');
  check('S3 「复盘」进入等待还原', r, '完整还原');
  r = await route(msg('private', 1002, '那个人其实是我自己'), '那个人其实是我自己');
  check('S3 提交还原（无Key）优雅报错', r, '复盘失败');
  r = await route(msg('private', 1002, '揭晓'), '揭晓');
  check('S3 「揭晓」公布汤底并结束', r, '汤底');
  r = await route(msg('private', 1002, '重开'), '重开');
  check('S3 「重开」重置', r, '已重置');
  r = await route(msg('private', 1002, '问题'), '问题');
  check('S3 重置后提问提示未开局', r, '未开始');

  // S4 群聊：单条消息带汤面汤底直接开局
  r = await route(msg('group', 444, '开局 汤面：A 汤底：B'), '开局 汤面：A 汤底：B');
  check('S4 群内一条消息开局', r, '开局成功');
  r = await route(msg('group', 444, '还原度'), '还原度');
  check('S4 群内状态行', r, '还原度');
  r = await route(msg('group', 444, 'Q1？'), 'Q1？');
  check('S4 群内提问走判答分支', r, '这一问不计数');

  // S5 统一题库
  r = await route(msg('private', 2002, '题库'), '题库');
  check('S5 「题库」返回统一列表', r, '题库');
  r = await route(msg('private', 2002, '开局 题库 1'), '开局 题库 1');
  check('S5 「开局 题库 1」开局成功且带标题', r, '题库 · 海龟汤（经典）');
  r = await route(msg('private', 2002, '他是因为想起妻子吗？'), '他是因为想起妻子吗？');
  check('S5 题库提问走判答分支（无Key降级）', r, '这一问不计数');
  r = await route(msg('private', 2002, '题库 99'), '题库 99');
  check('S5 不存在的题库编号给出提示', r, '题库里没有');
  r = await route(msg('private', 2002, '随机一题'), '随机一题');
  check('S5 「随机一题」直接开局', r, '题库 ·');

  // S6 列表别名（海龟汤/我的题 与 题库 一致）
  r = await route(msg('private', 3003, '海龟汤'), '海龟汤');
  check('S6 「海龟汤」返回统一列表', r, '题库');

  // S7 存题（统一题库：内置 1-6，存的是 7 号起）
  r = await route(msg('private', 3003, '存题 标题：测试题 汤面：AA 汤底：BB'), '存题 标题：测试题 汤面：AA 汤底：BB');
  check('S7 私聊「存题」保存成功', r, '已保存');
  r = await route(msg('private', 3003, '题库 测试题'), '题库 测试题');
  check('S7 统一编号「题库 测试题」开玩', r, '题库 · 测试题');
  r = await route(msg('private', 3003, '海龟汤'), '海龟汤');
  check('S7 「海龟汤」列表包含存档题', r, '测试题');
  r = await route(msg('private', 4004, '删题 测试题'), '删题 测试题');
  check('S7 任何人可删（先确认）', r, '确定要删除');
  r = await route(msg('private', 4004, '确认删除'), '确认删除');
  check('S7 「确认删除」完成删除', r, '已删除');
  r = await route(msg('private', 3003, '删题'), '删题');
  check('S7 空「删题」不误删、给格式提示', r, '删除格式');
  r = await route(msg('private', 3003, '删题 1'), '删题 1');
  check('S7 内置题不可删除', r, '不可删除');

  // 还原存档题文件
  if (savedBackup === null) {
    try { fs.rmSync(savedFile, { force: true }); } catch {}
  } else {
    try { fs.writeFileSync(savedFile, savedBackup, 'utf-8'); } catch {}
  }

  console.log('\n结果：' + (failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`));
  process.exit(failed === 0 ? 0 : 1);
})();
