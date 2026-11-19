/* 公共：WebSocket 连接封装 + 导航 + toast */
(function (global) {
  'use strict';

  function wsUrl(role) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws?role=${encodeURIComponent(role)}`;
  }

  class Client {
    constructor(role, handlers = {}) {
      this.role = role;
      this.handlers = handlers;
      this.ws = null;
      this.retry = null;
      this.connect();
    }
    connect() {
      try {
        const ws = new WebSocket(wsUrl(this.role));
        this.ws = ws;
        ws.onopen = () => {
          clearTimeout(this.retry);
          if (this.handlers.onOpen) this.handlers.onOpen();
        };
        ws.onmessage = (e) => {
          let msg; try { msg = JSON.parse(e.data); } catch { return; }
          if (this.handlers.onMessage) this.handlers.onMessage(msg);
          const fn = this.handlers['on:' + msg.type];
          if (fn) fn(msg);
        };
        ws.onclose = () => {
          if (this.handlers.onClose) this.handlers.onClose();
          clearTimeout(this.retry);
          this.retry = setTimeout(() => this.connect(), 1500);
        };
        ws.onerror = () => {};
      } catch (e) {
        this.retry = setTimeout(() => this.connect(), 1500);
      }
    }
    send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
    question(text) { this.send({ type: 'question', text }); }
    state(state) { this.send({ type: 'state', state }); }
    answer(text) { this.send({ type: 'answer', text }); }
    asrStart() { this.send({ type: 'asr.start' }); }
    asrChunk(base64) { this.send({ type: 'asr.chunk', data: base64 }); }
    asrStop() { this.send({ type: 'asr.stop' }); }
    memoryClear() { this.send({ type: 'memory.clear' }); }
    sessionGet() { this.send({ type: 'session.get' }); }
    sessionStart(mode) { this.send({ type: 'session.start', mode: mode || 'free' }); }
    sessionEnd() { this.send({ type: 'session.end' }); }
    sessionRetry() { this.send({ type: 'session.retry' }); }
    sessionReeval(id) { this.send({ type: 'session.reevaluate', id }); }
    historyList() { this.send({ type: 'history.list' }); }
    historyGet(id) { this.send({ type: 'history.get', id }); }
    historyDelete(id) { this.send({ type: 'history.delete', id }); }
    historyClear() { this.send({ type: 'history.clear' }); }
  }

  // 练习计时器：从提示出现跑到回答提交，供手机提示屏显示
  class PracticeTimer {
    constructor(onTick) { this.startAt = null; this.timer = null; this.onTick = onTick; }
    start() {
      this.stop();
      this.startAt = Date.now();
      this.timer = setInterval(() => {
        if (this.onTick) this.onTick(Date.now() - this.startAt);
      }, 250);
      if (this.onTick) this.onTick(0);
    }
    stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } return this.startAt ? Date.now() - this.startAt : 0; }
    elapsed() { return this.startAt ? Date.now() - this.startAt : 0; }
  }

  function fmtDuration(ms) {
    if (ms == null) return '—';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60), ss = s % 60;
    if (m < 60) return m + ' 分 ' + String(ss).padStart(2, '0') + ' 秒';
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }

  function setConn(sel, state, text) {
    const el = document.querySelector(sel);
    if (!el) return;
    el.className = 'conn-pill ' + (state === 'on' ? 'on' : state === 'warn' ? 'warn' : state === 'err' ? 'err' : '');
    const t = el.querySelector('.text'); if (t) t.textContent = text;
  }

  let toastTimer;
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function nav(active) {
    const items = [
      ['index.html', '首页', ''],
      ['interviewer.html', '提问端', 'interviewer'],
      ['me.html', '我的回答', 'me'],
      ['phone.html', '手机提示屏', 'phone'],
      ['practice.html', '练习复盘', 'practice'],
      ['console.html', '配置台', 'console']
    ];
    return `<div class="topnav">
      <div class="brand"><span class="mark">面</span> 面试助手 <span class="badge ok" style="margin-left:6px">真实运行版</span></div>
      <nav>${items.map(([href, label, key]) => `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <span class="conn-pill" id="conn"><span class="dot"></span><span class="text">连接中</span></span>
    </div>`;
  }

  global.IAC = { Client, PracticeTimer, fmtDuration, setConn, toast, nav, wsUrl };
})(window);
