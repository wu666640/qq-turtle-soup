/**
 * 配置加载：优先读 .env 文件，再用进程环境变量覆盖。
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile(file) {
  const result = {};
  if (!fs.existsSync(file)) return result;
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx < 0) continue;
    let k = t.slice(0, idx).trim();
    let v = t.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) result[k] = v;
  }
  return result;
}

const env = { ...loadEnvFile(path.join(__dirname, '..', '.env')), ...process.env };

const config = {
  deepseekApiKey: env.DEEPSEEK_API_KEY || '',
  deepseekModel: env.DEEPSEEK_MODEL || 'deepseek-chat',
  deepseekBaseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  onebotWsUrl: env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001',
  maxQuestions: parseInt(env.MAX_QUESTIONS || '20', 10) || 20,
  // 群里是否必须 @ 机器人才回复（true=要@，false=所有群消息都响应）
  groupRequireAt: env.GROUP_REQUIRE_AT !== 'false',
  adminQids: (env.ADMIN_QIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

module.exports = config;
