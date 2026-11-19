'use strict';
/**
 * 练习历史持久化：把每场练习快照落盘到 data/history/，支持跨场「进步对比」。
 * - 一场一个 JSON 文件（s_时间戳_随机.json），避免并发覆盖。
 * - 损坏文件自动跳过，不让单个坏文件拖垮整个历史。
 * - 进步对比以「题目文本」为稳定 key，聚合同一题在所有场次里的评分序列。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'history');
const MAX = 100;            // 最多保留场次
const MAX_PER_Q = 30;       // 单题最多保留的评分点

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }

/** 稳定题目 key：去空白、归一化后取 hash，避免长文本当文件名 */
function qKey(question) {
  return crypto.createHash('sha1').update(String(question || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

function cleanQuestion(q) { return String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200); }

/** 保存一场练习快照。返回 {id, ok} 或抛错 */
function save(snapshot) {
  ensureDir();
  const rounds = (snapshot.rounds || []).filter(r => r.question);
  const id = 's_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const endedAt = Date.now();
  const rec = {
    id, endedAt,
    startedAt: snapshot.stats && snapshot.stats.startedAt ? snapshot.stats.startedAt : endedAt,
    mode: (snapshot.stats && snapshot.stats.mode) || 'free',
    stats: {
      total: (snapshot.stats && snapshot.stats.total) || 0,
      answered: (snapshot.stats && snapshot.stats.answered) || 0,
      avgMs: (snapshot.stats && snapshot.stats.avgMs) || 0,
      stuck: (snapshot.stats && snapshot.stats.stuck) || 0,
      good: (snapshot.stats && snapshot.stats.good) || 0,
      avgScore: snapshot.stats ? snapshot.stats.avgScore : null,
      scored: (snapshot.stats && snapshot.stats.scored) || 0,
      elapsedMs: (snapshot.stats && snapshot.stats.elapsedMs) || 0,
      // 顶层 mode 用于列表；stats.mode 供复盘页读取，避免历史场次一律显示「自由提问」
      mode: (snapshot.stats && snapshot.stats.mode) || 'free'
    },
    // 只留复盘需要的精简字段，避免存整个对象
    rounds: rounds.map(r => ({
      question: cleanQuestion(r.question),
      qkey: qKey(r.question),
      type: r.type || '',
      answer: r.answer || '',
      rating: r.rating || '',
      durationMs: r.durationMs != null ? r.durationMs : null,
      total: r.eval && typeof r.eval.total === 'number' ? r.eval.total : null,
      verdict: r.eval && r.eval.verdict ? r.eval.verdict : ''
    }))
  };
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(rec, null, 2), 'utf8');
  prune();
  return { id, ok: true };
}

function readAll() {
  ensureDir();
  const out = [];
  let names = [];
  try { names = fs.readdirSync(DIR).filter(n => /^s_.*\.json$/.test(n)); } catch (e) { return out; }
  for (const n of names) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
      if (d && d.id && Array.isArray(d.rounds)) out.push(d);
    } catch (e) {
      // 损坏文件跳过，不删除（保守）
    }
  }
  out.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)); // 最新在前
  return out;
}

function prune() {
  const all = readAll();
  if (all.length <= MAX) return;
  for (const d of all.slice(MAX)) {
    try { fs.unlinkSync(path.join(DIR, d.id + '.json')); } catch (e) {}
  }
}

/** 历史场次摘要列表（不含逐题回答，减小传输） */
function list() {
  return readAll().map(d => ({
    id: d.id, endedAt: d.endedAt, startedAt: d.startedAt, mode: d.mode,
    stats: d.stats, rounds: (d.rounds || []).map(r => ({
      question: r.question, qkey: r.qkey, type: r.type, rating: r.rating,
      total: r.total, durationMs: r.durationMs
    }))
  }));
}

function get(id) {
  const safe = /^s_[a-zA-Z0-9_]+$/.test(String(id || '')) ? id : null;
  if (!safe) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DIR, safe + '.json'), 'utf8')); }
  catch (e) { return null; }
}

function remove(id) {
  const safe = /^s_[a-zA-Z0-9_]+$/.test(id) ? id : null;
  if (!safe) return false;
  try { fs.unlinkSync(path.join(DIR, safe + '.json')); return true; }
  catch (e) { return false; }
}

function clear() {
  ensureDir();
  let n = 0;
  for (const name of fs.readdirSync(DIR).filter(x => /^s_.*\.json$/.test(x))) {
    try { fs.unlinkSync(path.join(DIR, name)); n++; } catch (e) {}
  }
  return n;
}

/**
 * 进步对比：按题目聚合所有历史评分，返回同一题多次练习的分数序列。
 * 只返回出现过 >=2 次评分 或 >=2 次作答 的题目，才有对比意义。
 */
function progress() {
  const byQ = new Map();
  for (const d of readAll()) {
    for (const r of (d.rounds || [])) {
      if (!r.question) continue;
      const key = r.qkey || qKey(r.question);
      if (!byQ.has(key)) byQ.set(key, { qkey: key, question: r.question, type: r.type || '', points: [] });
      byQ.get(key).points.push({
        sessionId: d.id, endedAt: d.endedAt,
        total: typeof r.total === 'number' ? r.total : null,
        rating: r.rating || '', durationMs: r.durationMs
      });
    }
  }
  const out = [];
  for (const item of byQ.values()) {
    item.points.sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0)); // 时间正序，看进步
    const scored = item.points.filter(p => typeof p.total === 'number');
    if (item.points.length < 2 && scored.length < 1) continue;
    const scores = scored.map(p => p.total);
    item.best = scores.length ? Math.max(...scores) : null;
    item.last = scores.length ? scores[scores.length - 1] : null;
    item.first = scores.length ? scores[0] : null;
    item.delta = (item.first != null && item.last != null && scores.length > 1) ? item.last - item.first : null;
    item.times = item.points.length;
    out.push(item);
  }
  // 有分数数据的排前面，再按练习次数 desc
  out.sort((a, b) => (b.points.filter(p => p.total != null).length - a.points.filter(p => p.total != null).length) || (b.times - a.times));
  return out.slice(0, 50);
}

module.exports = { save, list, get, remove, clear, progress, qKey, DIR };
