'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./lib/config');
const llm = require('./lib/llm');
const Hub = require('./lib/hub');
const { listAudioDevices, SystemAudioCapture } = require('./lib/system-audio-capture');

config.load();
const PORT = Number(process.env.PORT || config.get().port || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.APP_SESSION_SECRET || APP_PASSWORD;
const AUTH_REQUIRED = process.env.NODE_ENV === 'production' || !!APP_PASSWORD;
if (process.env.NODE_ENV === 'production' && (!APP_PASSWORD || !SESSION_SECRET)) {
  throw new Error('公网部署必须配置 APP_PASSWORD 和 APP_SESSION_SECRET');
}
const SESSION_TOKEN = AUTH_REQUIRED
  ? crypto.createHmac('sha256', SESSION_SECRET).update('interview-assistant-session-v1').digest('hex')
  : '';
let systemAudioCapture = null;

function hasValidSession(req) {
  if (!AUTH_REQUIRED || !SESSION_TOKEN) return !AUTH_REQUIRED;
  const raw = String(req.headers.cookie || '').split(';').map(s => s.trim());
  const value = raw.find(s => s.startsWith('ia_session='))?.slice('ia_session='.length) || '';
  const a = Buffer.from(value);
  const b = Buffer.from(SESSION_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// 题库解析：优先取最后一个 " → "（题目本身可能含箭头），兼容旧的 -> / 参考答案写法
function parseBank(raw) {
  return String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((line, i) => {
    let q = line, ref = '';
    let pos = line.lastIndexOf(' → ');
    if (pos <= 0) pos = line.lastIndexOf(' -> ');
    if (pos <= 0) {
      const m = line.search(/：答案|参考答案/);
      if (m > 0) pos = m;
    }
    if (pos > 0) {
      q = line.slice(0, pos).trim();
      ref = line.slice(pos).replace(/^\s*(?:→|->|：答案|参考答案[:：]?)\s*/, '').trim();
    }
    q = q.replace(/^\d+[\.、]\s*/, '').trim();
    return { id: i + 1, question: q, reference: ref };
  }).filter(x => x.question);
}

function bankResponse() {
  const bank = String(config.get().bank || '');
  const items = parseBank(bank);
  return { count: items.length, items, bank };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/auth/login' && req.method === 'POST' && AUTH_REQUIRED) {
    try {
      const body = await readBody(req);
      if (typeof body.password !== 'string' || body.password !== APP_PASSWORD) {
        return json(res, 401, { ok: false, error: '密码不正确' });
      }
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      const cookie = `ia_session=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`;
      res.setHeader('Set-Cookie', cookie);
      return json(res, 200, { ok: true, next: typeof body.next === 'string' && body.next.startsWith('/') && !body.next.startsWith('//') ? body.next : '/' });
    } catch (e) {
      return json(res, 400, { ok: false, error: '登录请求无效' });
    }
  }

  if (AUTH_REQUIRED && !hasValidSession(req) && p !== '/login.html' && p !== '/api/health') {
    if (p.startsWith('/api/')) return json(res, 401, { ok: false, error: '请先登录' });
    res.writeHead(302, { Location: `/login.html?next=${encodeURIComponent(req.url)}`, 'Cache-Control': 'no-store' });
    return res.end();
  }

  // ---- API ----
  if (p === '/api/health') return json(res, 200, { ok: true, time: Date.now(), version: '1.0.0' });

  if (p === '/api/system-audio/devices' && req.method === 'GET') {
    try {
      const devices = await listAudioDevices();
      return json(res, 200, { ok: true, devices: devices.map(d => ({ ...d, isBlackHole: /blackhole/i.test(d.name) })) });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/system-audio/status' && req.method === 'GET') {
    return json(res, 200, { ok: true, status: systemAudioCapture ? systemAudioCapture.status() : { running: false } });
  }

  if (p === '/api/system-audio/start' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const devices = await listAudioDevices();
      const device = devices.find(d => d.index === Number(body.deviceIndex));
      if (!device) return json(res, 400, { ok: false, error: '没有找到所选音频设备，请刷新设备列表。' });
      if (!/blackhole/i.test(device.name)) {
        return json(res, 400, { ok: false, error: '请选择 BlackHole 虚拟音频设备；普通麦克风不会捕获会议播放声。' });
      }
      if (systemAudioCapture && systemAudioCapture.status().running) {
        return json(res, 409, { ok: false, error: '系统音频采集已经在运行。' });
      }
      const capture = new SystemAudioCapture({
        deviceIndex: device.index,
        deviceName: device.name,
        asrConfig: config.get().asr,
        onTranscript: text => hub.submitMeetingQuestion(text, 'system-audio'),
        onStatus: status => {
          hub.broadcast({ type: 'systemAudio.status', status }, 'interviewer');
          hub.broadcast({ type: 'systemAudio.status', status }, 'console');
        }
      });
      systemAudioCapture = capture;
      const status = await capture.start(device.name);
      console.log(`[system-audio] 已启动 BlackHole 采集：${device.name} (${device.index})`);
      return json(res, 200, { ok: true, status });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/system-audio/stop' && req.method === 'POST') {
    try {
      const status = systemAudioCapture ? await systemAudioCapture.stop() : { running: false };
      systemAudioCapture = null;
      return json(res, 200, { ok: true, status });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, { config: config.publicSafe(), llm: llm.status() });
  }

  if (p === '/api/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.jd === 'string') patch.jd = body.jd;
      if (typeof body.resume === 'string') patch.resume = body.resume;
      if (typeof body.bank === 'string') patch.bank = body.bank;
      if (body.llm && typeof body.llm === 'object') {
        patch.llm = {};
        for (const k of ['provider', 'baseUrl', 'model']) {
          if (typeof body.llm[k] === 'string') patch.llm[k] = body.llm[k].trim();
        }
        // key：传入非空且非掩码时才更新
        if (typeof body.llm.apiKey === 'string' && body.llm.apiKey.trim() && !body.llm.apiKey.includes('****')) {
          patch.llm.apiKey = body.llm.apiKey.trim();
        }
      }
      if (body.asr && typeof body.asr === 'object') {
        patch.asr = {};
        for (const k of ['provider', 'resourceId', 'whisperBin', 'whisperModel']) {
          if (typeof body.asr[k] === 'string') patch.asr[k] = body.asr[k].trim();
        }
        // key 类字段：非空且非掩码时才更新
        for (const k of ['apiKey', 'appKey', 'accessKey']) {
          if (typeof body.asr[k] === 'string' && body.asr[k].trim() && !body.asr[k].includes('****')) {
            patch.asr[k] = body.asr[k].trim();
          }
        }
      }
      config.update(patch);
      return json(res, 200, { ok: true, config: config.publicSafe(), llm: llm.status() });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (p === '/api/config/reset' && req.method === 'POST') {
    config.reset();
    return json(res, 200, { ok: true, config: config.publicSafe(), llm: llm.status() });
  }

  if (p === '/api/llm/status') return json(res, 200, llm.status());

  if (p === '/api/asr/status') {
    const a = config.get().asr || {};
    const hasKey = !!(a.apiKey || (a.appKey && a.accessKey));
    return json(res, 200, { provider: a.provider || 'doubao', ready: hasKey, resourceId: a.resourceId || '' });
  }

  // 题库：把 config.bank 的每行 "题目 → 参考答案" 解析成结构化列表，供模拟面试模式顺序出题
  if (p === '/api/bank' && req.method === 'GET') {
    return json(res, 200, bankResponse());
  }

  // 题库写回：整表持久化（可视化管理页用）。也支持直接提交 raw 文本做批量导入。
  if (p === '/api/bank' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      let items;
      if (Array.isArray(body.items)) {
        items = body.items.map(x => ({
          question: String((x && x.question) || '').replace(/\s+/g, ' ').trim(),
          reference: String((x && x.reference) || '').replace(/\s+/g, ' ').trim()
        })).filter(x => x.question);
      } else if (typeof body.bank === 'string') {
        items = parseBank(body.bank);
      } else {
        throw new Error('需要 items 数组或 bank 文本');
      }
      const text = items.map((x, i) => `${i + 1}. ${x.question}${x.reference ? ' → ' + x.reference : ''}`).join('\n');
      config.update({ bank: text });
      const d = bankResponse();
      return json(res, 200, { ok: true, ...d });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  // ---- 静态文件 ----
  let rel = p === '/' ? '/index.html' : p;
  rel = rel.replace(/\.\./g, '');
  let file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) file = path.join(PUBLIC, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

const hub = new Hub(server, AUTH_REQUIRED ? {
  verifyClient: (info, done) => {
    const ok = hasValidSession(info.req);
    done(ok, ok ? undefined : 401, ok ? undefined : 'Authentication required');
  }
} : undefined);

// Keep WebSocket sessions active through EdgeOne's configurable idle timeout.
// Browsers automatically answer WebSocket control-frame pings with pongs.
const heartbeat = setInterval(() => {
  for (const ws of hub.wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);
hub.wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

function shutdown(signal) {
  console.log(`[server] 收到 ${signal}，正在关闭服务…`);
  if (systemAudioCapture) systemAudioCapture.stop().catch(() => {});
  clearInterval(heartbeat);
  hub.wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  面试助手 · 真实可运行版');
  console.log('  ─────────────────────────────────');
  console.log(`  服务已启动  http://${HOST}:${PORT}`);
  console.log(`  配置台      http://localhost:${PORT}/console.html`);
  console.log(`  提问端      http://localhost:${PORT}/interviewer.html`);
  console.log(`  手机提示屏  http://localhost:${PORT}/phone.html`);
  console.log(`  WebSocket   ws://localhost:${PORT}/ws`);
  console.log('');
  const s = llm.status();
  console.log(`  LLM 配置：${s.ready ? s.provider + ' · ' + s.model : '未就绪（缺 ' + s.missing.join(', ') + '）'}`);
  if (s.ready) {
    // 真实探测端点可达性，区分「配置齐全」与「模型真的在跑」
    const probe = s.provider === 'ollama' ? s.base.replace(/\/$/, '') + '/api/tags' : s.base.replace(/\/$/, '') + '/models';
    fetch(probe, { signal: AbortSignal.timeout(2500) })
      .then(r => console.log(`  LLM 可达：${r.ok ? '✅ 端点响应正常' : '⚠️ HTTP ' + r.status}`))
      .catch(() => console.log(`  LLM 可达：❌ 无法连接 ${s.base} —— 请启动模型服务，否则提问会报错`));
  }
  const a = config.get().asr || {};
  const asrReady = !!(a.apiKey || (a.appKey && a.accessKey));
  console.log(`  ASR 配置：${asrReady ? '✅ 豆包 ASR 已配置 · ' + (a.resourceId || '') : '❌ 豆包 ASR 未配置（缺 API Key）—— 回答转写不可用，可手动输入回答'}`);
  console.log('  ⚠️ 仅用于模拟练习，请勿在真实面试中使用。');
  console.log('');
});

process.on('SIGINT', () => { console.log('\n服务已停止'); process.exit(0); });
