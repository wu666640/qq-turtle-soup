/**
 * DeepSeek 主持人：判答 / 提取关键点 / 扶汤 / 复盘
 */
const config = require('./config');

async function callDeepSeek(messages, { json = false, temperature = 0.3, timeoutMs = 45000 } = {}) {
  if (!config.deepseekApiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY（请复制 .env.example 为 .env 并填写）');
  }
  const body = {
    model: config.deepseekModel,
    messages,
    temperature,
    stream: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseekApiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`DeepSeek API ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('DeepSeek 返回为空');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function safeParseJSON(content) {
  let c = String(content).replace(/```json|```/g, '').trim();
  const start = c.indexOf('{');
  const end = c.lastIndexOf('}');
  if (start >= 0 && end > start) c = c.slice(start, end + 1);
  return JSON.parse(c);
}

/** 开局：从汤底提取 8~12 个关键真相点 + 难度评星（还原度标尺，绝不发给玩家） */
async function extractKeyPoints(bottom) {
  const content = await callDeepSeek(
    [
      { role: 'system', content: '你是海龟汤游戏系统，只输出合法 JSON。' },
      {
        role: 'user',
        content:
          '请根据汤底提取 8~12 个「关键真相点」：解开谜题必须知道的原子事实，每点一句话，按叙事先后排列。\n' +
          '同时评估谜题难度 difficulty（1~5 星：1=一眼看穿，3=中等，5=非常难，综合考虑情节复杂度、反转程度、信息隐藏深浅）。\n' +
          '只输出 JSON：{"key_points":["...","..."],"difficulty":3}\n\n汤底：\n' +
          bottom,
      },
    ],
    { json: true, temperature: 0.2 }
  );
  const parsed = safeParseJSON(content);
  const list = parsed.key_points || parsed.keyPoints || [];
  const points = list.filter((s) => typeof s === 'string' && s.trim()).slice(0, 12);
  const d = parsed.difficulty;
  points.difficulty = Number.isInteger(d) && d >= 1 && d <= 5 ? d : 3;
  return points;
}

/** 扶汤：针对下一个未触及关键点生成一句提示 */
async function generateHint(bottom, keyPoints, untouchedIdx) {
  const target = keyPoints[untouchedIdx];
  try {
    const content = await callDeepSeek(
      [
        {
          role: 'user',
          content:
            '你是海龟汤主持人，玩家卡住了，需要一句「扶汤」提示。目标点：' +
            target +
            '\n要求：不直接说出答案，点到为止，10~40 字，可带一点引导性反问。只输出提示句。',
        },
      ],
      { temperature: 0.8 }
    );
    return content.trim().replace(/^["'“”]+|["'“”]+$/g, '');
  } catch {
    return `提示：再想想汤面里「${target.slice(0, 12)}…」那部分。`;
  }
}

/** 智能理解玩家消息：判定是指令还是问题；问题附带判答（一次调用完成，省 token） */
async function understand(bottom, surface, keyPoints, message) {
  const kp = keyPoints.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const content = await callDeepSeek(
    [
      { role: 'system', content: '你只输出合法 JSON。' },
      {
        role: 'user',
        content:
          '你是海龟汤主持人。玩家发来一条消息，可能是【游戏指令】，也可能是【推理问题】。请先判断类型，再按规则处理。\n\n' +
          `【汤面】\n${surface}\n\n【汤底】\n${bottom}\n\n【关键真相点】\n${kp}\n\n玩家消息：${message}\n\n` +
          '【如果是指令】识别种类并输出：{"type":"command","command":"hint|review|reveal|records|status|restart|help"}\n' +
          '  hint=要提示/扶汤；review=要复盘；reveal=要揭晓/看答案/放弃/不想玩了；records=要看提问记录；status=看还原度/进度；restart=重开/换一题；help=规则/帮助。\n' +
          '【如果是问题】依据汤底判答并输出：{"type":"question","verdict":"是|不是|无关|模糊|红汤|清汤","touched":[该问题直接确认或否定的关键点编号，通常0~2个],"important":true|false,"guide":"仅模糊时填，10~25字引导玩家问具体"}\n' +
          '  是：与汤底一致或能推断出肯定答案。注意：玩家会用不同说法表达同一件事，语义相同就算「是」，不要因用词不同判「不是」。\n' +
          '  不是：与汤底矛盾或能推断出否定答案。\n' +
          '  无关：汤底完全没提及且与谜题无关（极少用）。\n' +
          '  模糊：指代不清或覆盖范围太大（如「这个对吗」「到底发生了什么」）。\n' +
          '  指代：问题里的「他/她/它/那个人」等代词，即使汤面里看起来有常用指向，只要汤底中多个角色的答案会不同，就必须判「模糊」，并在引导里请玩家点名确认（如：你说的「他」是指主角还是哥哥？）。宁可让玩家把话说清楚，也不要自行假设指代后给出可能误导的答案。\n' +
          '  指代示例：汤底里主角活着、哥哥被杀了，玩家问「他是被杀的么？」——答案因人而异，判模糊，引导「你说的『他』是指主角还是哥哥？」；玩家改问「哥哥是被杀的么？」则正常判「是」。\n' +
          '  touched：只有问题直接确认或否定了某个关键点的具体内容时才列入（通常 0~2 个）。宽泛问题（如「有人死吗」「然后呢」）即使答案明确，也只列它直接涉及的那一两个点，不要把全部关键点都标为触及。\n' +
          '  海龟汤术语：玩家问「清汤/红汤」是在问汤底是否涉及死亡或血腥——红汤=有死亡或见血，清汤=没有。只要问题涉及清汤/红汤，判定就输出汤底实际的类型「红汤」或「清汤」，不要跟着问题里的词回答。特别注意：否定问法也是在问实际类型——「是清汤吗」=「没有死亡吗」，若汤底有死亡，答案仍是「红汤」；「是红汤吗」若汤底无死亡，答案仍是「清汤」。\n' +
          '  玩家问「本格/变格」是在问谜题风格，按以下规则回答是/不是，不要判「无关」：只要汤底包含以下任一元素就判「变格」——超自然/灵异/鬼神、真实存在的上帝/天使等超自然存在（不限于人冒充神）、人格分裂或精神异常、变态犯罪、弑亲等伦理禁忌、身份错位或重大反转；只有所有情节都能用常理解释的才算「本格」。\n' +
          '  important：该问题是否问到核心真相（关键点）。true=问到了重点；false=虽然能回答，但与破案无关紧要。\n' +
          '不确定时优先按问题处理；只有消息明显是在请求某个操作时才判为指令。',
      },
    ],
    { json: true, temperature: 0.1 }
  );
  return safeParseJSON(content);
}

/** 提问判答（保持旧接口）：仅处理问题型消息 */
async function judgeQuestion(bottom, surface, keyPoints, question) {
  const r = await understand(bottom, surface, keyPoints, question);
  if (r && r.type === 'question') {
    return {
      verdict: r.verdict || '无关',
      touched: (Array.isArray(r.touched) ? r.touched : [])
        .map((i) => parseInt(i, 10) - 1)
        .filter((i) => i >= 0 && i < keyPoints.length)
        .slice(0, 2),
      guide: r.guide || '',
      important: r.important !== false,
    };
  }
  return { verdict: '无关', touched: [], guide: '', important: true };
}

/** 复盘：逐关键点判定玩家的完整还原 */
async function reviewGuess(bottom, keyPoints, guess) {
  const kp = keyPoints.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const content = await callDeepSeek(
    [
      { role: 'system', content: '你只输出合法 JSON。' },
      {
        role: 'user',
        content:
          '你是海龟汤主持人，玩家提交了完整还原，请逐点判定。\n\n' +
          `汤底：\n${bottom}\n\n关键真相点：\n${kp}\n\n玩家还原：\n${guess}\n\n` +
          '输出 JSON：{"points":[{"i":1,"verdict":"准确|部分|缺失|错误","note":"一句话说明"}],"comment":"对整体还原的一句话点评"}\n' +
          '判定标准：准确=与汤底一致；部分=方向对但不完整；缺失=未提及；错误=与汤底矛盾。',
      },
    ],
    { json: true, temperature: 0.2 }
  );
  return safeParseJSON(content);
}

module.exports = { extractKeyPoints, judgeQuestion, understand, generateHint, reviewGuess };
