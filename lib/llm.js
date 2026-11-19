'use strict';
const config = require('./config');

class LLMError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

// 判断 LLM 是否真正配置好（可真实调用）
function status() {
  const c = config.get();
  const l = c.llm || {};
  const provider = (l.provider || '').toLowerCase();
  const base = (l.baseUrl || '').trim();
  const model = (l.model || '').trim();
  const needKey = provider === 'openai' || (provider && provider !== 'ollama');
  const missing = [];
  if (!provider) missing.push('LLM_PROVIDER');
  if (!base) missing.push('LLM_BASE_URL');
  if (!model) missing.push('LLM_MODEL');
  if (needKey && !(l.apiKey || '').trim()) missing.push('LLM_API_KEY');
  return { ready: missing.length === 0, provider, base, model, missing };
}

function systemPrompt(jd, resume, bank, opts = {}) {
  const memBlock = opts.memory ? `\n\n【本场会话记忆（我已说过的话）】\n${opts.memory}\n\n要求：提示里不要让用户重复说已经说过的内容；如果记忆里有“可追问”的线索，本轮提示可以顺势接住。` : '';
  const sampleInstruction = opts.fullAnswer
    ? '同时提供完整示范回答：sampleAnswer 约 100-180 个汉字，结构自然、可直接朗读，但不能编造用户经历。涉及个人经历时，只能使用简历或上一轮回答里明确提供的事实；没有事实就用【补充你的真实经历】这样的占位语。英文题给英文示范，并附简短中文提示。'
    : '当前是提纲练习模式：sampleAnswer 返回空字符串，不生成完整示范。';
  return `你是面试练习场景的实时提示助手。严格基于下面【目标岗位JD】和【我的简历（已结构化筛选）】给出提示，不得编造简历里没有的经历。
${sampleInstruction} headline 不超过 30 个汉字；points 给 2-3 条，每条不超过 22 个汉字；experiences 最多 1 条，只能引用提供的简历内容。没有明显相关经历时 experiences 返回 []，不要拿无关经历凑数。pitfalls 最多 2 条，每条不超过 20 个汉字。
若问题是英文，englishOpener 给一句自然的英文开头。回答要针对这个岗位。${memBlock}

只输出 JSON（不要 markdown 代码块），格式严格如下：
{"headline":"一句话思路","points":["要点1","要点2"],"experiences":["真实经历1"],"pitfalls":["避坑1"],"sampleAnswer":"完整口语示范回答","englishOpener":"","memoryDelta":{"facts":["本轮我回答中透露的新事实，如'我主导过3人团队'"],"mentioned":["我提到过的经历/技能"],"avoid_repeat":["我已经说过、下轮别重复的点"],"followups":["面试官可能追问、值得准备的点"]}}

memoryDelta 字段说明：只从「我的上一轮回答」（见 user 消息里的【我上一轮的回答】）里提炼。facts/mentioned/avoid_repeat 必须是我回答里真实说过的内容，每条不超过25字。followups 是面试官可能追问的点。关键：如果没有【我上一轮的回答】这一节，memoryDelta 的所有字段都必须返回空数组 []，绝对不要从 JD 或简历里编造。

【目标岗位JD】
${jd || '（未提供）'}

【我的简历（相关经历）】
${resume || '（未提供）'}

【预设陪练题/答案】
${bank || '（未提供）'}`;
}

function detectType(question) {
  if (/英语|英文|english|用英语|in english/i.test(question) || (/[a-zA-Z]{4}/.test(question) && /what|would|how|why|client|refund/i.test(question))) return '英文突袭';
  if (/自我介绍|介绍一下自己|讲讲你自己/i.test(question)) return '自我介绍';
  if (/薪资|期望薪|待遇|多少钱|offer/i.test(question)) return '薪资谈判';
  if (/反问|你有什么问题|想问我们/i.test(question)) return '反问环节';
  if (/项目|深挖|讲讲你做过|遇到的挑战|技术难点/i.test(question)) return '项目深挖';
  if (/假设|如果.*消失|给你一千|你会怎么做|七天|第一笔钱/i.test(question)) return '开放创意';
  if (/还是|先做哪|只能选|二选一|第一步|怎么办|上线.*延期|联系不上/i.test(question)) return '两难决策';
  return '通用结构化';
}

function extractJSON(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // 找第一个 '{' 到与之配对的 '}'（模型可能在 JSON 前后加解释文字）
  const s = t.indexOf('{');
  if (s < 0) throw new Error('no json');
  let depth = 0, inStr = false, esc = false, e = -1;
  for (let i = s; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { e = i; break; } }
  }
  if (e < 0) throw new Error('unbalanced json');
  return JSON.parse(t.slice(s, e + 1));
}

async function callOllama(base, model, messages, timeoutMs) {
  const url = base.replace(/\/$/, '') + '/api/chat';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, format: 'json', options: { temperature: 0.5 } }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new LLMError('HTTP_' + res.status, 'Ollama 返回 ' + res.status, await res.text().catch(() => ''));
  const data = await res.json();
  return data.message?.content || '';
}

async function callOpenAI(base, model, apiKey, messages, timeoutMs) {
  const url = base.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({ model, messages, temperature: 0.5 }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new LLMError('HTTP_' + res.status, 'LLM 接口返回 ' + res.status, await res.text().catch(() => ''));
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * 真实生成提示。未配置或调用失败都会抛错，绝不返回编造的假提示。
 */
async function generate(question, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  const s = status();
  if (!s.ready) {
    throw new LLMError(
      'NOT_CONFIGURED',
      '尚未配置真实 LLM，无法生成提示。请在「配置台」填写 LLM 信息，或按 README 启动本机 Ollama / 填入 API key。',
      { missing: s.missing }
    );
  }
  const c = config.get();
  const resumeContext = opts.resumeContext || c.resume;
  const userContent = opts.lastAnswer
    ? '面试官的问题是：' + question + '\n\n【我上一轮的回答（请据此提炼 memoryDelta）】\n' + opts.lastAnswer
    : '面试官的问题是：' + question;
  const messages = [
    { role: 'system', content: systemPrompt(c.jd, resumeContext, c.bank, { memory: opts.memory, fullAnswer: opts.fullAnswer !== false }) },
    { role: 'user', content: userContent }
  ];
  const t0 = Date.now();
  const doCall = () => s.provider === 'ollama'
    ? callOllama(s.base, s.model, messages, timeoutMs)
    : callOpenAI(s.base, s.model, c.llm.apiKey, messages, timeoutMs);
  let raw, parsed;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await doCall();
    } catch (e) {
      // fetch failed 通常是模型服务没启动或地址不对——给可操作的诊断
      if (/fetch failed|ECONNREFUSED|timeout|abort/i.test(e.message)) {
        const hint = s.provider === 'ollama'
          ? `无法连接本机 Ollama（${s.base}）。请确认已安装 Ollama 并启动（ollama serve），且已拉取模型 ${s.model}（ollama pull ${s.model}）。`
          : `无法连接 LLM 服务（${s.base}）。请检查 Base URL、网络与 key 是否正确。`;
        throw new LLMError('UNREACHABLE', hint, e.message);
      }
      throw e;
    }
    try {
      parsed = extractJSON(raw);
      break; // 解析成功，跳出重试
    } catch (e) {
      if (attempt === 1) throw new LLMError('BAD_JSON', 'LLM 连续两次未返回可解析的 JSON 提示，请重试或更换模型。', raw);
      // 第一次解析失败：重试一次（真实 LLM 偶发输出不纯 JSON）
    }
  }
  return {
    hintType: detectType(question),
    headline: parsed.headline || '先复述问题，再给结论和要点。',
    points: Array.isArray(parsed.points) ? parsed.points : [],
    experiences: Array.isArray(parsed.experiences) ? parsed.experiences : [],
    pitfalls: Array.isArray(parsed.pitfalls) ? parsed.pitfalls : [],
    sampleAnswer: String(parsed.sampleAnswer || '').trim(),
    englishOpener: parsed.englishOpener || '',
    memoryDelta: (parsed.memoryDelta && typeof parsed.memoryDelta === 'object') ? parsed.memoryDelta : null,
    source: (s.provider === 'ollama' ? 'Ollama · ' : 'LLM · ') + s.model,
    latencyMs: Date.now() - t0
  };
}

/**
 * 对「我的回答」做 AI 复盘评分（模拟练习教练反馈）。
 * 独立于 generate 的一次调用，不写记忆、不影响主提示链路。
 * 评分维度：结构 / 内容 / 证据 / 表达，各 0-25，总分 0-100。
 */
function evalSystemPrompt(jd) {
  return `你是面试模拟练习的复盘教练。基于【问题】【题目参考要点】【我的回答】给出客观、具体、可执行的评分反馈。
评分要诚实：答得好就高分，空泛/没例子/跑题就扣分。不要一味鼓励，也不要刻薄。反馈要能让下次回答更好。

只输出 JSON（不要 markdown 代码块），格式严格如下：
{"scores":{"structure":18,"content":20,"evidence":15,"expression":21},"total":74,"strengths":["做得好的具体点1","具体点2"],"improvements":["最该改的1","最该改的2"],"betterAnswer":"一段可直接开口的示范回答（2-4句，80-160字），要具体、有结构、贴合问题","verdict":"一句话总评"}

字段说明：
- structure/content/evidence/expression 各 0-25 整数；total 为四项之和（0-100）。
- 结构=是否先结论后要点、有条理；内容=是否切题、覆盖关键点；证据=是否有具体经历/数据/例子（空泛则低分）；表达=是否简洁口语化、开头有力。
- strengths/improvements 各 1-3 条，每条不超过30字，必须针对这次回答的实际内容，不要套话。
- betterAnswer 要针对这个具体问题，不要复述我的回答，给一个明显更好的版本；不得编造用户未提供的项目、数字、职责或结果。缺少事实时，用【补充真实例子】等占位提示，不要替用户虚构。
- 若我的回答为空或极短（少于8字），improvements 里指出「几乎没展开」，betterAnswer 给完整示范。

【目标岗位JD】
${jd || '（未提供）'}`;
}

async function evaluate(question, answer, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000;
  const s = status();
  if (!s.ready) throw new LLMError('NOT_CONFIGURED', '尚未配置真实 LLM，无法生成评分反馈。', { missing: s.missing });
  const c = config.get();
  const ref = (opts.points || []).concat(opts.pitfalls || []).join('\n');
  const userContent = `【问题】\n${question || ''}\n\n【题目参考要点】\n${ref || '（无参考要点）'}\n\n【我的回答】\n${answer || '（几乎没回答）'}`;
  const messages = [
    { role: 'system', content: evalSystemPrompt(c.jd) },
    { role: 'user', content: userContent }
  ];
  const t0 = Date.now();
  const doCall = () => s.provider === 'ollama'
    ? callOllama(s.base, s.model, messages, timeoutMs)
    : callOpenAI(s.base, s.model, c.llm.apiKey, messages, timeoutMs);
  let raw, parsed;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      raw = await doCall();
    } catch (e) {
      if (/fetch failed|ECONNREFUSED|timeout|abort/i.test(e.message)) {
        throw new LLMError('UNREACHABLE', '无法连接 LLM 服务，评分暂不可用。', e.message);
      }
      throw e;
    }
    try { parsed = extractJSON(raw); break; }
    catch (e) { if (attempt === 1) throw new LLMError('BAD_JSON', 'LLM 未返回可解析的评分 JSON，请重试。', raw); }
  }
  const clamp = v => { const n = Math.round(Number(v)); return isFinite(n) ? Math.max(0, Math.min(25, n)) : 0; };
  const sc = parsed.scores && typeof parsed.scores === 'object' ? parsed.scores : {};
  const scores = { structure: clamp(sc.structure), content: clamp(sc.content), evidence: clamp(sc.evidence), expression: clamp(sc.expression) };
  const total = clamp100(parsed.total != null ? parsed.total : scores.structure + scores.content + scores.evidence + scores.expression);
  return {
    scores, total,
    strengths: strList(parsed.strengths),
    improvements: strList(parsed.improvements),
    betterAnswer: String(parsed.betterAnswer || '').trim(),
    verdict: String(parsed.verdict || '').trim(),
    source: (s.provider === 'ollama' ? 'Ollama · ' : 'LLM · ') + s.model,
    latencyMs: Date.now() - t0
  };
}

function clamp100(v) { const n = Math.round(Number(v)); return isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; }
function strList(v) { return Array.isArray(v) ? v.slice(0, 4).map(x => String(x).slice(0, 120)) : []; }

module.exports = { generate, evaluate, status, LLMError, detectType };
