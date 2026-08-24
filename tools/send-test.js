/**
 * 联调工具：通过 OneBot 让机器人主动发一条消息（验证发送链路 + 让玩家知道机器人上线了）
 * 用法：
 *   node tools/send-test.js --group <群号> "消息内容"
 *   node tools/send-test.js --user  <QQ号> "消息内容"
 * 前提：NapCat 已登录且 3001 端口在线。
 */
const config = require('../src/config');

function usage() {
  console.log('用法:');
  console.log('  node tools/send-test.js --group <群号> "内容"');
  console.log('  node tools/send-test.js --user  <QQ号> "内容"');
}

(async () => {
  const args = process.argv.slice(2);
  const gi = args.indexOf('--group');
  const ui = args.indexOf('--user');
  let action = null;
  let params = null;
  if (gi >= 0) {
    action = 'send_group_msg';
    params = { group_id: args[gi + 1], message: args[gi + 2] };
  } else if (ui >= 0) {
    action = 'send_private_msg';
    params = { user_id: args[ui + 1], message: args[ui + 2] };
  } else {
    usage();
    process.exit(1);
  }
  if (!params.message) {
    usage();
    process.exit(1);
  }

  console.log(`连接 ${config.onebotWsUrl} …`);
  const ws = new WebSocket(config.onebotWsUrl);
  const timer = setTimeout(() => {
    console.log('❌ 连接/发送超时（NapCat 未开 3001？）');
    process.exit(1);
  }, 10000);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ action, params, echo: 'send-test' }));
  });
  ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.echo === 'send-test') {
        clearTimeout(timer);
        console.log(m.status === 'ok' ? '✅ 发送成功' : `⚠️ 返回: ${JSON.stringify(m)}`);
        ws.close();
        process.exit(m.status === 'ok' ? 0 : 1);
      }
    } catch {}
  });
  ws.addEventListener('error', () => {
    console.log('❌ 连接失败（NapCat 未启动？）');
    clearTimeout(timer);
    process.exit(1);
  });
})();
