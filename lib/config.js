'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const CFG_FILE = path.join(ROOT, 'data', 'config.json');

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
2. 明天产品必须上线，今晚发现支付功能可能让部分用户被重复扣款，研发说修复要两天，销售说延期就丢大客户。你怎么办？ → 先止损，再评估影响面，同步干系人，给决策选项
3. 假设明天所有外卖平台都消失了，给你一千块，帮一家小餐馆在七天内重新拿到订单，你会怎么做？ → 明确目标与约束，选最小验证渠道，把钱花在可验证获客上`;

function parseEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  const txt = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function defaultConfig() {
  const env = parseEnv();
  return {
    jd: DEFAULT_JD,
    resume: DEFAULT_RESUME,
    bank: DEFAULT_BANK,
    llm: {
      provider: env.LLM_PROVIDER || 'ollama',
      baseUrl: env.LLM_BASE_URL || 'http://127.0.0.1:11434',
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || 'qwen2.5:7b'
    },
    asr: {
      provider: env.ASR_PROVIDER || 'doubao',
      apiKey: env.ASR_API_KEY || '',
      appKey: env.ASR_APP_KEY || '',
      accessKey: env.ASR_ACCESS_KEY || '',
      resourceId: env.ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration',
      whisperBin: env.WHISPER_BIN || '',
      whisperModel: env.WHISPER_MODEL || ''
    },
    port: Number(env.PORT || 8787)
  };
}

let state = defaultConfig();

function load() {
  try {
    if (fs.existsSync(CFG_FILE)) {
      const disk = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
      state = deepMerge(defaultConfig(), disk);
    }
  } catch (e) {
    console.error('[config] 读取失败，使用默认配置：', e.message);
  }
  return state;
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) {
      out[k] = deepMerge(base[k] || {}, over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

function get() { return state; }

function update(patch) {
  state = deepMerge(state, patch);
  persist();
  return state;
}

function persist() {
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function reset() {
  state = defaultConfig();
  persist();
  return state;
}

function publicSafe() {
  const c = JSON.parse(JSON.stringify(state));
  const mask = (v) => v ? v.slice(0, 4) + '****' + v.slice(-4) : '';
  if (c.llm.apiKey) c.llm.apiKey = mask(c.llm.apiKey);
  if (c.asr) {
    if (c.asr.apiKey) c.asr.apiKey = mask(c.asr.apiKey);
    if (c.asr.accessKey) c.asr.accessKey = mask(c.asr.accessKey);
  }
  return c;
}

module.exports = { load, get, update, reset, persist, publicSafe, CFG_FILE, ROOT };
