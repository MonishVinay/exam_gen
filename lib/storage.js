const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const rollKey = value => String(value || '').trim().toLowerCase();
const answeredCount = answers => Object.values(answers || {}).filter(a => typeof a === 'string' && a.trim()).length;
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(id) && id !== 'active-session';
function atomicWrite(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
// Recovery retains nonblank archived answers; live draft saves can deliberately clear an answer.
function mergeStudent(previous = {}, incoming = {}) {
  const answers = { ...(previous.answers || {}) };
  for (const [q, answer] of Object.entries(incoming.answers || {})) {
    if (typeof answer === 'string' && (answer.trim() || !answers[q])) answers[q] = answer;
  }
  const violations = new Map();
  for (const v of [...(previous.violations || []), ...(incoming.violations || [])]) {
    if (v) violations.set(v.id || `${v.time}|${v.type}|${v.details}`, v);
  }
  return {
    ...previous, ...incoming, answers, answeredCount: answeredCount(answers), violations: [...violations.values()],
    status: previous.status === 'submitted' || incoming.status === 'submitted' ? 'submitted' : incoming.status || previous.status,
    submittedAt: incoming.submittedAt || previous.submittedAt || null,
    outDurationSeconds: Math.max(previous.outDurationSeconds || 0, incoming.outDurationSeconds || 0)
  };
}
function mergeHistory(lists) {
  const records = new Map();
  for (const list of lists) for (const entry of list) {
    if (!entry || !safeId(entry.id) || !Array.isArray(entry.students)) continue;
    const old = records.get(entry.id), students = new Map();
    for (const s of [...(old?.students || []), ...entry.students]) {
      const key = rollKey(s.rollNo);
      if (key) students.set(key, mergeStudent(students.get(key), s));
    }
    const merged = { ...old, ...entry, students: [...students.values()] };
    merged.totalStudents = merged.students.length;
    merged.submittedCount = merged.students.filter(s => s.status === 'submitted').length;
    records.set(entry.id, merged);
  }
  return [...records.values()].sort((a, b) => new Date(b.concludedAt || b.endedAt || 0) - new Date(a.concludedAt || a.endedAt || 0));
}
function createStorage(directory) {
  const sessions = path.join(directory, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const primary = path.join(directory, 'exam-history.json'), backup = path.join(directory, 'exam-history-backup.json');
  const active = path.join(sessions, 'active-session.json');
  function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.error(`[storage] ${path.basename(file)}: ${error.message}`); return fallback; }
  }
  let history = mergeHistory([
    ...fs.readdirSync(sessions).filter(f => f.endsWith('.json') && f !== 'active-session.json').map(f => [read(path.join(sessions, f), null)]),
    read(backup, []), read(primary, [])
  ].map(list => Array.isArray(list) ? list : []));
  function saveHistory(list) {
    atomicWrite(primary, list); history = list;
    atomicWrite(backup, list);
    for (const entry of list) {
      if (!safeId(entry.id)) throw new Error('Invalid session identifier');
      atomicWrite(path.join(sessions, `${entry.id}.json`), entry);
    }
    return history;
  }
  return {
    history: () => history, saveHistory,
    restore: list => saveHistory(mergeHistory([list, history])),
    readActive: () => read(active, null), saveActive: value => atomicWrite(active, value),
    delete: id => {
      if (!safeId(id)) throw new Error('Invalid session identifier');
      const list = history.filter(e => e.id !== id), file = path.join(sessions, `${id}.json`);
      saveHistory(list);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return list;
    }
  };
}
module.exports = { createStorage, atomicWrite, mergeStudent, mergeHistory, rollKey, answeredCount, safeId };
