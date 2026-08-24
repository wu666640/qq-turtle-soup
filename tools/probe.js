/**
 * OneBot 探测工具：查看机器人账号状态、好友/群列表，并短暂监听消息流（联调验证用）
 * 用法：node tools/probe.js [监听秒数，默认 15]
 */
const config = require('../src/config');

const listenSeconds = parseInt(process.argv[2] || '15', 10);

const ws = new WebSocket(config.onebotWsUrl);
let echoCount = 0;

function call(action, params = {}) {
  const echo = 'p' + ++echoCount;
  ws.send(JSON.stringify({ action, params, echo }));
}

ws.addEventListener('open', () => {
  console.log('已连接 OneBot ✅\n');
  call('get_login_info');
  call('get_friend_list');
  call('get_group_list');
  console.log(`开始监听消息流 ${listenSeconds} 秒（能看到推给机器人的消息）…`);
});

ws.addEventListener('message', (ev) => {
  let m;
  try {
    m = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  if (m.echo) {
    if (m.echo === 'p1') {
      const d = m.data || {};
      console.log(`[机器人账号] QQ=${d.user_id} 昵称=${d.nickname} 在线=${d.user_id ? '✓' : '?'}`);
    } else if (m.echo === 'p2') {
      const list = m.data || [];
      console.log(`[好友] ${list.length} 个：${list.slice(0, 8).map((f) => `${f.nickname}(${f.user_id})`).join('、')}${list.length > 8 ? '…' : ''}`);
    } else if (m.echo === 'p3') {
      const list = m.data || [];
      console.log(`[群] ${list.length} 个：${list.slice(0, 8).map((g) => `${g.group_name}(${g.group_id})`).join('、')}${list.length > 8 ? '…' : ''}`);
    }
  } else if (m.post_type === 'message') {
    const who = m.message_type === 'group' ? `群${m.group_id}` : `私聊`;
    const from = m.user_id;
    const text = (Array.isArray(m.message) ? m.message.map((s) => s.data?.text || '').join('') : m.raw_message || '').trim();
    console.log(`\n[消息] ${who} 来自${from}：${text.slice(0, 80)}`);
  }
});

ws.addEventListener('error', () => {
  console.log('❌ 连接失败（NapCat 未运行或 3001 未开）');
  process.exit(1);
});

setTimeout(() => {
  console.log('\n监听结束');
  ws.close();
  process.exit(0);
}, listenSeconds * 1000);
