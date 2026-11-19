'use strict';
/**
 * 豆包双向流式语音识别（大模型 2.0）客户端
 * 协议：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
 * 鉴权：X-Api-Key（新版控制台）/ X-Api-App-Key + X-Api-Access-Key（旧版）
 *
 * 帧结构（4 字节 header + 可选 seq + payload_size + gzip payload）：
 *   byte0: (version<<4)|header_size   = 0x11
 *   byte1: (message_type<<4)|flags
 *   byte2: (serialization<<4)|compression
 *   byte3: reserved 0x00
 *   seq:    int32 BE
 *   size:   uint32 BE
 *   payload: gzip(json) 或 gzip(pcm)
 *
 * 用法：
 *   const s = new DoubaoASR(cfg, { onPartial, onFinal, onError, onClose });
 *   await s.start();           // 连接 + 发首帧 full request
 *   s.pushAudio(pcmBuffer);    // 每次 200ms 的 16k/16bit/mono PCM
 *   s.finish();                // 发尾帧，等最终结果后自动关闭
 */
const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');

// 生产用官方地址；ASR_WS_URL 仅用于本地协议自测（mock 服务），默认不设置
const URL = process.env.ASR_WS_URL || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';

// 帧常量
const T = {
  FULL_CLIENT: 0b0001,
  AUDIO_ONLY: 0b0010,
  SERVER_FULL: 0b1001,
  SERVER_ERROR: 0b1111
};
const F = { NO_SEQ: 0b0000, POS_SEQ: 0b0001, NEG_WITH_SEQ: 0b0011 };
const S = { JSON: 0b0001 };
const C = { GZIP: 0b0001 };

function header(type, flags) {
  const b = Buffer.alloc(4);
  b[0] = (0b0001 << 4) | 1;          // version=1, header_size=1 (×4=4 bytes)
  b[1] = (type << 4) | flags;
  b[2] = (S.JSON << 4) | C.GZIP;
  b[3] = 0;
  return b;
}

function fullRequestFrame(seq, payloadObj) {
  const json = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const gz = zlib.gzipSync(json);
  const seqB = Buffer.alloc(4); seqB.writeInt32BE(seq, 0);
  const sizeB = Buffer.alloc(4); sizeB.writeUInt32BE(gz.length, 0);
  return Buffer.concat([header(T.FULL_CLIENT, F.POS_SEQ), seqB, sizeB, gz]);
}

function audioFrame(seq, pcm, isLast) {
  const flags = isLast ? F.NEG_WITH_SEQ : F.POS_SEQ;
  const s = isLast ? -seq : seq;
  const gz = zlib.gzipSync(pcm);
  const seqB = Buffer.alloc(4); seqB.writeInt32BE(s, 0);
  const sizeB = Buffer.alloc(4); sizeB.writeUInt32BE(gz.length, 0);
  return Buffer.concat([header(T.AUDIO_ONLY, flags), seqB, sizeB, gz]);
}

/**
 * 生成 44 字节 WAV 头（16k / 16bit / mono）。
 * 豆包 bigmodel 官方 demo 发送的是带 WAV 头的音频；流式场景总长度未知，
 * RIFF/data size 填 0xFFFFFFFF（经真实端点验证服务端接受）。
 * 只需在整条流的第一片音频前拼一次。
 */
function wavHeader() {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(0xFFFFFFFF, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);            // PCM
  h.writeUInt16LE(1, 22);            // mono
  h.writeUInt32LE(16000, 24);        // sample rate
  h.writeUInt32LE(32000, 28);        // byte rate = 16000*2*1
  h.writeUInt16LE(2, 32);            // block align
  h.writeUInt16LE(16, 34);           // bits per sample
  h.write('data', 36); h.writeUInt32LE(0xFFFFFFFF, 40);
  return h;
}

function parseFrame(buf) {
  const headerSize = (buf[0] & 0x0f) * 4;
  const msgType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const serialization = buf[2] >> 4;
  const compression = buf[2] & 0x0f;
  let off = headerSize;
  let seq = 0, isLast = false, code = 0;
  if (flags & 0x01) { seq = buf.readInt32BE(off); off += 4; }
  if (flags & 0x02) isLast = true;
  let event;
  if (flags & 0x04) { event = buf.readInt32BE(off); off += 4; }
  let size = 0;
  if (msgType === T.SERVER_FULL) { size = buf.readUInt32BE(off); off += 4; }
  else if (msgType === T.SERVER_ERROR) { code = buf.readInt32BE(off); size = buf.readUInt32BE(off + 4); off += 8; }
  let payload = buf.slice(off);
  if (compression === C.GZIP && payload.length) {
    try { payload = zlib.gunzipSync(payload); } catch (e) { return { code: -1, error: 'gzip 解压失败: ' + e.message }; }
  }
  let msg = null;
  if (serialization === S.JSON && payload.length) {
    try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { msg = null; }
  }
  return { seq, isLast, code, event, msg };
}

function extractText(msg) {
  if (!msg) return { text: '', definite: true, utterances: [] };
  // 真实服务端两种结构都出现过：
  //   1) { payload_msg: { result: {...} } }   （部分响应包）
  //   2) { result: { text, utterances } }     （双向流式实时包，无 payload_msg 外层）
  const body = msg.payload_msg || msg;
  const result = body.result || {};
  const text = result.text || '';
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  const definite = utterances.length ? utterances.every(u => u.definite === true) : true;
  return { text, definite, utterances };
}

class DoubaoASR {
  /**
   * cfg: { apiKey, appKey, accessKey, resourceId, uid, enableSpeaker }
   * handlers: { onPartial(text, definite), onFinal(text, utterances), onError(err), onClose() }
   */
  constructor(cfg, handlers = {}) {
    this.cfg = Object.assign({
      resourceId: 'volc.seedasr.sauc.duration',
      uid: 'interview-assistant',
      enableSpeaker: true
    }, cfg || {});
    this.h = handlers;
    this.ws = null;
    this.seq = 1;
    this.started = false;
    this.finished = false;
    this.finalText = '';
    this.lastPartial = '';
    this.wavHeaderSent = false;   // WAV 头只在第一片音频前拼一次
    this.pendingPcm = null;       // 延迟一段发送：手里始终留一片，finish 时它作为 is_last 尾帧
  }

  start() {
    return new Promise((resolve, reject) => {
      const headers = {
        'X-Api-Resource-Id': this.cfg.resourceId,
        'X-Api-Request-Id': crypto.randomUUID()
      };
      if (this.cfg.apiKey) headers['X-Api-Key'] = this.cfg.apiKey;
      else if (this.cfg.appKey && this.cfg.accessKey) {
        headers['X-Api-App-Key'] = this.cfg.appKey;
        headers['X-Api-Access-Key'] = this.cfg.accessKey;
      } else {
        reject(new Error('豆包 ASR 缺少凭证：需 apiKey 或 appKey+accessKey'));
        return;
      }
      let settled = false;
      this.ws = new WebSocket(URL, { headers });
      this.ws.on('open', () => {
        const payload = {
          user: { uid: this.cfg.uid },
          // 官方 demo：format=wav + codec=raw，发送带 WAV 头的音频流。
          // seq 从 1 起；首帧占用 seq=1，音频帧从 2 递增，尾帧（最后一片音频）seq 取负。
          audio: { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
          request: {
            model_name: 'bigmodel',
            enable_itn: true,
            enable_punc: true,
            enable_ddc: true,
            show_utterances: true,
            enable_nonstream: true,
            enable_speaker_info: !!this.cfg.enableSpeaker
          }
        };
        this.ws.send(fullRequestFrame(this.seq++, payload));
        // 首帧后服务端会回一个确认包
        settled = true;
        this.started = true;
        resolve();
      });
      this.ws.on('message', (data) => this._onMessage(data));
      this.ws.on('error', (e) => {
        if (!settled) { settled = true; reject(new Error('豆包 ASR 连接失败：' + e.message)); }
        else if (this.h.onError) this.h.onError(e);
      });
      this.ws.on('close', () => { if (this.h.onClose) this.h.onClose(); });
    });
  }

  _onMessage(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const r = parseFrame(buf);
    if (r.code && r.code !== 0) {
      const err = new Error('豆包 ASR 服务端错误 code=' + r.code + (r.msg ? ' ' + JSON.stringify(r.msg).slice(0, 200) : ''));
      if (this.h.onError) this.h.onError(err);
      return;
    }
    const { text, definite, utterances } = extractText(r.msg);
    if (!text) return;
    if (r.isLast) {
      this.finalText = text;
      if (this.h.onFinal) this.h.onFinal(text, utterances);
    } else {
      this.lastPartial = text;
      if (this.h.onPartial) this.h.onPartial(text, definite);
    }
  }

  /** 真正把一片音频发出去；第一片自动拼 WAV 头 */
  _sendAudio(pcm, isLast) {
    let data = pcm;
    if (!this.wavHeaderSent) {
      data = Buffer.concat([wavHeader(), pcm]);
      this.wavHeaderSent = true;
    }
    this.ws.send(audioFrame(this.seq, data, isLast));
    if (!isLast) this.seq++;
  }

  /**
   * 推送一段裸 PCM（16k/16bit/mono），调用方按 200ms 节拍。
   * 延迟一片发送：先把上一片发出去，当前片缓存起来——这样 finish 时
   * 手里那片就是「最后一片真实音频」，按官方协议以 is_last(seq 取负) 发出。
   */
  pushAudio(pcm) {
    if (!this.started || this.finished || !this.ws || this.ws.readyState !== 1) return false;
    if (this.pendingPcm) this._sendAudio(this.pendingPcm, false);
    this.pendingPcm = pcm;
    return true;
  }

  /** 把缓存的最后一片作为尾帧发出（seq 取负 + NEG_WITH_SEQ），服务端回最终结果 */
  finish() {
    if (!this.started || this.finished || !this.ws || this.ws.readyState !== 1) return;
    this.finished = true;
    if (this.pendingPcm) {
      this._sendAudio(this.pendingPcm, true);
      this.pendingPcm = null;
    } else if (!this.wavHeaderSent) {
      // 一个音频分片都没收到：发一个只有 WAV 头的最小尾帧，避免服务端一直等
      this._sendAudio(Buffer.alloc(0), true);
    }
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch (e) {}
  }
}

module.exports = { DoubaoASR, fullRequestFrame, audioFrame, wavHeader, parseFrame, extractText, URL };
