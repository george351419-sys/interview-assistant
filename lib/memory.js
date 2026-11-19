'use strict';
/**
 * 会话记忆 + 简历结构化
 *
 * 设计要点：
 * 1. 不存回答原文（口头语多、token 贵），存提炼后的“事实片段”
 * 2. 提炼与提示生成合并进同一次 LLM 调用（一次网络往返，不额外加延迟）
 *    见 llm.generate() 的 memoryDelta 输出
 * 3. 记忆有上限（默认 30 条）与去重，防止上下文膨胀
 * 4. 简历结构化：解析成经历卡片，按问题关键词选 top-k 注入，替代全量硬塞
 */

const MAX_FACTS = 30;

const STOP_WORDS = new Set('以及|同时|主要|负责|参与|进行|通过|相关|完成|工作|项目|能力|经验|提升|优化|实现|支持|能够|根据|其中|对于|我们|本人|目前|过去|之后|因为|所以|并且|一个|这个|那个|一些|非常|比较|以及|负责过|熟悉|掌握'.split('|'));

/** 中文无空格简历需要按词切分；不支持 Intl.Segmenter 的环境用汉字二元词兜底。 */
function tokenize(text) {
  const value = String(text || '').toLowerCase();
  let words;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    words = [...segmenter.segment(value)].filter(x => x.isWordLike).map(x => x.segment);
  } else {
    words = [];
    for (const part of value.match(/[\u3400-\u9fff]+|[a-z0-9+#.]+/g) || []) {
      if (/^[\u3400-\u9fff]+$/.test(part)) {
        for (let i = 0; i < part.length - 1; i++) words.push(part.slice(i, i + 2));
        if (part.length > 2) words.push(part);
      } else words.push(part);
    }
  }
  return [...new Set(words.filter(w => w.length >= 2 && !STOP_WORDS.has(w)))];
}

class SessionMemory {
  constructor() {
    this.facts = [];       // [{id, text, kind, time}]
    this.turns = 0;
    this.seq = 0;
  }

  /** 把 LLM 输出的 memoryDelta 合并进记忆 */
  applyDelta(delta) {
    if (!delta || typeof delta !== 'object') return 0;
    let added = 0;
    const arrays = [
      ['facts', 'fact'],
      ['mentioned', 'mentioned'],
      ['avoid_repeat', 'avoid'],
      ['followups', 'followup']
    ];
    for (const [key, kind] of arrays) {
      const list = Array.isArray(delta[key]) ? delta[key] : [];
      for (const item of list) {
        const text = String(typeof item === 'string' ? item : (item.text || '')).trim();
        if (!text || text.length < 2) continue;
        // 去重：完全相同的文本不重复加
        if (this.facts.some(f => f.text === text)) continue;
        this.facts.push({ id: ++this.seq, text, kind, time: Date.now() });
        added++;
      }
    }
    // 限长：保留最新的
    if (this.facts.length > MAX_FACTS) this.facts = this.facts.slice(-MAX_FACTS);
    this.turns++;
    return added;
  }

  /** 给 prompt 用的记忆文本块（followup 是给用户看的复盘项，不注入下一轮提示） */
  toPrompt(maxChars = 2500) {
    const usable = this.facts.filter(f => f.kind !== 'followup' && f.kind !== 'avoid');
    if (!usable.length) return '';
    const lines = usable.map(f => {
      const label = { fact: '已说过', mentioned: '已提及' }[f.kind] || '';
      return `- [${label}] ${f.text}`;
    });
    let out = lines.join('\n');
    if (out.length > maxChars) out = lines.slice(-Math.floor(maxChars / 40)).join('\n');
    return out;
  }

  snapshot() {
    return { facts: this.facts.slice(), turns: this.turns };
  }

  clear() {
    this.facts = [];
    this.turns = 0;
    this.seq = 0;
  }
}

/** 把简历文本解析成结构化经历卡片（纯规则，不依赖 LLM） */
function structureResume(resumeText) {
  const cards = [];
  if (!resumeText) return cards;
  const lines = resumeText.split(/\n+/).map(s => s.trim()).filter(Boolean);
  let current = null;
  for (const line of lines) {
    // 形如【项目一】xxx 或 【项目二】xxx 的标题行
    const m = line.match(/^【([^】]+)】\s*(.*)$/);
    if (m) {
      if (current) cards.push(current);
      current = { title: m[1], body: m[2] || '', full: line };
    } else if (current) {
      current.body += ' ' + line;
      current.full += ' ' + line;
    } else {
      // 没有【】标题的行（如“张明｜产品经理｜5年经验”）作为第一张卡片的引子
      current = { title: '概况', body: line, full: line };
    }
  }
  if (current) cards.push(current);
  // 抽取量化成果（数字+单位/百分号）作为搜索加成关键词
  for (const c of cards) {
    c.numbers = (c.body.match(/\d+(?:\.\d+)?\s*(?:%|万|千|人|组|天|周|倍|条|次)/g) || []);
    c.keywords = tokenize(c.body + ' ' + c.title);
  }
  return cards;
}

/** 按问题+JD 关键词给经历卡片打分，选 top-k */
function selectRelevant(cards, question, jd, k = 3) {
  if (!cards.length) return '';
  const q = String(question || '').toLowerCase();
  const j = String(jd || '').toLowerCase();
  const qWords = new Set(tokenize(q));
  const jdWords = new Set(tokenize(j));
  const scored = cards.map(c => {
    let score = 0;
    for (const kw of c.keywords) {
      if (qWords.has(kw) || q.includes(kw)) score += 3;
      else if (jdWords.has(kw) || j.includes(kw)) score += 1;
    }
    for (const n of c.numbers) if (q.includes(n)) score += 2;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const matches = scored.filter(x => x.score > 0);
  // 没有相关信号时返回空，避免把无关简历经历伪装成匹配结果。
  if (!matches.length) return '';
  const picked = matches.slice(0, k).map(x => x.c);
  return picked.map(c => `- 【${c.title}】${c.body}`).join('\n');
}

module.exports = { SessionMemory, structureResume, selectRelevant, tokenize, MAX_FACTS };
