/**
 * 海龟汤 QQ 机器人 · 桥接服务（OneBot v11 正向 WebSocket 客户端）
 * 依赖：Node >= 22（使用内置 WebSocket 与 fetch，零 npm 依赖）
 *
 * 连接 NapCat 的 WebSocket 服务器（默认 ws://127.0.0.1:3001），
 * 私聊 / 群消息均支持，每会话独立一局。
 */
const config = require('./config');
const host = require('./host');
const puzzles = require('./puzzles');
const fs = require('fs');
const path = require('path');

const RECORDS_DIR = path.join(__dirname, '..', 'records');
fs.mkdirSync(RECORDS_DIR, { recursive: true });

/** 每会话一份提问档案文件（重启不丢，方便复盘） */
function recordFile(key) {
  return path.join(RECORDS_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.txt');
}

function appendRecord(key, line) {
  try {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    fs.appendFileSync(recordFile(key), `[${stamp}] ${line}\n`, 'utf-8');
  } catch (e) {
    console.error('[bot] 写入记录失败:', e.message);
  }
}

function readRecord(key) {
  try {
    const f = recordFile(key);
    if (!fs.existsSync(f)) return '';
    return fs.readFileSync(f, 'utf-8');
  } catch (e) {
    return `读取失败: ${e.message}`;
  }
}

/* ================= 存档题（私聊存题，群里开玩） ================= */

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const SAVED_FILE = path.join(DATA_DIR, 'saved-puzzles.json');

function loadSaved() {
  try {
    if (!fs.existsSync(SAVED_FILE)) return [];
    const arr = JSON.parse(fs.readFileSync(SAVED_FILE, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[bot] 读取存档题失败:', e.message);
    return [];
  }
}

function persistSaved(list) {
  try {
    fs.writeFileSync(SAVED_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) {
    console.error('[bot] 保存存档题失败:', e.message);
  }
}

/* ================= 统一题库（内置 + 存档，连续编号） ================= */

const BUILTIN_COUNT = puzzles.PUZZLES.length;

/** 合并后的完整题库（内置 1..N，存档 N+1..） */
function unifiedList() {
  const saved = loadSaved();
  return [
    ...puzzles.PUZZLES.map((p, i) => ({ ...p, displayId: i + 1, kind: 'builtin' })),
    ...saved.map((p, i) => ({ ...p, displayId: BUILTIN_COUNT + i + 1, kind: 'saved' })),
  ];
}

/** 按统一序号或标题查找题目 */
function findUnified(arg) {
  const n = parseInt(arg, 10);
  if (!Number.isNaN(n)) {
    if (n >= 1 && n <= BUILTIN_COUNT) {
      const p = puzzles.PUZZLES[n - 1];
      return { ...p, displayId: n, kind: 'builtin' };
    }
    const saved = loadSaved();
    const idx = n - BUILTIN_COUNT - 1;
    if (idx >= 0 && idx < saved.length) return { ...saved[idx], displayId: n, kind: 'saved' };
    return null;
  }
  const title = arg.trim();
  let idx = puzzles.PUZZLES.findIndex((p) => p.title.includes(title));
  if (idx >= 0) {
    const p = puzzles.PUZZLES[idx];
    return { ...p, displayId: idx + 1, kind: 'builtin' };
  }
  const saved = loadSaved();
  idx = saved.findIndex((p) => p.title.includes(title));
  if (idx >= 0) return { ...saved[idx], displayId: BUILTIN_COUNT + idx + 1, kind: 'saved' };
  return null;
}

const chats = new Map(); // chatKey -> session

/* ================= 会话 ================= */

function newSession() {
  return {
    phase: 'idle', // idle | setup | playing | review | finished
    surface: '',
    bottom: '',
    keyPoints: [], // { t, state: 'untouched'|'touched' }
    questions: [], // { n, q, a }
    hints: [],
    remaining: config.maxQuestions,
    setupBuffer: { text: '' },
    pendingDelete: null,
    caseAnalysis: null,
  };
}

function getSession(key) {
  if (!chats.has(key)) chats.set(key, newSession());
  return chats.get(key);
}

function chatKey(msg) {
  return msg.message_type === 'group' ? `g:${msg.group_id}` : `p:${msg.user_id}`;
}

/* ================= 状态计算 ================= */

function restoration(s) {
  if (!s.keyPoints.length) return 0;
  const touched = s.keyPoints.filter((p) => p.state === 'touched').length;
  return Math.round((touched / s.keyPoints.length) * 100);
}

function touchedCount(s) {
  return s.keyPoints.filter((p) => p.state === 'touched').length;
}

function statusLine(s) {
  return `【还原度 ${restoration(s)}%】关键点 ${touchedCount(s)}/${s.keyPoints.length} · 剩余提问 ${s.remaining}`;
}

function recordList(s) {
  if (!s.questions.length) return '还没有提问记录。';
  const lines = s.questions
    .slice(-20)
    .map((it) => `Q${it.n} ${it.q}\n→ ${it.a}`);
  return `📋 提问记录（共 ${s.questions.length} 条）：\n` + lines.join('\n');
}

/** 每次回答自动附带的「已提问」清单（最近 max 条，随时可见无需指令） */
function recordBlock(s, max = 6) {
  if (!s.questions.length) return '';
  const items = s.questions.slice(-max).map((it) => `Q${it.n} ${it.q} → ${it.a}`);
  const head = s.questions.length > max ? `📋 已提问 ${s.questions.length} 条（最近 ${max}）` : `📋 已提问 ${s.questions.length} 条`;
  const tail = s.questions.length > max ? `\n（发「记录」看全部）` : '';
  return `\n${head}：\n` + items.join('\n') + tail;
}

/* ================= 指令处理 ================= */

/** 模糊指令匹配：完全相等、或以关键词开头/结尾都算命中（如「看下记录」「给我个提示」） */
function matchCmd(lower, keywords) {
  for (const k of keywords) {
    if (lower === k || lower.startsWith(k) || lower.endsWith(k)) return true;
  }
  return false;
}

function parsePair(text) {
  const m = text.match(/汤面[：:]\s*([\s\S]*?)\s*汤底[：:]\s*([\s\S]*)/);
  if (m && m[1].trim() && m[2].trim()) return { surface: m[1].trim(), bottom: m[2].trim() };
  return null;
}

function helpText() {
  return (
    '🐢 海龟汤玩法介绍\n\n' +
    '🔥🔥 重点：想出题给朋友玩？私信我存题！ 🔥🔥\n' +
    '  私信机器人发：\n' +
    '  📥 「存题 汤面：… 汤底：…」\n' +
    '  或直接「开局 汤面：… 汤底：…」（自动存进题库）\n' +
    '  存好后，群里 @机器人：「开局 题库 序号」，朋友就能提问啦～\n' +
    '──────────────────\n' +
    '随机：发「随机一题」我随便出一道（零输入）\n' +
    '题库：发「题库」看全部题目（内置+你们存的），发「开局 题库 序号」开玩\n' +
    '提问：直接发问题，我只答 是/不是/无关 + 还原度\n' +
    '扶汤：发「扶汤」拿提示\n' +
    '记录：发「记录」看提问记录\n' +
    '复盘：发「复盘」后发完整还原，判定是否大致准确\n' +
    '揭晓：发「揭晓」直接看答案\n' +
    '删题：发「删题 序号」删除自己加的题（二次确认）\n' +
    '重开：发「重开」开新局'
  );
}

async function startGame(s, key, surface, bottom, title = '', ownerId = '', analysis = null) {
  s.surface = surface;
  s.bottom = bottom;
  s.phase = 'playing';
  s.questions = [];
  s.hints = [];
  s.remaining = config.maxQuestions;
  s.keyPoints = [];
  s.caseAnalysis = analysis;
  let difficulty = 3;
  try {
    const points = await host.extractKeyPoints(bottom);
    s.keyPoints = points.map((t) => ({ t, state: 'untouched' }));
    difficulty = points.difficulty || 3;
  } catch (e) {
    console.error('[bot] 提取关键点失败:', e.message);
    s.keyPoints = [{ t: '（关键点提取失败，还原度按有效触及估算）', state: 'untouched' }];
  }
  // 汤底理解笔记（开局生成一次，全程判答用；已有则复用）
  if (!s.caseAnalysis) {
    try {
      s.caseAnalysis = await host.analyzeCase(surface, bottom);
    } catch (e) {
      console.error('[bot] 汤底理解笔记生成失败:', e.message);
      s.caseAnalysis = null;
    }
  }
  // 提问次数 = 按关键点数 + 难度 + 篇幅动态计算（15~50）
  const pts = s.keyPoints.length;
  const totalLen = (surface + bottom).length;
  const lenBonus = totalLen >= 1000 ? 6 : totalLen >= 500 ? 3 : 0;
  const diffBonus = Math.round((difficulty - 1) * 2.5);
  s.remaining = Math.max(15, Math.min(50, 12 + pts * 2 + diffBonus + lenBonus));
  const notesLine = s.caseAnalysis
    ? `\n【汤底理解笔记】${s.caseAnalysis.summary || ''}${
        Array.isArray(s.caseAnalysis.pitfalls) && s.caseAnalysis.pitfalls.length
          ? '\n易混淆点：' + s.caseAnalysis.pitfalls.map((p) => `「${p.ask}」→${p.answer}`).join('；')
          : ''
      }`
    : '';
  appendRecord(
    key,
    `【开局】${title || '自出题'}\n汤面：${surface}\n（汤底已封存，共 ${s.keyPoints.length} 个关键点，难度 ${difficulty} 星，提问 ${s.remaining} 次）${notesLine}`
  );
  const head = title ? `📚 ${title}\n\n` : '';
  let savedNote = '';
  if (!title) {
    // 作者模式自出题：自动存入题库（存档题），重复的不重复存
    const saved = loadSaved();
    const dup = saved.find((x) => x.surface === surface);
    if (dup) {
      savedNote = `（题库里已有此题《${dup.title}》，未重复保存）`;
    } else {
      const autoTitle = (surface.trim().split('\n')[0].trim().slice(0, 15)) || '未命名';
      saved.push({ id: saved.length + 1, title: autoTitle, surface, bottom, owner: ownerId || 'auto', caseAnalysis: s.caseAnalysis || null });
      persistSaved(saved);
      savedNote = `（已自动存入「我的题」《${autoTitle}》，可随时重玩）`;
    }
  }
  return (
    head +
    `🍲 开局成功！汤底已封存（${s.keyPoints.length} 个关键真相点，保密）。\n` +
    savedNote +
    `\n\n【汤面】\n${surface}\n\n` +
    `开始提问吧，我只答 是/不是/无关（限 ${s.remaining} 问 · 难度 ${difficulty} 星）。发「规则」看全部指令；不想猜了随时发「揭晓」直接看汤底。`
  );
}

/** AI 智能理解消息：指令直接执行，问题判答（一次调用完成） */
async function doMessage(s, key, message) {
  let r;
  try {
    r = await host.understand(s.bottom, s.surface, s.keyPoints.map((p) => p.t), message, s.caseAnalysis);
  } catch (e) {
    return `⚠️ 理解失败（${e.message}），这一问不计数，请重试。`;
  }

  // —— 指令 ——
  if (r && r.type === 'command') {
    switch (r.command) {
      case 'hint':
        return doHint(s, key);
      case 'records':
        return recordList(s);
      case 'status':
        return statusLine(s);
      case 'review':
        s.phase = 'review';
        return '🧾 请把完整还原发给我（一段话），我逐点判定是否大致准确；不想复盘就发「揭晓」直接看汤底。';
      case 'reveal':
        return doReveal(s, key, '😱 不想猜了，直接揭晓：');
      case 'restart':
        chats.set(key, newSession());
        appendRecord(key, '—— 新一局 ——');
        return '🔄 已重置本局。发「开局 汤面：… 汤底：…」开新局。';
      case 'help':
      default:
        return helpText();
    }
  }

  // —— 问题 ——
  const verdict = (r && r.verdict) || '无关';
  const touchedRaw = (Array.isArray(r && r.touched) ? r.touched : [])
    .map((i) => parseInt(i, 10) - 1)
    .filter((i) => i >= 0 && i < s.keyPoints.length);
  // 非关键问题 / 元问题（清汤红汤）一律不点亮关键点
  const metaVerdict = verdict === '红汤' || verdict === '清汤';
  const touched = metaVerdict || (r && r.important === false) ? [] : touchedRaw.slice(0, 3);
  const guide = (r && r.guide) || '';
  // 能回答但没问到破案关键 → 回答后补一句「不是重点」（仅对 是/不是；无关本身已说明不重要）
  const notKey =
    (verdict === '是' || verdict === '不是') && touched.length === 0 && r && r.important === false;

  // 模糊问题：给出引导，不消耗提问次数
  if (verdict === '模糊') {
    s.questions.push({ n: s.questions.length + 1, q: message, a: '模糊' });
    appendRecord(key, `Q${s.questions.length} ${message} → 模糊（已引导问具体）`);
    const g = guide || '你能说得具体一点吗？';
    return `🤔 这个问题有点模糊或太宽泛：${g}\n（这一问不计数，试着拆成具体的是/否小问题再问）\n${recordBlock(s)}`;
  }

  if (s.remaining <= 0) return '⛔ 提问次数已用完！可「扶汤」、「复盘」，或发「揭晓」直接看汤底。';
  s.remaining -= 1;
  const newly = touched.filter((i) => s.keyPoints[i] && s.keyPoints[i].state === 'untouched');
  const already = touched.length - newly.length;
  touched.forEach((i) => {
    if (s.keyPoints[i]) s.keyPoints[i].state = 'touched';
  });
  s.questions.push({ n: s.questions.length + 1, q: message, a: verdict });
  appendRecord(
    key,
    `Q${s.questions.length} ${message} → ${verdict}${newly.length ? `（新触及+${newly.length}）` : already ? '（已触及过）' : ''}`
  );
  let out = `→ ${verdict}`;
  if (newly.length) out += `（触及关键点 +${newly.length}）`;
  else if (already) out += `（这些点之前已触及过）`;
  out += `\n${statusLine(s)}`;
  if (notKey) out += `\n（顺带一提：这个不是破案关键，不影响还原度）`;
  out += recordBlock(s);
  return out;
}

async function doHint(s, key) {
  const idx = s.keyPoints.findIndex((p) => p.state === 'untouched');
  if (idx === -1) return '所有关键点都已触及，直接「复盘」吧！';
  const hint = await host.generateHint(s.bottom, s.keyPoints.map((p) => p.t), idx);
  s.hints.push(hint);
  s.keyPoints[idx].state = 'touched';
  appendRecord(key, `🥄 扶汤（第 ${s.hints.length} 次）：${hint}`);
  return `🥄 扶汤（第 ${s.hints.length} 次）：${hint}\n${statusLine(s)}`;
}

function doReveal(s, key, prefix) {
  s.phase = 'finished';
  const hintInfo = s.hints.length ? `，扶汤 ${s.hints.length} 次` : '';
  const summary = `还原度 ${restoration(s)}%（${touchedCount(s)}/${s.keyPoints.length} 关键点${hintInfo}）`;
  appendRecord(key, `【${prefix}】\n${summary}\n汤底：${s.bottom}`);
  return (
    `${prefix}\n\n【汤底】\n${s.bottom}\n\n` +
    `本局结束时${summary}。发「重开」再玩一局。`
  );
}

async function doReview(s, key, guess) {
  let points = [];
  let comment = '';
  try {
    const r = await host.reviewGuess(s.bottom, s.keyPoints.map((p) => p.t), guess);
    points = r.points || [];
    comment = r.comment || '';
  } catch (e) {
    return `⚠️ 复盘失败（${e.message}），可再发一次；或发「揭晓」直接看答案。`;
  }
  const weight = { 准确: 1, 部分: 0.5, 缺失: 0, 错误: 0 };
  let sum = 0;
  const lines = [];
  for (const p of points) {
    const v = p.verdict || '缺失';
    sum += weight[v] ?? 0;
    const pointText = s.keyPoints[p.i - 1] ? s.keyPoints[p.i - 1].t : '';
    lines.push(`${v} ${pointText}${p.note ? '（' + p.note + '）' : ''}`);
  }
  const total = points.length || s.keyPoints.length || 1;
  const pct = Math.round((sum / total) * 100);
  const verdict = pct >= 80 ? '🎉 大致准确' : pct >= 55 ? '🧩 部分还原' : '🌫️ 偏差较大';
  s.phase = 'finished';
  appendRecord(key, `【复盘】玩家还原：${guess}\n判定：${verdict}（还原度 ${pct}%）\n汤底：${s.bottom}`);
  return (
    `🧾 复盘判定：${verdict}（还原度 ${pct}%）\n` +
    (comment ? `点评：${comment}\n` : '') +
    lines.join('\n') +
    `\n\n【汤底】\n${s.bottom}\n\n发「重开」再玩一局。`
  );
}

async function route(msg, text) {
  const key = chatKey(msg);
  const s = getSession(key);
  // 只有 @ 没有文字（或空消息）→ 弹出玩法介绍
  if (!text || !text.trim()) return helpText();
  const lower = text.replace(/\s+/g, '').replace(/[，。？！,.!?：:；;、~～…·"'“”‘’()（）【】\-]/g, '');

  // —— 全局指令 ——
  if (lower === '规则' || lower === '帮助' || lower === 'help' || lower === '怎么玩') {
    return helpText();
  }
  if (matchCmd(lower, ['重开', '再来一局', '新局', '开新局', '换一题', '换题', '重新开始', '新的一局', '再来一题'])) {
    chats.set(key, newSession());
    appendRecord(key, '—— 新一局 ——');
    return '🔄 已重置本局。发「开局 汤面：… 汤底：…」开新局。';
  }
  if (lower === '导出' || lower === '复盘档案') {
    const content = readRecord(key);
    if (!content) return '还没有记录。玩一局后发「导出」即可看到完整问答档案。';
    return `📄 本会话完整问答档案（也可直接打开文件：${recordFile(key)}）：\n\n${content}`;
  }

  // —— 随机一题（从统一题库随机出）——
  if (lower === '随机一题' || lower === '来一题' || lower === '随机题' || lower === '随便来一题') {
    const list = unifiedList();
    const pick = list[Math.floor(Math.random() * list.length)];
    return startGame(s, key, pick.surface, pick.bottom, `题库 · ${pick.title}`, String(msg.user_id), pick.caseAnalysis || null);
  }

  // —— 存题（添加新题到统一题库）——
  if (lower.startsWith('存题') && text.includes('汤面')) {
    const rest = text.replace(/^(开局\s*)?存题\s*/, '');
    const m = rest.match(/^(?:标题[：:]\s*(.+?)\s+)?汤面[：:]\s*([\s\S]*?)\s*汤底[：:]\s*([\s\S]*)$/);
    if (!m || !m[2].trim() || !m[3].trim()) {
      return '存题格式：存题 汤面：… 汤底：…\n（可加标题：存题 标题：xxx 汤面：… 汤底：…）';
    }
    const title = (m[1] ? m[1].trim() : m[2].trim().split('\n')[0].trim().slice(0, 15)) || '未命名';
    const saved = loadSaved();
    saved.push({ id: saved.length + 1, title, surface: m[2].trim(), bottom: m[3].trim(), owner: String(msg.user_id) });
    persistSaved(saved);
    const displayId = BUILTIN_COUNT + saved.length;
    return `📥 已保存《${title}》（题库第 ${displayId} 题）。\n发「开局 题库 ${displayId}」开玩；「题库」看全部；「删题 ${displayId}」删除。`;
  }

  // —— 题库列表（内置 + 存档统一展示）——
  if (lower === '题库' || lower === '海龟汤' || lower === '列表' || lower === '题目列表' || lower === '有哪些题' || lower === '我的题' || lower === '存档题') {
    const list = unifiedList();
    if (!list.length) return '题库还是空的。发「存题 汤面：… 汤底：…」加一题。';
    return (
      '📚 题库（共 ' +
      list.length +
      ' 题）：\n' +
      list.map((p) => `${p.displayId}. ${p.title}${p.kind === 'builtin' ? `（${p.style}）` : ''}`).join('\n') +
      '\n\n开玩：发「开局 题库 序号」（或「随机一题」）；「存题 汤面：… 汤底：…」加新题；「删题 序号」删除。'
    );
  }

  // —— 题库开局（题库 n / 题库 标题 / 存题 n / 开局 题库 n，统一编号）——
  if (/^开局(题库|存题)/.test(lower) || /^题库\S/.test(lower) || /^存题\S/.test(lower) || (/^存题/.test(lower) && !text.includes('汤面'))) {
    const m = text.match(/(题库|存题)\s*[:：]?\s*(\S+)/);
    const arg = m ? m[2].trim() : '';
    const list = unifiedList();
    if (!arg) {
      if (!list.length) return '题库还是空的。发「存题 汤面：… 汤底：…」加一题。';
      return (
        '📚 题库（共 ' + list.length + ' 题）：\n' +
        list.map((p) => `${p.displayId}. ${p.title}`).join('\n') +
        '\n\n发「开局 题库 序号」开玩'
      );
    }
    const p = findUnified(arg);
    if (!p) return `题库里没有「${arg}」。发「题库」看列表。`;
    return startGame(s, key, p.surface, p.bottom, `题库 · ${p.title}`, String(msg.user_id), p.caseAnalysis || null);
  }

  // —— 删题（统一编号，内置题不可删）——
  if (lower.startsWith('删题')) {
    const arg = text.replace(/^删题\s*/, '').trim();
    if (!arg) {
      const list = unifiedList();
      if (!list.length) return '题库是空的。';
      return (
        '🗑️ 删除格式：删题 序号 或 删题 标题\n\n' +
        list.map((p) => `${p.displayId}. ${p.title}`).join('\n') +
        '\n\n例如：删题 7'
      );
    }
    const p = findUnified(arg);
    if (!p) return `题库里没有「${arg}」。发「题库」看列表。`;
    if (p.kind === 'builtin') return `⚠️ 内置题《${p.title}》不可删除，只能删除自己添加的题（题库序号 ${BUILTIN_COUNT + 1} 以后）。`;
    s.pendingDelete = p.title;
    return `⚠️ 确定要删除《${p.title}》吗？\n回复「确认删除」完成；回复其他内容则取消。`;
  }
  if (lower === '确认删除') {
    if (!s.pendingDelete) return '当前没有待确认的删除操作。';
    const saved = loadSaved();
    const idx = saved.findIndex((p) => p.title === s.pendingDelete);
    const title = s.pendingDelete;
    s.pendingDelete = null;
    if (idx < 0) return `《${title}》已不存在（可能已删过）。`;
    const removed = saved.splice(idx, 1)[0];
    persistSaved(saved);
    return `🗑️ 已删除《${removed.title}》。`;
  }

  // —— 开局 ——
  if (lower.startsWith('开局') || lower.startsWith('开汤') || lower.startsWith('开新局')) {
    if (config.adminQids.length && !config.adminQids.includes(String(msg.user_id))) {
      return '⛔ 只有管理员可以开局。';
    }
    const pair = parsePair(text);
    if (pair) return startGame(s, key, pair.surface, pair.bottom, '', String(msg.user_id));
    // 一次发不全（长文可能被 QQ 拆成多条）：进入拼接模式，把本次内容先收下
    s.phase = 'setup';
    s.setupBuffer = { text: text.replace(/^(开局|开汤|开新局)\s*/, '') };
    return '🍲 收到。请继续把内容发完（按「汤面：…」「汤底：…」标记分段，空行不影响），发齐自动开局；也可以直接一次发「开局 汤面：… 汤底：…」。';
  }

  // —— setup 阶段：自动拼接多条消息（长文/空行都行）——
  if (s.phase === 'setup') {
    s.setupBuffer.text = ((s.setupBuffer.text || '') + '\n' + text).trim();
    const pair = parsePair(s.setupBuffer.text);
    if (pair) {
      s.setupBuffer = { text: '' };
      return startGame(s, key, pair.surface, pair.bottom, '', String(msg.user_id));
    }
    const hasSurface = /汤面[：:]/.test(s.setupBuffer.text);
    const hasBottom = /汤底[：:]/.test(s.setupBuffer.text);
    const missing = [];
    if (!hasSurface) missing.push('汤面');
    if (!hasBottom) missing.push('汤底');
    return `收到！继续发剩下的部分（还差：${missing.join('、')}），发齐自动开局～`;
  }

  // —— 未开局 ——
  if (s.phase === 'idle') {
    const pair = parsePair(text);
    if (pair) return startGame(s, key, pair.surface, pair.bottom, '', String(msg.user_id));
    return '本局未开始。发「开局 汤面：… 汤底：…」开局；发「规则」看玩法。';
  }

  // —— playing 阶段：本地快路径 + AI 智能兜底 ——
  if (s.phase === 'playing') {
    if (matchCmd(lower, ['提问记录', '问答记录', '历史记录', '记录', '问了什么'])) return recordList(s);
    if (matchCmd(lower, ['扶汤', '提示', '给点提示', '帮帮我', '给我提示', '提示一下'])) return doHint(s, key);
    if (matchCmd(lower, ['复盘', '总结一下', '还原一下', '给出还原', '我的还原'])) {
      s.phase = 'review';
      return '🧾 请把完整还原发给我（一段话），我逐点判定是否大致准确；不想复盘就发「揭晓」直接看汤底。';
    }
    if (matchCmd(lower, ['直接看答案', '看答案', '公布答案', '揭晓', '汤底', '看汤底', '不想玩了', '不想猜', '放弃', '不玩了'])) {
      return doReveal(s, key, '😱 不想猜了，直接揭晓：');
    }
    if (matchCmd(lower, ['还原度', '进度', '当前状态', '状态'])) return statusLine(s);
    // 其余消息交给 AI 智能识别（指令或问题一次判断）
    return doMessage(s, key, text);
  }

  // —— review 阶段：下一条消息即完整还原 ——
  if (s.phase === 'review') {
    if (lower === '揭晓' || lower === '放弃' || lower === '答案' || lower === '直接看答案' || lower === '看汤底' || lower === '不想玩了' || lower === '汤底') {
      return doReveal(s, key, '😱 不想复盘了，直接揭晓：');
    }
    return doReview(s, key, text);
  }

  // —— finished ——
  if (s.phase === 'finished') {
    return '本局已结束。发「重开」开新局。';
  }
  return helpText();
}

/* ================= OneBot 客户端 ================= */

function extractText(msg) {
  const segs = Array.isArray(msg.message) ? msg.message : [];
  if (segs.length) {
    // 有分段：只取文本段（@ 等非文本段忽略；只有 @ 时返回空串）
    return segs
      .filter((s) => s && s.type === 'text' && typeof s.data?.text === 'string')
      .map((s) => s.data.text)
      .join('\n')
      .trim();
  }
  // 无分段：回退 raw_message 并去掉 CQ 码
  return String(msg.raw_message || '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .trim();
}

/** 群消息是否 @ 了机器人（含 @全体） */
function isAtBot(evt) {
  const segs = Array.isArray(evt.message) ? evt.message : [];
  for (const s of segs) {
    if (s && s.type === 'at') {
      const qq = String((s.data && s.data.qq) || '');
      if (qq === 'all' || qq === String(evt.self_id)) return true;
    }
  }
  const m = String(evt.raw_message || '').match(/\[CQ:at,qq=(\d+|all)\]/);
  if (m) return m[1] === 'all' || m[1] === String(evt.self_id);
  return false;
}

function reply(ws, msg, text) {
  const action = msg.message_type === 'group' ? 'send_group_msg' : 'send_private_msg';
  const params =
    msg.message_type === 'group'
      ? { group_id: msg.group_id, message: text }
      : { user_id: msg.user_id, message: text };
  ws.send(JSON.stringify({ action, params, echo: `${Date.now()}-${Math.random().toString(16).slice(2)}` }));
}

let currentWs = null;
let reconnectTimer = null;
/** 每会话独立消息队列：一个群的慢消息不会阻塞其他群 */
const chatQueues = new Map();
const heartbeatTimer = setInterval(() => {
  // 客户端 API 无法主动 ping，仅记录连接状态
  if (currentWs) console.log(`[bot] 心跳检查: ${currentWs.readyState === 1 ? '在线' : '断开'}`);
}, 60000);
heartbeatTimer.unref(); // 不占用事件循环，避免进程无法退出

function connect() {
  console.log(`[bot] 连接 OneBot WS: ${config.onebotWsUrl}`);
  const ws = new WebSocket(config.onebotWsUrl);
  currentWs = ws;

  ws.addEventListener('open', () => {
    console.log('[bot] ✅ 已连接 NapCat，等待消息…');
  });

  ws.addEventListener('message', (ev) => {
    let evt;
    try {
      evt = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (evt.post_type === 'message' && evt.message_type) {
      // 群聊 @ 过滤：配置开启时，群里没 @ 机器人就不理会（私聊不受影响）
      const atHit = isAtBot(evt);
      // 事件日志：诊断用（每条消息落盘，标注 @ 是否命中）
      try {
        const t = extractText(evt);
        fs.appendFileSync(
          path.join(RECORDS_DIR, 'events.log'),
          `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${evt.message_type === 'group' ? `群${evt.group_id}` : `私聊${evt.user_id}`} 来自${evt.user_id} @=${atHit ? '命中' : '未命中'} 内容=${(t || '(仅@)').slice(0, 60)}\n`,
          'utf-8'
        );
      } catch {}
      if (config.groupRequireAt && evt.message_type === 'group' && !atHit) return;
      const qkey = evt.message_type === 'group' ? `g:${evt.group_id}` : `p:${evt.user_id}`;
      if (!chatQueues.has(qkey)) chatQueues.set(qkey, Promise.resolve());
      chatQueues.set(
        qkey,
        chatQueues
          .get(qkey)
          .then(async () => {
            const text = extractText(evt);
            const who = evt.message_type === 'group' ? `群${evt.group_id}` : `私聊${evt.user_id}`;
            console.log(`[收到 ${who}] ${(text || '(仅@)').slice(0, 80)}`);
            const out = await route(evt, text);
            if (out) {
              console.log(`[回复 ${who}] ${out.replace(/\n/g, ' ').slice(0, 80)}`);
              reply(ws, evt, out);
            }
          })
          .catch((e) => {
            console.error('[bot] 处理消息出错:', e);
            try {
              reply(ws, evt, `⚠️ 出错了：${e.message}`);
            } catch {}
          })
      );
    }
  });

  ws.addEventListener('close', () => {
    console.log('[bot] 连接断开，3 秒后重连…');
    reconnectTimer = setTimeout(connect, 3000);
  });
  ws.addEventListener('error', (e) => {
    console.error('[bot] WS 错误:', e.message || '未知错误');
  });
}

/** 优雅停止：清掉重连定时器并关闭当前连接（测试/退出用） */
function shutdown() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (currentWs && currentWs.readyState === 1) currentWs.close();
  currentWs = null;
}

if (!config.deepseekApiKey) {
  console.warn('[bot] ⚠️ 未配置 DEEPSEEK_API_KEY：判答会失败。请复制 .env.example 为 .env 并填写。');
}

if (require.main === module) {
  connect();
}

module.exports = { route, newSession, extractText, parsePair, helpText, connect, shutdown };
