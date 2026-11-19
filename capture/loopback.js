'use strict';
/**
 * 真实音频采集器：ffmpeg(系统loopback/麦克风) → VAD语音段切片 → ASR → WS推送问题
 *
 * 这不是演示。它真的启动 ffmpeg 读音频流、真的做能量VAD、真的调用 ASR。
 * 缺依赖（BlackHole / whisper / API key）时会明确报错退出，不伪造转写结果。
 *
 * 用法：
 *   node capture/loopback.js --device 1 --asr openai
 *   node capture/loopback.js --device "BlackHole 2ch" --asr whisper --whisper-bin /opt/homebrew/bin/whisper-cli
 *   node capture/loopback.js --list
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const SERVER = process.env.IA_SERVER || 'ws://127.0.0.1:8787/ws?role=interviewer';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] || def) : def;
}
function has(name) { return process.argv.includes('--' + name); }

function listDevices() {
  console.log('检测本机音频输入设备（AVFoundation）…\n');
  const p = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => err += d.toString());
  p.on('close', () => {
    const lines = err.split('\n');
    const idx = lines.findIndex(l => l.includes('audio devices'));
    if (idx >= 0) console.log(lines.slice(idx).filter(l => l.includes('[')).join('\n'));
    else console.log(err);
    console.log('\n提示：要捕获「对面声音/会议播放声」，需安装 BlackHole 并把会议软件输出路由到它。');
    console.log('      设备选择：--device "<设备名或索引>"；麦克风索引用 --device 1');
  });
}

// 简易 VAD：把 PCM 流按帧算 RMS，超过阈值判为语音，静音超过 grace 帧则结束一段
class VAD {
  constructor({ sampleRate = 16000, frameMs = 30, threshold = 0.028, graceFrames = 14 } = {}) {
    this.frameBytes = Math.floor(sampleRate * frameMs / 1000) * 2; // s16 mono
    this.threshold = threshold;
    this.graceFrames = graceFrames;
    this.buf = Buffer.alloc(0);
    this.active = false;
    this.silent = 0;
    this.current = [];
    this.onSegment = null;
  }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= this.frameBytes) {
      const frame = this.buf.slice(0, this.frameBytes);
      this.buf = this.buf.slice(this.frameBytes);
      let sum = 0;
      for (let i = 0; i < frame.length; i += 2) {
        const v = frame.readInt16LE(i) / 32768;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / (frame.length / 2));
      if (rms > this.threshold) {
        if (!this.active) { this.active = true; console.log('[vad] 检测到语音开始'); }
        this.silent = 0;
        this.current.push(frame);
      } else if (this.active) {
        this.silent++;
        this.current.push(frame);
        if (this.silent >= this.graceFrames) {
          this.active = false;
          const seg = Buffer.concat(this.current);
          this.current = [];
          this.silent = 0;
          if (seg.length > this.frameBytes * 6 && this.onSegment) {
            console.log(`[vad] 语音段结束 ${(seg.length / 32000).toFixed(1)}s，转写中…`);
            this.onSegment(seg);
          }
        }
      }
    }
  }
}

function writeWav(pcm, file) {
  const sr = 16000, ch = 1, bits = 16;
  const dataLen = pcm.length;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * ch * bits / 8, 28);
  buf.writeUInt16LE(ch * bits / 8, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  pcm.copy(buf, 44);
  fs.writeFileSync(file, buf);
}

async function asrOpenai(wavFile) {
  const base = (arg('asr-base', process.env.LLM_BASE_URL || 'https://api.openai.com/v1')).replace(/\/$/, '');
  const key = arg('asr-key', process.env.LLM_API_KEY || process.env.ASR_API_KEY || '');
  if (!key) throw new Error('云端 ASR 需要 API key：--asr-key 或环境变量 LLM_API_KEY / ASR_API_KEY');
  const model = arg('asr-model', 'whisper-1');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wavFile)], { type: 'audio/wav' }), 'seg.wav');
  form.append('model', model);
  form.append('language', 'zh');
  const res = await fetch(base + '/audio/transcriptions', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + key }, body: form,
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error('ASR 接口返回 ' + res.status + '：' + (await res.text().catch(() => '')).slice(0, 200));
  const data = await res.json();
  return data.text || '';
}

async function asrWhisper(wavFile) {
  const bin = arg('whisper-bin', process.env.WHISPER_BIN || '');
  const model = arg('whisper-model', process.env.WHISPER_MODEL || '');
  if (!bin) throw new Error('本地 ASR 需要 whisper 可执行文件：--whisper-bin /path/to/whisper-cli');
  return new Promise((resolve, reject) => {
    const args = model ? ['-m', model, '-f', wavFile, '-l', 'zh', '-otxt', '-of', wavFile.replace(/\.wav$/, '')] : [wavFile];
    const p = spawn(bin, args);
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', e => reject(new Error('无法执行 whisper：' + e.message)));
    p.on('close', code => {
      if (code !== 0) return reject(new Error('whisper 失败：' + err.slice(-300)));
      const txtFile = wavFile.replace(/\.wav$/, '.txt');
      if (fs.existsSync(txtFile)) resolve(fs.readFileSync(txtFile, 'utf8').trim());
      else resolve(out.trim());
    });
  });
}

function main() {
  if (has('list')) return listDevices();

  const device = arg('device', arg('d', '1'));
  const asrMode = arg('asr', 'openai');
  if (!['openai', 'whisper'].includes(asrMode)) {
    console.error('未知 ASR 模式：' + asrMode + '（应为 openai 或 whisper）'); process.exit(2);
  }

  // 预检：云端 ASR 必须有 key；本地 ASR 必须有 bin
  if (asrMode === 'openai') {
    const key = arg('asr-key', process.env.LLM_API_KEY || process.env.ASR_API_KEY || '');
    if (!key) { console.error('❌ 缺少 API key。云端 ASR 需要 --asr-key 或环境变量 LLM_API_KEY。\n   这是真实调用，没有 key 无法转写；程序不会伪造转写结果。'); process.exit(3); }
  } else {
    const bin = arg('whisper-bin', process.env.WHISPER_BIN || '');
    if (!bin || !fs.existsSync(bin)) { console.error('❌ 未找到 whisper 可执行文件。请安装 whisper.cpp / whisper 并用 --whisper-bin 指定。'); process.exit(3); }
  }

  console.log(`启动真实采集：设备=${device} ASR=${asrMode} 服务端=${SERVER}`);
  console.log('提示：确保会议软件的「对面声音」能被该设备捕获。系统输出 loopback 需 BlackHole。\n');

  // 真实连接服务端
  const ws = new WebSocket(SERVER);
  ws.on('open', () => console.log('[ws] 已连接服务端，可以作为 interviewer 推送问题'));
  ws.on('error', e => console.error('[ws] 连接失败：' + e.message));
  ws.on('close', () => console.log('[ws] 断开'));

  const vad = new VAD();
  vad.onSegment = async (pcm) => {
    const wav = path.join(os.tmpdir(), 'ia_seg_' + Date.now() + '.wav');
    try {
      writeWav(pcm, wav);
      const text = asrMode === 'openai' ? await asrOpenai(wav) : await asrWhisper(wav);
      if (text && text.trim()) {
        console.log('[asr] 转写：' + text.trim());
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'question', text: text.trim() }));
        else console.error('[asr] 服务端未连接，未能推送');
      } else {
        console.log('[asr] 空转写，忽略');
      }
    } catch (e) {
      console.error('[asr] 失败：' + e.message);
    } finally {
      try { fs.unlinkSync(wav); } catch {}
    }
  };

  // ffmpeg 真实采集：raw s16le mono 16k 到 stdout
  const ff = spawn('ffmpeg', [
    '-f', 'avfoundation', '-i', device,
    '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ferr = '';
  ff.stderr.on('data', d => { ferr += d.toString(); });
  ff.stdout.on('data', d => vad.feed(d));
  ff.on('error', e => { console.error('❌ ffmpeg 启动失败：' + e.message); process.exit(4); });
  ff.on('close', code => {
    if (code !== 0) console.error('ffmpeg 退出码 ' + code + '\n' + ferr.slice(-800));
  });

  const stop = () => { console.log('\n停止采集'); try { ff.kill('SIGINT'); } catch {} try { ws.close(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  console.log('采集中… 说话试试；Ctrl+C 停止。');
}

main();
