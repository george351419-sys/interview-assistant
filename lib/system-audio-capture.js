'use strict';

const { spawn } = require('child_process');
const { DoubaoASR } = require('./doubao-asr');

function listAudioDevices() {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => reject(new Error(error.code === 'ENOENT'
      ? '没有找到 ffmpeg。请先在 Mac 终端运行：brew install ffmpeg'
      : '读取音频设备失败：' + error.message)));
    child.on('close', () => {
      const marker = stderr.toLowerCase().lastIndexOf('audio devices:');
      if (marker < 0) return reject(new Error('ffmpeg 没有返回 AVFoundation 音频设备。请确认运行环境是 macOS。'));
      const audioText = stderr.slice(marker);
      const devices = [];
      for (const line of audioText.split(/\r?\n/)) {
        const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
        if (match) devices.push({ index: Number(match[1]), name: match[2].replace(/\s+\(.*\)$/, '') });
      }
      resolve(devices);
    });
  });
}

class SpeechVAD {
  constructor({ threshold = 0.012, graceFrames = 14, preRollFrames = 5 } = {}) {
    this.frameBytes = 960; // 16kHz / 16-bit / mono / 30ms
    this.threshold = threshold;
    this.graceFrames = graceFrames;
    this.preRollFrames = preRollFrames;
    this.buffer = Buffer.alloc(0);
    this.preRoll = [];
    this.active = false;
    this.silentFrames = 0;
    this.onStart = null;
    this.onFrame = null;
    this.onEnd = null;
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= this.frameBytes) {
      const frame = this.buffer.subarray(0, this.frameBytes);
      this.buffer = this.buffer.subarray(this.frameBytes);
      let energy = 0;
      for (let i = 0; i < frame.length; i += 2) {
        const sample = frame.readInt16LE(i) / 32768;
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / (frame.length / 2));

      if (rms >= this.threshold) {
        if (!this.active) {
          this.active = true;
          this.silentFrames = 0;
          if (this.onStart) this.onStart();
          for (const pre of this.preRoll) if (this.onFrame) this.onFrame(pre);
          this.preRoll = [];
        }
        this.silentFrames = 0;
        if (this.onFrame) this.onFrame(frame);
      } else if (this.active) {
        this.silentFrames++;
        if (this.onFrame) this.onFrame(frame);
        if (this.silentFrames >= this.graceFrames) {
          this.active = false;
          this.silentFrames = 0;
          if (this.onEnd) this.onEnd();
          this.preRoll = [];
        }
      } else {
        this.preRoll.push(frame);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      }
    }
  }

  flush() {
    if (this.active) {
      this.active = false;
      this.silentFrames = 0;
      if (this.onEnd) this.onEnd();
    }
  }
}

class SystemAudioCapture {
  constructor({ deviceIndex, asrConfig, onTranscript, onStatus }) {
    this.deviceIndex = Number(deviceIndex);
    this.asrConfig = asrConfig || {};
    this.onTranscript = onTranscript || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ffmpeg = null;
    this.vad = null;
    this.segment = null;
    this.lastError = '';
    this.deviceName = '';
    this.stopping = false;
  }

  status() {
    return {
      running: !!this.ffmpeg,
      deviceIndex: Number.isInteger(this.deviceIndex) ? this.deviceIndex : null,
      deviceName: this.deviceName,
      error: this.lastError
    };
  }

  async start(deviceName = '') {
    if (this.ffmpeg) throw new Error('系统音频采集已经在运行。');
    if (process.platform !== 'darwin') throw new Error('BlackHole 系统音频采集目前需要在 macOS 上运行。');
    if (!Number.isInteger(this.deviceIndex) || this.deviceIndex < 0) throw new Error('请选择有效的音频输入设备。');
    if (!this.asrConfig.apiKey && !(this.asrConfig.appKey && this.asrConfig.accessKey)) {
      throw new Error('豆包 ASR 尚未配置。请先到配置台填写 ASR 凭证并保存。');
    }
    this.deviceName = deviceName;
    this.lastError = '';
    this.stopping = false;

    const vad = new SpeechVAD();
    this.vad = vad;
    vad.onStart = () => this._startSegment();
    vad.onFrame = frame => this._pushFrame(frame);
    vad.onEnd = () => this._finishSegment();

    // AVFoundation audio-only input uses :<audio-device-index>.
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'avfoundation', '-i', `:${this.deviceIndex}`,
      '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ffmpeg;
    ffmpeg.stdout.on('data', data => vad.feed(data));
    ffmpeg.stderr.on('data', data => {
      this.lastError = (this.lastError + data.toString()).slice(-1200);
    });
    ffmpeg.on('error', error => {
      this.lastError = error.code === 'ENOENT'
        ? '没有找到 ffmpeg。请在 Mac 终端运行：brew install ffmpeg'
        : '启动 ffmpeg 失败：' + error.message;
      this.ffmpeg = null;
      this.onStatus(this.status());
    });
    ffmpeg.on('close', code => {
      vad.flush();
      if (this.ffmpeg === ffmpeg) this.ffmpeg = null;
      if (code && !this.stopping && !this.lastError) this.lastError = `ffmpeg 已退出（${code}）。请检查 BlackHole 设备和 macOS 音频路由。`;
      this.stopping = false;
      this.onStatus(this.status());
    });
    this.onStatus(this.status());
    return this.status();
  }

  _startSegment() {
    if (this.segment) this._finishSegment();
    let resolveDone;
    const session = {
      asr: null,
      pending: Buffer.alloc(0),
      ready: false,
      ending: false,
      settled: false,
      done: new Promise(resolve => { resolveDone = resolve; }),
      resolveDone: null
    };
    session.resolveDone = resolveDone;
    this.segment = session;
    console.log('[system-audio] 检测到会议语音，连接豆包 ASR…');
    session.asr = new DoubaoASR({
      apiKey: this.asrConfig.apiKey || '',
      appKey: this.asrConfig.appKey || '',
      accessKey: this.asrConfig.accessKey || '',
      resourceId: this.asrConfig.resourceId || 'volc.seedasr.sauc.duration',
      uid: 'ia-system-audio',
      enableSpeaker: false
    }, {
      onPartial: (text) => this.onStatus({ ...this.status(), recognizing: text || '' }),
      onFinal: text => {
        if (session.settled) return;
        session.settled = true;
        const transcript = String(text || '').trim();
        console.log('[system-audio] ASR 完成：' + (transcript || '(空结果)'));
        if (transcript) this.onTranscript(transcript);
        if (this.segment === session) this.segment = null;
        session.resolveDone();
        this.onStatus(this.status());
      },
      onError: error => {
        this.lastError = '豆包 ASR 错误：' + error.message;
        console.error('[system-audio] ' + this.lastError);
        if (this.segment === session) this.segment = null;
        session.settled = true;
        session.resolveDone();
        this.onStatus(this.status());
      }
    });
    session.startPromise = session.asr.start().then(() => {
      session.ready = true;
      this._flushSession(session);
    }).catch(error => {
      this.lastError = error.message;
      session.settled = true;
      if (this.segment === session) this.segment = null;
      session.resolveDone();
      this.onStatus(this.status());
    });
  }

  _pushFrame(frame) {
    const session = this.segment;
    if (!session || session.ending || session.settled) return;
    session.pending = Buffer.concat([session.pending, frame]);
    this._flushSession(session);
  }

  _flushSession(session) {
    if (!session.ready || session.settled) return;
    const chunkSize = 6400; // 200ms @ 16kHz, 16-bit, mono
    while (session.pending.length >= chunkSize) {
      session.asr.pushAudio(session.pending.subarray(0, chunkSize));
      session.pending = session.pending.subarray(chunkSize);
    }
    if (session.ending) {
      if (session.pending.length) session.asr.pushAudio(session.pending);
      session.pending = Buffer.alloc(0);
      session.asr.finish();
    }
  }

  _finishSegment() {
    const session = this.segment;
    if (!session || session.ending) return;
    session.ending = true;
    if (session.ready) this._flushSession(session);
  }

  async stop() {
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg) return this.status();
    this.stopping = true;
    this.ffmpeg = null;
    try { ffmpeg.kill('SIGINT'); } catch {}
    if (this.vad) this.vad.flush();
    this.vad = null;
    const session = this.segment;
    if (session) {
      await Promise.race([session.done, new Promise(resolve => setTimeout(resolve, 10000))]);
      if (!session.settled && session.asr) session.asr.close();
    }
    this.segment = null;
    this.onStatus(this.status());
    return this.status();
  }
}

module.exports = { listAudioDevices, SystemAudioCapture };
