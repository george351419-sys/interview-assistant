/* ============================================================
 * 面试助手 · 手机提示屏 MVP 原型
 * 核心闭环：对面提问 → (ASR) → 提示生成(LLM/本地) → 手机提示屏 → 回溯
 * 仅用于模拟练习场景。
 * ============================================================ */

'use strict';

/* ---------- 示例内容 ---------- */
const DEFAULT_JD = `产品经理（用户增长方向）
岗位职责：
1. 负责用户增长与留存，设计并推进 A/B 测试，用数据分析驱动决策；
2. 从 0 到 1 搭建增长实验体系，跨团队协作推动方案落地；
3. 关注用户体验，能把复杂问题拆解为可执行方案。
任职要求：本科及以上，3 年以上产品经验；数据敏感，抗压能力强；英语可作为工作语言；有从 0 到 1 项目经验优先。`;

const DEFAULT_RESUME = `张明｜产品经理｜5 年经验
【项目一】从 0 到 1 搭建用户增长实验平台：主导设计 A/B 测试流程，上线 3 个月完成 40+ 组实验，核心注册转化率提升 18%，日活提升 12 万。
【项目二】负责留存优化：通过数据分析定位新用户 7 日留存瓶颈，重构新手引导，7 日留存从 31% 提升到 43%，跨 4 个团队协作落地。
【项目三】B 端产品改版：梳理复杂审批流程，拆解为 3 个可配置模块，交付周期从 6 周缩短到 3 周，客户投诉下降 40%。
【其他】英语可作为工作语言，主导过 2 次与海外团队的跨时区协作；抗压能力强，同期并行负责 3 条产品线。`;

const DEFAULT_BANK = `1. Your biggest client wants a refund, but company policy doesn't allow it. What would you say?（请用英语回答） → 先共情再了解原因，说明权限边界，给替代方案或升级处理
2. 明天产品必须上线，今晚发现支付功能可能让部分用户被重复扣款，研发说修复要两天，销售说延期就丢大客户。你怎么办？ → 先止损（关支付入口/告警），再评估影响面，同步干系人，给决策选项
3. 假设明天所有外卖平台都消失了，给你一千块，帮一家小餐馆在七天内重新拿到订单，你会怎么做？ → 先明确目标与约束，选一个最小验证渠道，把 1000 元花在可验证的获客上，7 天内看数据再放大`;

const STORAGE_KEY = 'interview_assistant_cfg_v1';
const HISTORY_KEY = 'interview_assistant_history_v1';

/* ---------- 状态 ---------- */
let cfg = {
  jd: DEFAULT_JD,
  resume: DEFAULT_RESUME,
  bank: DEFAULT_BANK,
  base: '',
  key: '',
  model: 'gpt-4o-mini'
};
let history = [];
let recognition = null;
let recognizing = false;
let lastQuestion = '';
let lastPrompt = null;

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  connStatus: $('connStatus'), speakerBadge: $('speakerBadge'),
  questionInput: $('questionInput'), micBtn: $('micBtn'), micHint: $('micHint'),
  askBtn: $('askBtn'), recogLang: $('recogLang'),
  promptStack: $('promptStack'), emptyState: $('emptyState'),
  latencyBadge: $('latencyBadge'), myTurnBtn: $('myTurnBtn'), myTurnMask: $('myTurnMask'),
  historyList: $('historyList'), clearHistory: $('clearHistory'),
  drawer: $('settingsDrawer'), drawerMask: $('drawerMask'),
  openSettings: $('openSettings'), closeSettings: $('closeSettings'), footerSettings: $('footerSettings'),
  cfgJd: $('cfgJd'), cfgResume: $('cfgResume'), cfgBank: $('cfgBank'),
  cfgBase: $('cfgBase'), cfgKey: $('cfgKey'), cfgModel: $('cfgModel'),
  engineStatus: $('engineStatus'), saveCfg: $('saveCfg'), resetCfg: $('resetCfg'),
  toast: $('toast')
};

/* ============================================================
 * 本地结构化提示引擎（无 LLM / 离线可演示）
 * ============================================================ */

// 从 JD 抽取能力关键词
function extractJdKeywords(jd) {
  const dict = ['数据分析','A/B测试','用户增长','留存','从0到1','跨团队协作','用户体验','抗压','英语','沟通','协作','产品','增长','复盘','项目管理','决策','复杂问题','落地','海外'];
  return dict.filter(k => jd.includes(k));
}

// 从简历里挑与 JD 最相关的经历（含数字加分）
function matchExperiences(resume, keywords) {
  const lines = resume.split(/\n|【|\】/).map(s => s.trim()).filter(s => s.length > 12);
  const scored = lines.map(line => {
    let score = 0;
    keywords.forEach(k => { if (line.includes(k.replace('从0到1','从 0 到 1'))) score += 2; });
    if (/\d/.test(line)) score += 1;
    if (/项目|主导|负责|提升|搭建|优化/.test(line)) score += 1;
    return { line: line.replace(/^项目[一二三四五六七八九十]+\s*/, ''), score };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, 3).map(x => x.line);
  return picked.length ? picked : ['（请先在配置里填入简历，提示会自动引用你的真实经历）'];
}

// 题型识别
function detectType(q) {
  if (/英语|英文|english|用英语|in english/i.test(q) || (/[a-zA-Z]{4}/.test(q) && /what|would|how|why|client|refund/i.test(q))) return 'en';
  if (/自我介绍|介绍一下自己|讲讲你自己|self.?intro/i.test(q)) return 'intro';
  if (/薪资|期望薪|待遇|多少钱|offer/i.test(q)) return 'salary';
  if (/反问|你有什么问题|想问我们|有什么想了解/i.test(q)) return 'reverse';
  if (/项目|深挖|讲讲你做过|最难的项目|遇到的挑战|技术难点/i.test(q)) return 'project';
  if (/假设|如果.*消失|给你一千|你会怎么做|七天|第一笔钱|怎么重新/i.test(q)) return 'creative';
  if (/还是|先做哪|只能选|二选一|二选|第一步|怎么办|上线.*延期|不接受延期|联系不上/i.test(q)) return 'dilemma';
  return 'general';
}

// 各题型的骨架（要点 / 避坑 / 一句话思路）
function typeSkeleton(type, q) {
  switch (type) {
    case 'en':
      return {
        label: '英文突袭',
        headline: '先给一句能开口的英文开头，再补中文思路和要点——不要一上来就塞整篇英文。',
        points: [
          '第一步：先回应对方情绪 / 复述问题，给自己争取 2 秒缓冲',
          '第二步：说明你的判断或权限边界，给出可行选项',
          '第三步：如果超出权限，明确「升级处理」的路径和时间',
          '表达上：短句优先，先说结论句，再展开理由'
        ],
        pitfalls: ['不要沉默超过 3 秒', '不要逐字翻译中文思路', '别用复杂从句把自己绕进去'],
        englishOpener: /refund|client|customer/i.test(q)
          ? 'I understand your frustration. Could you tell me a bit more about what went wrong? Here is what I can do for you.'
          : 'That is a great question. Let me think about it from two angles — the immediate step and the longer-term fix.'
      };
    case 'dilemma':
      return {
        label: '两难决策',
        headline: '别急着讲完整流程——先说「第一步做什么、为什么」，条件变了要跟着改答案。',
        points: [
          '第一步先止损 / 控风险：把最坏情况先按住（如关入口、发告警、冻结发布）',
          '用一句话讲清判断依据：影响面 × 可逆性 × 时间窗口',
          '给对方 2 个带取舍的选项，而不是只给一个结论',
          '如果对方改条件：先复述新约束，再说「那我第一步改成……」'
        ],
        pitfalls: ['不要一开口就铺陈完整方案', '别忽略新加的约束条件', '不要假装信息完整——说明你缺什么、多久补齐'],
      };
    case 'creative':
      return {
        label: '开放创意',
        headline: '先锁定目标和约束，再选一个最小可验证的第一步——面试官要的是思路，不是标准答案。',
        points: [
          '先澄清目标：7 天内「拿到订单」的定义是什么（数量 / 复购）',
          '列约束：1000 元、7 天、单店，钱要花在可验证的渠道上',
          '第一步选一个最小验证：如老客召回 / 社群 / 地推，挑一个先跑',
          '用前 2 天的数据决定加码还是换方向，讲清你的判断点'
        ],
        pitfalls: ['不要罗列一堆办法却不下判断', '别把钱平均撒给所有渠道', '避免只讲创意不讲验证'],
      };
    case 'project':
      return {
        label: '项目深挖',
        headline: '用 STAR 结构，但把重点放在「你个人的判断」和可量化的结果上。',
        points: [
          'S/T：一句话交代背景和你承担的角色，不要铺垫太久',
          'A：讲你做了哪几个关键决策，为什么这么选（体现判断力）',
          'R：给量化结果（提升百分比、节省时间、影响规模）',
          '准备被追问：对方一定会挑一个环节深挖，提前想好细节'
        ],
        pitfalls: ['不要把团队成果全说成自己的', '别只讲过程没有数字', '避免流水账式叙述'],
      };
    case 'intro':
      return {
        label: '自我介绍',
        headline: '用「现在做的是什么 + 最相关的一个成绩 + 为什么匹配这个岗位」三段式，控制在 90 秒。',
        points: [
          '一句话定位：我是谁、几年经验、当前负责什么',
          '挑一个与 JD 最相关的成绩，给数字',
          '收尾主动扣岗位：为什么这个岗位是我想去的下一步',
          '语言口语化，避免背稿感'
        ],
        pitfalls: ['不要从简历第一行走到最后一row', '别讲与岗位无关的经历', '避免超时'],
      };
    case 'salary':
      return {
        label: '薪资谈判',
        headline: '先表达意愿，再给基于市场与价值的区间，把「为什么值这个数」说清楚。',
        points: [
          '先确认对方薪酬结构和预算范围，避免报早了',
          '给区间而非单点，并说明依据（市场 / 能力 / 岗位价值）',
          '把关注点从数字扩展到成长空间、职责范围',
          '留缓冲：说明具体数字可结合整体 package 谈'
        ],
        pitfalls: ['不要先报一个具体死数字', '别表现得只在乎钱', '避免说「我上一份多少就照着给」'],
      };
    case 'reverse':
      return {
        label: '反问环节',
        headline: '问 2–3 个能体现你认真想过岗位的问题，别问官网能查到的。',
        points: [
          '问岗位：这个岗位前 3 个月的产出预期是什么？',
          '问团队：团队现在最大的挑战 / 你最希望这个角色解决什么？',
          '问成长：这个岗位上表现优秀的人通常做对了什么？',
          '收尾：把对方回答里的信息，回扣到你自己能带来的价值'
        ],
        pitfalls: ['别说「没有问题」', '别一上来问加班和假期', '避免一次问太多问题'],
      };
    default:
      return {
        label: '通用结构化',
        headline: '先复述确认问题，再给「结论 + 2–3 个要点 + 一个相关经历」，边说边组织。',
        points: [
          '先花 2 秒复述问题，确认你理解对了，也给自己缓冲',
          '先说结论 / 第一句话，让对方知道你有思路',
          '给 2–3 个支撑要点，优先讲和这个岗位相关的',
          '结尾补一句你的判断或下一步，显得有主见'
        ],
        pitfalls: ['不要一上来就长篇铺垫', '别答非所问', '避免用「我可能需要查一下」直接结束'],
      };
  }
}

// 生成本地提示
function buildLocalPrompt(question) {
  const type = detectType(question);
  const sk = typeSkeleton(type, question);
  const kws = extractJdKeywords(cfg.jd);
  const experiences = matchExperiences(cfg.resume, kws);

  // 把 JD 关键词融进「回答要点」的最后一条，实现「针对岗位」
  const points = sk.points.slice();
  if (kws.length) {
    points.push(`扣岗位：这个岗位看重「${kws.slice(0, 4).join('、')}」，回答时至少往其中一个方向上靠`);
  }

  return {
    type: sk.label,
    headline: sk.headline,
    points,
    experiences,
    pitfalls: sk.pitfalls,
    englishOpener: sk.englishOpener || '',
    source: '本地引擎'
  };
}

/* ============================================================
 * LLM 模式（OpenAI 兼容 Chat Completions）
 * ============================================================ */
async function buildLlmPrompt(question) {
  const base = (cfg.base || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = base + '/chat/completions';
  const system = `你是面试练习的实时提示助手。仅用于模拟练习场景。
严格基于下面的【目标岗位JD】和【我的简历】给出提示，不得编造我没有的经历。
提示要短、口语化、能当场开口说：先给一句能开口的开头/一句话思路，再给2-4条回答要点、可引用的真实经历、避坑提示。
若问题是英文，额外给一句英文开头（englishOpener）。
只输出JSON，不要markdown代码块，格式：
{"headline":"一句话思路","points":["..."],"experiences":["..."],"pitfalls":["..."],"englishOpener":""}

【目标岗位JD】
${cfg.jd || '（未提供）'}

【我的简历】
${cfg.resume || '（未提供）'}

【预设陪练题/答案】
${cfg.bank || '（未提供）'}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.key
      },
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: '面试官的问题是：' + question }
        ],
        temperature: 0.5
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    let text = data.choices[0].message.content.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const p = JSON.parse(text);
    const type = detectType(question);
    return {
      type: typeSkeleton(type, question).label,
      headline: p.headline || '先复述问题，再给结论和要点。',
      points: Array.isArray(p.points) ? p.points : [],
      experiences: Array.isArray(p.experiences) ? p.experiences : matchExperiences(cfg.resume, extractJdKeywords(cfg.jd)),
      pitfalls: Array.isArray(p.pitfalls) ? p.pitfalls : [],
      englishOpener: p.englishOpener || '',
      source: 'LLM · ' + (cfg.model || 'model')
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * 渲染
 * ============================================================ */
function setConn(text, cls) {
  el.connStatus.className = 'status' + (cls ? ' ' + cls : '');
  el.connStatus.querySelector('span').textContent = text;
}

function renderPromptCard(prompt, question, id, isNew) {
  if (el.emptyState) el.emptyState.remove();

  // 旧卡下沉
  el.promptStack.querySelectorAll('.prompt-card').forEach(c => c.classList.add('sunk'));

  const card = document.createElement('div');
  card.className = 'prompt-card' + (isNew ? '' : ' sunk');
  card.dataset.id = id;

  const pointsHtml = prompt.points.map(p => `<li>${esc(p)}</li>`).join('');
  const expHtml = prompt.experiences.map(e => `<li>${esc(e)}</li>`).join('');
  const pitHtml = prompt.pitfalls.map(p => `<li>${esc(p)}</li>`).join('');
  const enHtml = prompt.englishOpener
    ? `<div class="pc-block en"><h3>英文开头</h3><p class="en-opener">${esc(prompt.englishOpener)}</p></div>`
    : '';

  card.innerHTML = `
    <div class="pc-head">
      <span class="pc-type">${esc(prompt.type)}</span>
      <span class="pc-source">${esc(prompt.source)}</span>
    </div>
    <div class="pc-question">${esc(question)}</div>
    <div class="pc-body">
      <div class="pc-headline">💡 ${esc(prompt.headline)}</div>
      <div class="pc-block"><h3>回答要点</h3><ol>${pointsHtml}</ol></div>
      <div class="pc-block experiences"><h3>可引用经历 <span class="from">（来自你的简历 × JD）</span></h3><ul>${expHtml}</ul></div>
      <div class="pc-block pitfalls"><h3>避坑提示</h3><ul>${pitHtml}</ul></div>
      ${enHtml}
    </div>
    <div class="pc-foot">
      <button class="fold-btn" data-act="fold">收起 ▲</button>
      <div class="rating">
        <button data-r="good">👍 答得好</button>
        <button data-r="stuck">🔁 卡壳</button>
      </div>
    </div>`;

  el.promptStack.insertBefore(card, el.promptStack.firstChild);
  el.promptStack.scrollTop = 0;
  return card;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

/* ---------- 主流程：提问 → 出提示 ---------- */
async function ask(question) {
  question = (question || '').trim();
  if (!question) { toast('先输入面试官的问题'); return; }

  lastQuestion = question;
  el.questionInput.value = question;
  el.speakerBadge.textContent = '对面提问中…';
  el.speakerBadge.classList.add('live');
  setConn('识别中', 'warn');
  el.askBtn.disabled = true;
  el.askBtn.textContent = '生成中…';

  const t0 = performance.now();
  let prompt;
  const useLlm = !!(cfg.key && cfg.key.trim());
  try {
    prompt = useLlm ? await buildLlmPrompt(question) : buildLocalPrompt(question);
  } catch (e) {
    console.warn('LLM 失败，降级本地引擎：', e);
    toast('LLM 请求失败，已降级到本地引擎');
    prompt = buildLocalPrompt(question);
  }

  const elapsedMs = performance.now() - t0;
  el.latencyBadge.textContent = (elapsedMs < 100 ? '<0.1s' : (elapsedMs / 1000).toFixed(1) + 's') + ' 出提示';
  el.speakerBadge.textContent = '等待回答';
  el.speakerBadge.classList.remove('live');
  setConn('已连接');
  el.askBtn.disabled = false;
  el.askBtn.textContent = '生成提示 →';

  const rec = {
    id: Date.now().toString(),
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    question,
    type: prompt.type,
    headline: prompt.headline,
    rating: ''
  };
  history.unshift(rec);
  saveHistory();
  renderHistory();

  lastPrompt = prompt;
  renderPromptCard(prompt, question, rec.id, true);
  bindCardActions(el.promptStack.querySelector(`.prompt-card[data-id="${rec.id}"]`), rec.id);
}

/* ---------- 卡片交互 ---------- */
function bindCardActions(card, id) {
  if (!card) return;
  card.querySelector('[data-act=fold]').addEventListener('click', (e) => {
    card.classList.toggle('pc-collapsed');
    e.target.textContent = card.classList.contains('pc-collapsed') ? '展开 ▼' : '收起 ▲';
  });
  card.querySelectorAll('.rating button').forEach(b => {
    b.addEventListener('click', () => {
      const r = b.dataset.r;
      card.querySelectorAll('.rating button').forEach(x => x.classList.remove('picked'));
      b.classList.add('picked');
      setRating(id, r);
      toast(r === 'good' ? '已标注：答得好' : '已标注：卡壳，下轮重点练');
    });
  });
}

function setRating(id, r) {
  const rec = history.find(h => h.id === id);
  if (rec) { rec.rating = r; saveHistory(); renderHistory(); }
}

/* ---------- 回溯渲染 ---------- */
function renderHistory() {
  if (!history.length) {
    el.historyList.innerHTML = '<p class="empty-hint">还没有记录。生成第一条提示后，这里会留档，方便复盘「哪题答得好 / 哪题卡壳」。</p>';
    return;
  }
  el.historyList.innerHTML = history.map(h => {
    const rCls = h.rating ? ' ' + h.rating : '';
    const rText = h.rating === 'good' ? '👍 答得好' : h.rating === 'stuck' ? '🔁 卡壳' : '未标注';
    return `<div class="history-item" data-id="${h.id}">
      <span class="hi-time">${esc(h.time)}</span>
      <div class="hi-main">
        <div class="hi-q">${esc(h.question)}</div>
        <div class="hi-meta">${esc(h.type)} · ${esc(h.headline)}</div>
      </div>
      <button class="hi-rating${rCls}" data-id="${h.id}">${rText}</button>
    </div>`;
  }).join('');
  el.historyList.querySelectorAll('.hi-rating').forEach(b => {
    b.addEventListener('click', () => {
      const rec = history.find(h => h.id === b.dataset.id);
      const next = rec.rating === 'good' ? 'stuck' : rec.rating === 'stuck' ? '' : 'good';
      setRating(rec.id, next);
    });
  });
}

/* ============================================================
 * 语音识别（Web Speech API）
 * ============================================================ */
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    el.micBtn.disabled = true;
    el.micHint.textContent = '当前浏览器不支持语音识别，请用文本输入（推荐 Chrome）。';
    return;
  }
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = el.recogLang.value;

  recognition.onstart = () => {
    recognizing = true;
    el.micBtn.textContent = '● 聆听中…（再点停止）';
    el.micBtn.style.borderColor = 'var(--red)';
    el.micBtn.style.color = 'var(--red)';
    setConn('聆听对面', 'warn');
    el.speakerBadge.textContent = '对面说话中…';
    el.speakerBadge.classList.add('live');
  };
  recognition.onresult = (event) => {
    let interim = '', final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const txt = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += txt; else interim += txt;
    }
    if (interim) el.questionInput.value = interim;
    if (final) {
      el.questionInput.value = final;
      stopRecognition();
      ask(final);
    }
  };
  recognition.onerror = (e) => {
    stopRecognition();
    if (e.error === 'not-allowed') toast('麦克风权限被拒绝，请用文本输入');
    else if (e.error !== 'aborted') toast('识别出错：' + e.error);
    setConn('就绪');
  };
  recognition.onend = () => {
    if (recognizing) stopRecognition();
  };
}

function startRecognition() {
  if (!recognition) return;
  recognition.lang = el.recogLang.value;
  try { recognition.start(); } catch (e) { /* already started */ }
}
function stopRecognition() {
  recognizing = false;
  if (recognition) { try { recognition.stop(); } catch (e) {} }
  el.micBtn.textContent = '🎤 听对面说';
  el.micBtn.style.borderColor = '';
  el.micBtn.style.color = '';
  el.speakerBadge.classList.remove('live');
  if (!lastQuestion) el.speakerBadge.textContent = '等待提问';
}

/* ============================================================
 * 配置 / 存储
 * ============================================================ */
function loadCfg() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) cfg = Object.assign({}, cfg, saved);
  } catch (e) {}
  el.cfgJd.value = cfg.jd;
  el.cfgResume.value = cfg.resume;
  el.cfgBank.value = cfg.bank;
  el.cfgBase.value = cfg.base;
  el.cfgKey.value = cfg.key;
  el.cfgModel.value = cfg.model;
  updateEngineStatus();
}
function saveCfgToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  updateEngineStatus();
}
function updateEngineStatus() {
  const on = !!(cfg.key && cfg.key.trim());
  el.engineStatus.textContent = on ? ('当前引擎：LLM（' + cfg.model + '）· 失败自动降级本地') : '当前引擎：本地结构化引擎（离线可演示）';
  el.engineStatus.classList.toggle('llm', on);
}
function loadHistory() {
  try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') || []; }
  catch (e) { history = []; }
  renderHistory();
}
function saveHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50))); }
  catch (e) {}
}

function openDrawer() { el.drawer.classList.add('show'); el.drawerMask.classList.add('show'); el.drawer.setAttribute('aria-hidden','false'); }
function closeDrawer() { el.drawer.classList.remove('show'); el.drawerMask.classList.remove('show'); el.drawer.setAttribute('aria-hidden','true'); }

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

/* ============================================================
 * 事件绑定
 * ============================================================ */
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const q = {
      en: "Your biggest client wants a refund, but company policy doesn't allow it. What would you say?（请用英语回答）",
      dilemma: '明天产品必须上线，今晚发现支付功能可能让部分用户被重复扣款。研发说修复要两天，销售说延期就丢大客户。客户不接受延期，老板也联系不上。你第一步做什么？',
      creative: '假设明天所有外卖平台都消失了。给你一千块，帮一家小餐馆在七天内重新拿到订单。你会怎么做？只能先选一个办法，你选哪个？',
      project: '讲讲你主导过的最有挑战的一个项目，你是怎么做的，结果怎么样？',
      salary: '你的薪资期望是多少？',
      reverse: '你还有什么想问我们的吗？'
    }[chip.dataset.q];
    ask(q);
  });
});

el.askBtn.addEventListener('click', () => ask(el.questionInput.value));
el.questionInput.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ask(el.questionInput.value);
});
el.micBtn.addEventListener('click', () => {
  if (recognizing) stopRecognition(); else startRecognition();
});

el.myTurnBtn.addEventListener('click', () => {
  const on = document.body.classList.toggle('my-turn');
  el.myTurnMask.classList.toggle('show', on);
  if (on) { el.speakerBadge.textContent = '你在说话'; el.speakerBadge.classList.remove('live'); }
  else { el.speakerBadge.textContent = lastQuestion ? '等待回答' : '等待提问'; }
});

el.clearHistory.addEventListener('click', () => {
  if (!history.length) return;
  if (confirm('确定清空本场练习记录？')) { history = []; saveHistory(); renderHistory(); toast('已清空'); }
});

el.openSettings.addEventListener('click', openDrawer);
el.footerSettings.addEventListener('click', openDrawer);
el.closeSettings.addEventListener('click', closeDrawer);
el.drawerMask.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

el.saveCfg.addEventListener('click', () => {
  cfg.jd = el.cfgJd.value;
  cfg.resume = el.cfgResume.value;
  cfg.bank = el.cfgBank.value;
  cfg.base = el.cfgBase.value.trim();
  cfg.key = el.cfgKey.value.trim();
  cfg.model = el.cfgModel.value.trim() || 'gpt-4o-mini';
  saveCfgToStorage();
  closeDrawer();
  toast('配置已保存到本机');
});

el.resetCfg.addEventListener('click', () => {
  cfg = { jd: DEFAULT_JD, resume: DEFAULT_RESUME, bank: DEFAULT_BANK, base: '', key: '', model: 'gpt-4o-mini' };
  localStorage.removeItem(STORAGE_KEY);
  loadCfg();
  toast('已恢复示例配置');
});

/* ---------- 启动 ---------- */
loadCfg();
loadHistory();
initRecognition();
setConn('就绪');
