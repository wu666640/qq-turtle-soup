/**
 * WS 端到端测试：自建最小 OneBot(WebSocket) 服务器，验证机器人真实连接、收事件、回 API 调用的完整链路。
 * （无 API Key 时走降级路径；不依赖真实 NapCat / DeepSeek / QQ）
 * 运行：node test/ws-e2e.js
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// —— 1. 指向本地伪 NapCat ——
process.env.ONEBOT_WS_URL = 'ws://127.0.0.1:18801';
process.env.DEEPSEEK_API_KEY = '';
// 备份存档题文件，测试结束还原（避免测试污染真实题库）
const savedFile = path.join(__dirname, '..', 'data', 'saved-puzzles.json');
const savedBackup = fs.existsSync(savedFile) ? fs.readFileSync(savedFile, 'utf-8') : null;
const bot = require('../src/index');
bot.connect(); // 显式建立与伪 NapCat 的连接

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + String(detail).slice(0, 40) : ''}`);
  if (!ok) failed += 1;
}

/* ---------- 最小 WebSocket 服务器（RFC6455） ---------- */
function frameEncode(text) {
  const payload = Buffer.from(text, 'utf-8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function attachFrameParser(socket, onText) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const key = buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((b, i) => b ^ key[i % 4]));
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x8) {
        socket.end();
        return;
      } else if (opcode === 0x9) {
        socket.write(frameEncode(''));
      } else if (opcode === 0x1) {
        onText(payload.toString('utf-8'));
      }
    }
  });
}

const server = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('需要 WebSocket 升级');
});

let clientSocket = null;
let pendingResolver = null;
let pendingTimer = null;

function expectNext(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    pendingResolver = { resolve, reject };
    pendingTimer = setTimeout(() => {
      pendingResolver = null;
      reject(new Error('等待机器人 API 调用超时'));
    }, timeoutMs);
  });
}

/** 期望一段时间内没有任何 API 调用（用于验证「没 @ 不回复」） */
function expectSilence(ms = 800) {
  return new Promise((resolve, reject) => {
    pendingResolver = {
      resolve,
      reject: (obj) => reject(new Error('不应有回复，但收到了: ' + JSON.stringify(obj).slice(0, 80))),
    };
    pendingTimer = setTimeout(() => {
      pendingResolver = null;
      resolve();
    }, ms);
  });
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  clientSocket = socket;
  attachFrameParser(socket, (text) => {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (pendingResolver) {
      clearTimeout(pendingTimer);
      const r = pendingResolver;
      pendingResolver = null;
      r.resolve(obj);
    }
  });
});

/* ---------- 测试流程 ---------- */
server.listen(18801, async () => {
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('机器人未连接')), 6000);
      const iv = setInterval(() => {
        if (clientSocket) {
          clearTimeout(t);
          clearInterval(iv);
          resolve();
        }
      }, 50);
    });
    console.log('  [server] 机器人已连接 ✅');

    const sendEvent = (group_id, user_id, text, at = false) =>
      clientSocket.write(
        frameEncode(
          JSON.stringify({
            post_type: 'message',
            message_type: 'group',
            group_id,
            user_id,
            self_id: 10001,
            message: at
              ? [
                  { type: 'at', data: { qq: '10001' } },
                  { type: 'text', data: { text } },
                ]
              : [{ type: 'text', data: { text } }],
            raw_message: at ? `[CQ:at,qq=10001] ${text}` : text,
          })
        )
      );

    // 0. 群里没 @ 机器人 → 不回复
    sendEvent(555, 1001, '随便聊聊', false);
    await expectSilence(800);
    check('群消息未 @ 机器人 → 不回复', true);

    // 0b. 只 @ 机器人（无文字）→ 玩法介绍
    clientSocket.write(
      frameEncode(
        JSON.stringify({
          post_type: 'message',
          message_type: 'group',
          group_id: 555,
          user_id: 1001,
          self_id: 10001,
          message: [{ type: 'at', data: { qq: '10001' } }],
          raw_message: '[CQ:at,qq=10001]',
        })
      )
    );
    const apiAt = await expectNext();
    check(
      '只 @ 机器人（无文字）→ 玩法介绍',
      apiAt.action === 'send_group_msg' && apiAt.params.message.includes('海龟汤玩法'),
      apiAt.params.message
    );

    // 1. 规则（@ 机器人）
    sendEvent(555, 1001, '规则', true);
    let api = await expectNext();
    check(
      '群消息 @机器人「规则」→ 返回帮助',
      api.action === 'send_group_msg' && api.params.message.includes('海龟汤玩法'),
      api.params.message
    );

    // 2. 开局（@ 机器人）
    sendEvent(555, 1001, '开局 汤面：A 汤底：B', true);
    api = await expectNext();
    check(
      '群消息 @机器人「开局」→ 返回开局成功',
      api.action === 'send_group_msg' && api.params.message.includes('开局成功'),
      api.params.message
    );

    // 3. 提问（@ 机器人，无 Key 走降级）
    sendEvent(555, 1002, '他是谁？', true);
    api = await expectNext();
    check(
      '群消息 @机器人提问 → 降级提示且不计数',
      api.action === 'send_group_msg' && api.params.message.includes('这一问不计数'),
      api.params.message
    );

    // 4. 私聊（不需要 @）
    clientSocket.write(
      frameEncode(
        JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          user_id: 3001,
          self_id: 10001,
          message: [{ type: 'text', data: { text: '记录' } }],
          raw_message: '记录',
        })
      )
    );
    api = await expectNext();
    check(
      '私聊「记录」→ 独立会话未开局提示（会话隔离）',
      api.action === 'send_private_msg' && api.params.message.includes('本局未开始'),
      api.params.message
    );

    console.log('\n结果：' + (failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`));
  } catch (e) {
    console.error('WS 测试异常:', e.message);
    failed += 1;
  } finally {
    // 还原存档题文件（防止测试污染真实题库）
    if (savedBackup === null) {
      try { fs.rmSync(savedFile, { force: true }); } catch {}
    } else {
      try { fs.writeFileSync(savedFile, savedBackup, 'utf-8'); } catch {}
    }
    bot.shutdown();
    if (clientSocket) clientSocket.destroy();
    server.closeAllConnections?.();
    server.close();
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 200);
  }
});
