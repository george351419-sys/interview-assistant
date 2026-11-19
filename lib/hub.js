'use strict';
const { WebSocketServer } = require('ws');
const llm = require('./llm');
const config = require('./config');
const { SessionMemory, structureResume, selectRelevant } = require('./memory');
const { DoubaoASR } = require('./doubao-asr');
const history = require('./history');

/**
 * 角色：
 *  - interviewer  提问端（对面提问）：question / asr 音频
 *  - me           我的回答端（麦克风）：asr 音频流 → 豆包 ASR → 滚动记忆
 *  - phone        提示屏，接收 hint
 *  - console      配置台 / 调试，接收所有事件
 */
class Hub {
  constructor(server, options = {}) {
    this.wss = new WebSocketServer({ server, path: '/ws', verifyClient: options.verifyClient });
    this.clients = new Map(); // ws -> { role, id }
    this.session = [];         // 本场练习回合记录（复盘数据源）
    this.seq = 0;
    this.memory = new SessionMemory();          // 本场滚动记忆
    this.pendingAnswer = '';                    // 我的上一轮回答（供下一题提炼）
    this.phoneMode = 'guided';                  // guided 生成完整示范；practice 仅生成提纲
    this.asrSessions = new Map();               // ws -> DoubaoASR 实例
    this.practice = {                          // 本场练习元信息
      startedAt: Date.now(),
      mode: 'free',                            // free / mock
      questionCount: 0
    };
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  onConnection(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role') || 'console';
    const id = (++this.seq).toString(36);
    this.clients.set(ws, { role, id });
    console.log(`[hub] 连接 role=${role} id=${id} 当前${this.clients.size}`);
    this.send(ws, { type: 'hello', role, id, llm: llm.status(), time: Date.now() });
    this.broadcast({ type: 'presence', roles: this.roleCounts() }, 'console');

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      this.onMessage(ws, { role, id }, msg);
    });
    ws.on('close', () => {
      this.clients.delete(ws);
      const asr = this.asrSessions.get(ws);
      if (asr) { asr.close(); this.asrSessions.delete(ws); }
      console.log(`[hub] 断开 role=${role} id=${id}`);
      this.broadcast({ type: 'presence', roles: this.roleCounts() }, 'console');
    });
    ws.on('error', () => {});
  }

  roleCounts() {
    const r = { interviewer: 0, me: 0, phone: 0, console: 0, practice: 0 };
    for (const c of this.clients.values()) if (r[c.role] !== undefined) r[c.role]++;
    return r;
  }

  /** 把当前场存档（若有回答且未存过）。等待未完成的 AI 评分落定，避免最后几题丢分。 */
  async archiveCurrent() {
    if (this.practice.archived) return false;
    const answered = this.session.filter(x => x.answeredAt && x.question);
    if (!answered.length) return false;
    this.practice.archived = true; // 立即标记，避免换场/结束时重复存档
    // 先固定本场引用：startPractice 会清空 this.session / this.practice
    const sessionCopy = this.session.slice();
    const practiceCopy = { ...this.practice };
    const pending = sessionCopy.filter(x => x.evalPending && x.evalPromise);
    if (pending.length) {
      console.log(`[hub] 存档前等待 ${pending.length} 题 AI 评分完成…`);
      try {
        await Promise.race([
          Promise.allSettled(pending.map(x => x.evalPromise)),
          new Promise(r => setTimeout(r, 22000))
        ]);
      } catch (e) { /* 评分失败也不阻塞存档 */ }
    }
    try {
      const snap = this.sessionSnapshot(sessionCopy, practiceCopy);
      const r = history.save(snap);
      this.lastArchivedId = r.id;
      console.log(`[hub] 练习已存档 ${r.id}（${answered.length} 题）`);
      this.broadcast({ type: 'history.saved', id: r.id, count: answered.length }, 'practice');
      this.broadcast({ type: 'history.saved', id: r.id, count: answered.length }, 'console');
      return true;
    } catch (e) {
      console.error('[hub] 练习存档失败:', e.message);
      return false;
    }
  }

  /** 开始一场新练习 */
  startPractice(mode) {
    this.archiveCurrent().catch(() => {}); // 换场前先存上一场（异步等评分，不阻塞开新场）
    this.session = [];
    this.memory.clear();
    this.pendingAnswer = '';
    this.practice = { startedAt: Date.now(), mode: mode || 'free', questionCount: 0, archived: false };
    console.log(`[hub] 新练习开始 mode=${mode}`);
    this.broadcast({ type: 'memory', facts: [], turns: 0 }, 'console');
  }

  /** 本场练习快照（复盘数据源）。可传入固定引用，供换场存档时避免读到已清空的会话。 */
  sessionSnapshot(session = this.session, practice = this.practice) {
    const rounds = session.slice().reverse().map(x => ({
      id: x.id, time: x.time, question: x.question,
      type: x.type || '', headline: x.headline || '',
      points: x.points || [], experiences: x.experiences || [], pitfalls: x.pitfalls || [],
      sampleAnswer: x.sampleAnswer || '',
      englishOpener: x.englishOpener || '',
      usedMemory: !!x.usedMemory,
      answer: x.answer || '',
      rating: x.rating || '',
      eval: x.eval || null,
      evalStatus: x.evalStatus || (x.eval ? 'done' : ''),
      questionAt: x.questionAt || null,
      answeredAt: x.answeredAt || null,
      durationMs: x.durationMs != null ? x.durationMs : null,
      status: x.status
    }));
    const answered = rounds.filter(r => r.answeredAt);
    const totalMs = answered.reduce((s, r) => s + (r.durationMs || 0), 0);
    const stuck = rounds.filter(r => r.rating === 'stuck').length;
    const good = rounds.filter(r => r.rating === 'good').length;
    const evalScores = rounds.filter(r => r.eval && typeof r.eval.total === 'number').map(r => r.eval.total);
    const avgScore = evalScores.length ? Math.round(evalScores.reduce((a, b) => a + b, 0) / evalScores.length) : null;
    const typeDist = {};
    for (const r of rounds) if (r.type) typeDist[r.type] = (typeDist[r.type] || 0) + 1;
    return {
      rounds,
      stats: {
        total: rounds.length,
        answered: answered.length,
        totalMs,
        avgMs: answered.length ? Math.round(totalMs / answered.length) : 0,
        stuck, good,
        avgScore, scored: evalScores.length,
        rated: stuck + good,
        typeDist,
        startedAt: practice.startedAt,
        elapsedMs: Date.now() - practice.startedAt,
        mode: practice.mode
      }
    };
  }

  /** 把一次回答关联到"最近一题未回答"的回合，并记录耗时 */
  attachAnswer(text) {
    // 取最近一题未回答的回合（含 thinking 状态——用户可能手快，提示还没生成就先答了）
    const rec = this.session.find(x => !x.answeredAt);
    if (!rec) return null;
    rec.answer = text;
    rec.answeredAt = Date.now();
    rec.durationMs = rec.questionAt ? (rec.answeredAt - rec.questionAt) : null;
    this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'console');
    this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'practice');
    // 异步触发 AI 复盘评分（不阻塞主闭环、不写记忆）；promise 供换场存档时等待落定
    rec.evalPromise = this.evaluateAnswer(rec);
    return rec;
  }

  /** 异步对我的回答做 AI 评分，结果写回回合并广播。失败不影响主链路。 */
  async evaluateAnswer(rec, opts = {}) {
    if (!rec || !rec.answer || (rec.evalPending && !opts.force)) return;
    rec.evalPending = true;
    rec.evalStatus = 'pending';
    this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'console');
    this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'practice');
    const answerSnapshot = rec.answer;
    try {
      const ev = await llm.evaluate(rec.question, answerSnapshot, {
        points: rec.points || [], pitfalls: rec.pitfalls || []
      });
      // 回答可能被覆盖（极少见），只在仍是同一回答时写回
      if (rec.answer === answerSnapshot) {
        rec.eval = ev;
        rec.evalStatus = 'done';
      }
      console.log(`[hub] AI评分完成: ${rec.id} total=${ev.total}`);
    } catch (e) {
      rec.evalStatus = 'error';
      rec.evalError = e.message;
      console.log(`[hub] AI评分失败(${e.code || 'ERR'}): ${e.message}`);
    } finally {
      rec.evalPending = false;
      this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'console');
      this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'practice');
      // 单独事件，方便回答端/手机端展示轻量提示
      if (rec.evalStatus === 'done') {
        this.broadcast({ type: 'answer.eval', id: rec.id, total: rec.eval.total, verdict: rec.eval.verdict }, 'me');
        this.broadcast({ type: 'answer.eval', id: rec.id, total: rec.eval.total, verdict: rec.eval.verdict }, 'phone');
      }
    }
  }

  onMessage(ws, who, msg) {
    switch (msg.type) {
      case 'phone.mode':
        if (who.role === 'phone') this.phoneMode = msg.mode === 'practice' ? 'practice' : 'guided';
        break;
      case 'question': {
        const q = String(msg.text || '').trim();
        if (!q) return;
        console.log(`[hub] 收到提问(${who.role}): ${q.slice(0, 60)}`);
        this.broadcast({ type: 'transcript', text: q, from: who.role, id: who.id, time: Date.now(), test: !!msg.test }, 'console');
        this.broadcast({ type: 'listening', state: 'thinking', text: q }, 'phone');
        this.handleQuestion(q, who, !!msg.test).catch(e => {
          console.error('[hub] 处理提问失败:', e);
        });
        break;
      }
      case 'state':
        // 面试官端上报 listening / speaking / idle
        this.broadcast({ type: 'speaker', state: msg.state, from: who.role }, 'phone');
        this.broadcast({ type: 'speaker', state: msg.state, from: who.role }, 'console');
        break;
      case 'asr.start':
        // 我的回答端开始一段豆包流式识别
        this.startASR(ws, who);
        break;
      case 'asr.chunk':
        // base64 编码的 16k/16bit/mono PCM 分片
        this.feedASR(ws, msg.data);
        break;
      case 'asr.stop':
        // 结束音频流，等待最终结果
        this.stopASR(ws);
        break;
      case 'answer':
        // 直接提交文字版的“我的回答”（用于无麦克风/测试路径，走同一记忆闭环）
        this.recordAnswer(String(msg.text || '').trim(), who, msg.speakerId || '');
        break;
      case 'memory.clear':
        this.memory.clear();
        this.pendingAnswer = '';
        this.broadcast({ type: 'memory', facts: [], turns: 0 }, 'console');
        this.send(ws, { type: 'memory', facts: [], turns: 0, cleared: true });
        break;
      case 'memory.get':
        this.send(ws, { type: 'memory', ...this.memory.snapshot() });
        break;
      case 'session.get':
        // 复盘页/任意端拉取本场练习全量数据
        this.send(ws, { type: 'session', ...this.sessionSnapshot() });
        break;
      case 'session.start':
        // 开始一场新练习：清空回合、记忆、回答，重置计时
        this.startPractice(String(msg.mode || 'free'));
        this.broadcast({ type: 'session', ...this.sessionSnapshot(), started: true }, 'console');
        this.broadcast({ type: 'session', ...this.sessionSnapshot(), started: true }, 'practice');
        this.send(ws, { type: 'session', ...this.sessionSnapshot(), started: true });
        break;
      case 'session.end':
        // 结束本场练习：先存档，再广播最终态
        this.archiveCurrent().catch(() => {});
        this.broadcast({ type: 'session', ...this.sessionSnapshot(), ended: true }, 'console');
        this.broadcast({ type: 'session', ...this.sessionSnapshot(), ended: true }, 'practice');
        this.send(ws, { type: 'session', ...this.sessionSnapshot(), ended: true });
        break;
      case 'history.list':
        this.send(ws, { type: 'history.list', items: history.list(), progress: history.progress() });
        break;
      case 'history.get': {
        const rec = history.get(String(msg.id || ''));
        this.send(ws, { type: 'history.get', id: msg.id, record: rec });
        break;
      }
      case 'history.delete': {
        const ok = history.remove(String(msg.id || ''));
        this.broadcast({ type: 'history.changed' }, 'practice');
        this.send(ws, { type: 'history.deleted', id: msg.id, ok });
        break;
      }
      case 'history.clear': {
        const n = history.clear();
        this.broadcast({ type: 'history.changed' }, 'practice');
        this.send(ws, { type: 'history.cleared', count: n });
        break;
      }
      case 'history.progress':
        this.send(ws, { type: 'history.progress', items: history.progress() });
        break;
      case 'session.reevaluate': {
        // 复盘页手动重试评分：LLM 偶发失败时不用重练整题
        const rec = this.session.find(x => x.id === msg.id);
        if (!rec || !rec.answer) {
          this.send(ws, { type: 'session.reevaluated', id: msg.id, ok: false });
          break;
        }
        if (rec.evalPending && rec.evalPromise) {
          this.send(ws, { type: 'session.reevaluated', id: rec.id, ok: true, pending: true });
          break;
        }
        rec.evalStatus = 'pending';
        rec.evalError = '';
        rec.evalPromise = this.evaluateAnswer(rec, { force: true });
        this.send(ws, { type: 'session.reevaluated', id: rec.id, ok: true });
        this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'practice');
        this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'console');
        break;
      }
      case 'rate': {
        let rec = this.session.find(x => x.id === msg.id);
        // id 失配时只补给「最近一条已回答但未自评」的题，避免把自评贴到未答/旧题上
        if (!rec) rec = this.session.find(x => x.answeredAt && !x.rating) || this.session.find(x => x.answeredAt);
        if (rec) rec.rating = msg.rating;
        this.broadcast({ type: 'rated', id: rec ? rec.id : msg.id, rating: msg.rating }, 'console');
        this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'console');
        this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'practice');
        break;
      }
      case 'session.retry': {
        // 错题重练：筛出卡壳 / 低分 / 未评分的已回答题，组成重练队列推给提问端
        const pool = this.session.filter(x => x.answeredAt && x.question);
        let picked = pool.filter(x => x.rating === 'stuck' || (x.eval && typeof x.eval.total === 'number' && x.eval.total < 60));
        if (!picked.length) picked = pool; // 没有明确弱题，就重练本场所有答过的题
        // session 是新式在前（unshift），反转成出题顺序
        const queue = picked.slice().reverse().map(x => ({
          question: x.question,
          reference: (x.points || []).join('；'),
          type: x.type || '',
          why: x.rating === 'stuck' ? '卡壳' : (x.eval && x.eval.total < 60 ? '低分' : '复练')
        }));
        console.log(`[hub] 错题重练：从 ${pool.length} 题中抽出 ${queue.length} 题`);
        this.send(ws, { type: 'retry.result', count: queue.length, queue });
        this.broadcast({ type: 'retry.queue', queue, at: Date.now() }, 'interviewer');
        this.broadcast({ type: 'retry.queue', queue, at: Date.now() }, 'console');
        break;
      }
      case 'configChanged':
        this.broadcast({ type: 'llmStatus', llm: llm.status() });
        break;
      case 'ping':
        this.send(ws, { type: 'pong', time: Date.now() });
        break;
      default:
        break;
    }
  }

  async handleQuestion(question, who, isTest) {
    if (!isTest) this.practice.questionCount++;
    const rec = {
      id: Date.now().toString(36) + '-' + this.practice.questionCount,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      question, type: '', headline: '', rating: '', status: 'thinking',
      questionAt: isTest ? null : Date.now(), answeredAt: null, answer: '', durationMs: null,
      index: this.practice.questionCount
    };
    // 配置台「测试真实连接」只是一次 LLM 探测，不能混入本场练习统计/复盘/历史
    if (!isTest) {
      this.session.unshift(rec);
      this.broadcast({ type: 'history', items: this.session.slice(0, 50) }, 'console');
    }

    try {
      // 结构化简历：按本轮问题 + JD 选相关经历，替代全量硬塞
      const c = config.get();
      const cards = structureResume(c.resume);
      const resumeContext = cards.length ? selectRelevant(cards, question, c.jd, 3) : c.resume;
      // 注入上一轮我的回答 + 滚动记忆
      const memoryText = this.memory.toPrompt();
      // usedMemory 反映“这次生成前是否真的带了上下文”，用生成前的快照判断，不能用生成后的（delta 会污染）
      const hadContext = !!memoryText || !!this.pendingAnswer;
      const hint = await llm.generate(question, {
        resumeContext,
        memory: memoryText,
        lastAnswer: this.pendingAnswer,
        fullAnswer: this.phoneMode !== 'practice'
      });
      // 一次 LLM 调用同时产出提示和记忆增量 —— 不额外加网络往返
      if (hint.memoryDelta) {
        const added = this.memory.applyDelta(hint.memoryDelta);
        if (added > 0) this.broadcast({ type: 'memory', ...this.memory.snapshot() }, 'console');
      }
      // 本轮回答已被消化，清空 pending
      this.pendingAnswer = '';
      rec.type = hint.hintType;
      rec.headline = hint.headline;
      rec.points = hint.points;
      rec.experiences = hint.experiences;
      rec.pitfalls = hint.pitfalls;
      rec.sampleAnswer = hint.sampleAnswer;
      rec.englishOpener = hint.englishOpener;
      rec.usedMemory = !!hadContext;
      rec.status = 'ok';
      if (!isTest) {
        this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'console');
        this.broadcast({ type: 'session', ...this.sessionSnapshot() }, 'practice');
      }
      // 注意：hint 对象用 hintType 携带题型，避免覆盖消息字段 type='hint'
      const payload = { type: 'hint', question, ...hint, usedMemory: !!hadContext, id: rec.id, time: Date.now(), test: !!isTest };
      // 测试请求只回给发起的 console，不打扰手机端；正式请求推给 phone + interviewer + console
      if (isTest) {
        this.broadcast(payload, 'console');
      } else {
        this.broadcast(payload, 'phone');
        this.broadcast(payload, 'interviewer'); // 回传提问端，让其结束"处理中"状态并记录
        this.broadcast(payload, 'console');
      }
      console.log(`[hub] 提示已推送：${hint.hintType} · ${hint.latencyMs}ms · ${hint.source}`);
    } catch (e) {
      rec.status = 'error';
      rec.headline = e.message;
      const payload = {
        type: 'error', question, code: e.code || 'ERROR', message: e.message,
        detail: typeof e.detail === 'string' ? e.detail : undefined, time: Date.now(), test: !!isTest
      };
      if (isTest) {
        this.broadcast(payload, 'console');
      } else {
        this.broadcast(payload, 'phone');
        this.broadcast(payload, 'interviewer');
        this.broadcast(payload, 'console');
      }
      console.log(`[hub] 生成失败：${e.code} ${e.message}`);
    }
    if (!isTest) this.broadcast({ type: 'history', items: this.session.slice(0, 50) }, 'console');
  }

  /** 为某个连接启动豆包 ASR 会话 */
  startASR(ws, who) {
    const c = config.get();
    const a = c.asr || {};
    // 自测时可用 ASR_TEST_KEY 提供假 key，仅为通过凭证检查；真实调用仍连官方端点
    const apiKey = a.apiKey || process.env.ASR_TEST_KEY || '';
    if (!apiKey && !(a.appKey && a.accessKey)) {
      this.send(ws, { type: 'asr.error', message: '豆包 ASR 未配置：请在配置台填写 API Key（火山引擎控制台 > API Key 管理）。' });
      return;
    }
    // 已有会话先关掉
    const old = this.asrSessions.get(ws);
    if (old) old.close();
    const asr = new DoubaoASR({
      apiKey,
      appKey: a.appKey || '',
      accessKey: a.accessKey || '',
      resourceId: a.resourceId || 'volc.seedasr.sauc.duration',
      uid: 'ia-' + who.id,
      enableSpeaker: true
    }, {
      onPartial: (text, definite) => {
        this.send(ws, { type: 'asr.partial', text, definite });
        this.broadcast({ type: 'asr.partial', text, definite, from: who.role }, 'console');
      },
      onFinal: (text, utterances) => {
        // 说话人分离：按 speaker_id 分组，判断是不是“我”
        const bySpeaker = {};
        for (const u of utterances) {
          const sid = (u.additions && u.additions.speaker_id) || u.speaker_id || '0';
          bySpeaker[sid] = (bySpeaker[sid] || '') + (u.text || '');
        }
        const speakerIds = Object.keys(bySpeaker);
        // 默认单一说话人即“我”（回答端麦克风）；如豆包分出多人，取字数最多的一路为“我”
        let myText = text;
        if (who.role !== 'interviewer' && speakerIds.length > 1) {
          myText = speakerIds.map(s => bySpeaker[s]).sort((a, b) => b.length - a.length)[0];
        }
        console.log(`[hub] ${who.role === 'interviewer' ? '会议提问' : '我的回答'} ASR 最终: ${myText.slice(0, 60)} (speakers=${speakerIds.join(',')})`);
        this.send(ws, { type: 'asr.final', text: myText, speakers: bySpeaker });
        this.broadcast({ type: 'asr.final', text: myText, speakers: bySpeaker, from: who.role }, 'console');
        if (who.role === 'interviewer') {
          const question = String(myText || '').trim();
          if (question.length < 4 && !/[?？]/.test(question)) return;
          this.broadcast({ type: 'transcript', text: question, from: 'meeting-audio', time: Date.now() }, 'console');
          this.handleQuestion(question, who, false).catch(e => console.error('[hub] 会议提问处理失败:', e));
        } else {
          this.recordAnswer(myText, who, speakerIds.join(','));
        }
      },
      onError: (e) => {
        console.error('[hub] 豆包 ASR 错误:', e.message);
        this.send(ws, { type: 'asr.error', message: e.message });
        this.broadcast({ type: 'asr.error', message: e.message, from: who.role }, 'console');
      },
      onClose: () => { this.asrSessions.delete(ws); }
    });
    this.asrSessions.set(ws, asr);
    asr.start().then(() => {
      this.send(ws, { type: 'asr.started' });
    }).catch(e => {
      this.send(ws, { type: 'asr.error', message: e.message });
      this.asrSessions.delete(ws);
    });
  }

  feedASR(ws, data) {
    const asr = this.asrSessions.get(ws);
    if (!asr || !data) return;
    try {
      const pcm = Buffer.from(data, 'base64');
      asr.pushAudio(pcm);
    } catch (e) {
      console.error('[hub] ASR 音频推送失败:', e.message);
    }
  }

  stopASR(ws) {
    const asr = this.asrSessions.get(ws);
    if (!asr) return;
    asr.finish();
  }

  /** 记录“我的回答”，等下一轮提问时喂给 LLM 提炼 */
  recordAnswer(text, who, speakerId) {
    if (!text) return;
    this.pendingAnswer = text;
    const linked = this.attachAnswer(text); // 关联到当前题并计时
    this.broadcast({ type: 'answer', text, from: who.role, speakerId, time: Date.now(),
      linkedId: linked ? linked.id : null }, 'console');
    // 回答端自己要收到确认（否则用户不知道是否提交成功）；手机屏也显示轻量提示
    this.broadcast({ type: 'answerEcho', text }, 'me');
    this.broadcast({ type: 'answerEcho', text }, 'phone');
    // 通知手机端停止计时
    this.broadcast({ type: 'answerTimerStop', linkedId: linked ? linked.id : null }, 'phone');
    console.log(`[hub] 记录我的回答(${text.length}字)${linked ? '，耗时 '+linked.durationMs+'ms' : ''}，待下一题提炼`);
  }

  send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  broadcast(obj, onlyRole) {
    const text = JSON.stringify(obj);
    for (const [ws, c] of this.clients) {
      if (onlyRole && c.role !== onlyRole) continue;
      if (ws.readyState === 1) ws.send(text);
    }
  }
}

module.exports = Hub;
