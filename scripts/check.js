'use strict';
/**
 * 真实环境自检：不粉饰，缺什么报什么。
 * node scripts/check.js
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = {};
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const s = line.trim(); if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('='); if (i < 0) continue;
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[s.slice(0, i).trim()] = v;
  }
}
// 真实配置源是 data/config.json（配置台写入这里），.env 只是初始默认值。
// 自检必须读真实源，否则会出现"明明配好了却报缺 key"的假警报。
const cfgFile = path.join(ROOT, 'data', 'config.json');
let diskCfg = {};
if (fs.existsSync(cfgFile)) {
  try { diskCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); }
  catch (e) { console.error('  ⚠️ data/config.json 解析失败：' + e.message); }
}
const cfgLLM = Object.assign({}, env, {
  LLM_PROVIDER: diskCfg.llm?.provider || env.LLM_PROVIDER,
  LLM_BASE_URL: diskCfg.llm?.baseUrl || env.LLM_BASE_URL,
  LLM_API_KEY: diskCfg.llm?.apiKey || env.LLM_API_KEY,
  LLM_MODEL: diskCfg.llm?.model || env.LLM_MODEL
});
const cfgASR = Object.assign({}, diskCfg.asr || {});
const cfgSource = fs.existsSync(cfgFile) ? 'data/config.json' : '.env';

function which(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function line(ok, label, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  return ok;
}

console.log('\n面试助手 · 环境自检（真实检测，不粉饰）\n');
console.log('【运行时】');
line(!!which('node'), 'Node.js', process.version);
line(!!which('npm'), 'npm');
line(!!which('ffmpeg'), 'ffmpeg', which('ffmpeg') || '采集音频必需：brew install ffmpeg');
const wsOk = fs.existsSync(path.join(ROOT, 'node_modules', 'ws'));
line(wsOk, 'ws 依赖', wsOk ? '已安装' : '请运行 npm install');

console.log('\n【LLM（真实调用必需，二选一）】');
console.log('  配置来源：' + cfgSource);
const provider = cfgLLM.LLM_PROVIDER || 'ollama';
const key = cfgLLM.LLM_API_KEY || '';
const base = cfgLLM.LLM_BASE_URL || '';
const model = cfgLLM.LLM_MODEL || '';
const ollama = which('ollama');
if (provider === 'openai' || key.startsWith('sk-')) {
  line(!!key, '云端 API key', key ? '已设置（'+key.slice(0,6)+'…'+key.slice(-4)+'）· '+base+' · '+model : '缺 LLM_API_KEY');
} else {
  line(!!ollama, 'Ollama（本机模型）', ollama || '缺：brew install ollama 后 ollama pull qwen2.5:7b');
  if (ollama) {
    const r = spawnSync('ollama', ['list'], { encoding: 'utf8' });
    const models = (r.stdout || '').split('\n').slice(1).filter(x => x.trim());
    line(models.length > 0, '已下载模型', models.length ? models[0].split(/\s+/)[0] + ' 等' : '请先 ollama pull qwen2.5:7b');
  }
}

console.log('\n【ASR / 音频采集（进阶链路，可选）】');
console.log('  说明：最短闭环用「浏览器语音识别 + 云端 LLM」，不需要本节任何组件。');
const asrProvider = cfgASR.provider || env.ASR_PROVIDER || 'doubao';
const asrKey = cfgASR.apiKey || env.ASR_API_KEY || '';
const asrPair = !!(cfgASR.appKey && cfgASR.accessKey) || !!(env.ASR_APP_KEY && env.ASR_ACCESS_KEY);
if (asrProvider === 'doubao') {
  line(!!(asrKey || asrPair), '豆包 ASR 凭证',
    asrKey ? '已设置 API Key（'+asrKey.slice(0,6)+'…）· '+cfgASR.resourceId
    : asrPair ? '已设置 AppKey + AccessKey' : '未配置 — 配置台填 API Key 后可跑真实流式识别');
} else if (asrProvider === 'openai') {
  line(!!asrKey, 'OpenAI ASR 凭证', asrKey ? '已设置' : '未配置');
}
const av = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
const devText = (av.stderr || '');
const hasBH = /BlackHole/i.test(devText);
line(hasBH, 'BlackHole 虚拟声卡', hasBH ? '已检测到（可捕获对面声音，用于远程面试音频采集）' : '未检测到 — 需 brew install blackhole-2ch 并配置输出路由');
const whisperBin = env.WHISPER_BIN || which('whisper-cli') || which('whisper') || which('main');
line(!!whisperBin, '本地 whisper（可选 ASR）', whisperBin || '未安装；当前走豆包云端 ASR，无需本地 whisper');

console.log('\n【结论】');
const canShortLoop = wsOk && (key.startsWith('sk-') || (ollama && provider === 'ollama'));
const asrReady = !!(asrKey || asrPair);
if (canShortLoop) {
  console.log('  ✅ 可跑通闭环：npm start → 提问端输入/说话 → 手机端收真实 LLM 提示 → 回答回流提炼记忆');
  console.log('  ' + (asrReady ? '✅' : '⚠️') + ' 豆包实时 ASR：' + (asrReady ? '凭证已配置，可跑真实流式识别' : '未配凭证 — 文字回答路径可闭环，语音路径需在配置台填 API Key'));
} else {
  console.log('  ⚠️ 需先补齐上面 ❌ 项。最短路径：配置台填一个 OpenAI 兼容 API key（如 DeepSeek）。');
}
console.log('  ℹ️ 面试官语音自动采集（loopback）为进阶链路，需 BlackHole + 豆包 ASR 凭证。');
console.log('');
