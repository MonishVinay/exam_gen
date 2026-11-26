const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createApp } = require('../server');
const { createStorage, atomicWrite } = require('../lib/storage');

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`Timed out: ${name}`)); }, 5000);
    function handler(value) { clearTimeout(timer); resolve(value); }
    socket.once(name, handler);
  });
}
function ack(socket, name, value) {
  return new Promise((resolve, reject) => socket.timeout(5000).emit(name, value, (error, data) => error ? reject(error) : resolve(data)));
}
async function harness(t, root, options = {}) {
  root ||= fs.mkdtempSync(path.join(os.tmpdir(), 'proctorlock-test-'));
  const dataDir = path.join(root, 'data'), uploadsDir = path.join(root, 'uploads');
  const instance = createApp({ dataDir, uploadsDir, password: 'test-secret', ...options });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const sockets = [];
  let cookie;
  async function request(url, options = {}) {
    const headers = { ...(cookie ? { Cookie: cookie } : {}), ...options.headers };
    if (options.json) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.json); }
    const res = await fetch(base + url, { ...options, headers });
    return res;
  }
  async function login() {
    const res = await request('/api/teacher/login', { method: 'POST', json: { password: 'test-secret' } });
    assert.equal(res.status, 200); cookie = res.headers.get('set-cookie').split(';')[0];
  }
  async function connect(teacher = false) {
    const socket = io(base, { transports: ['websocket'], reconnection: false, extraHeaders: teacher ? { Cookie: cookie } : {} });
    sockets.push(socket); await event(socket, 'connect'); return socket;
  }
  async function configure(extra = {}) {
    const form = new FormData();
    for (const [key, val] of Object.entries({ title: 'Algorithms', subject: 'CS101', durationMinutes: '60', totalQuestions: '3', examCode: 'TEST', ...extra })) form.set(key, val);
    form.set('examPdf', new Blob([fs.readFileSync(path.join(__dirname, '../uploads/sample-exam.pdf'))], { type: 'application/pdf' }), 'paper.pdf');
    const res = await request('/api/teacher/exam', { method: 'POST', body: form });
    return { res, data: await res.json() };
  }
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true; sockets.forEach(s => s.disconnect()); await instance.close();
  }
  t.after(close);
  return { ...instance, root, dataDir, uploadsDir, base, request, login, connect, configure, close };
}
async function join(h, data = {}) {
  const socket = await h.connect();
  const joined = event(socket, 'student:joined_success');
  socket.emit('student:join', { name: "O'Neil <candidate>", rollNo: 'R001', examCode: 'test', ...data });
  return { socket, payload: await joined };
}
async function active(t) {
  const h = await harness(t); await h.login();
  assert.equal((await h.configure()).res.status, 200);
  const res = await h.request('/api/teacher/exam/start', { method: 'POST' });
  assert.equal(res.status, 200); return h;
}

test('teacher REST and socket data require authentication; logout revokes live access', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/api/teacher/history')).status, 401);
  const anonymous = await h.connect();
  let leaked = false;
  anonymous.on('teacher:students_update', () => { leaked = true; });
  let denied = event(anonymous, 'teacher:auth_error'); anonymous.emit('teacher:join'); await denied;
  denied = event(anonymous, 'teacher:auth_error'); anonymous.emit('teacher:clear_inactive'); await denied;
  assert.equal(leaked, false);
  await h.login(); const examiner = await h.connect(true);
  const history = event(examiner, 'teacher:history_updated'); examiner.emit('teacher:join'); assert.deepEqual(await history, []);
  const disconnected = event(examiner, 'disconnect');
  await h.request('/api/teacher/logout', { method: 'POST' }); await disconnected;
  assert.equal((await h.request('/api/teacher/history')).status, 401);
});

test('configuration limits, PDF validation, lifecycle and JSON API errors', async t => {
  const h = await harness(t); await h.login();
  assert.equal((await h.configure({ totalQuestions: '201' })).res.status, 400);
  assert.equal((await h.configure({ durationMinutes: '3001' })).res.status, 400);
  assert.equal((await h.configure({ totalQuestions: '200', durationMinutes: '3000' })).res.status, 200);
  const invalid = new FormData();
  for (const [k, v] of Object.entries({ title: 'Invalid', subject: 'CS', totalQuestions: '2', durationMinutes: '1', examCode: 'TEST' })) invalid.set(k, v);
  invalid.set('examPdf', new Blob(['<script>bad</script>'], { type: 'application/pdf' }), 'bad.pdf');
  assert.equal((await h.request('/api/teacher/exam', { method: 'POST', body: invalid })).status, 400);
  assert.equal((await h.request('/api/teacher/exam/start', { method: 'POST' })).status, 200);
  assert.equal((await h.request('/api/teacher/exam/start', { method: 'POST' })).status, 409);
  assert.equal((await h.configure()).res.status, 409);
  const missing = await h.request('/api/not-present'); assert.equal(missing.status, 404); assert.equal((await missing.json()).success, false);
  const anonymous = await h.connect(), error = event(anonymous, 'student:join_error');
  anonymous.emit('student:join', { name: 'Bad', rollNo: 'R2' }); await error;
});

test('waiting-room candidates can answer after start; question paper needs a candidate token', async t => {
  const h = await harness(t); await h.login();
  const { data } = await h.configure();
  const { socket, payload } = await join(h);
  assert.equal(payload.student.status, 'waiting');
  assert.equal((await ack(socket, 'student:save_answer', { questionNumber: 1, answer: 'early' })).success, false);
  const started = event(socket, 'exam:started'); await h.request('/api/teacher/exam/start', { method: 'POST' }); await started;
  const examiner = await h.connect(true), update = event(examiner, 'teacher:students_update');
  examiner.emit('teacher:join'); assert.equal((await update)[0].status, 'in_test');
  const paper = await fetch(h.base + data.examState.pdfUrl); assert.equal(paper.status, 403);
  assert.equal((await fetch(h.base + data.examState.pdfUrl + '?token=' + payload.student.resumeToken)).status, 200);
  assert.equal((await ack(socket, 'student:save_answer', { questionNumber: 1, answer: 'ready' })).success, true);
});

test('drafts survive reconnect and restart; duplicate identities require the resume token', async t => {
  const h = await active(t); const { socket, payload } = await join(h);
  assert.equal((await ack(socket, 'student:save_answer', { questionNumber: 1, answer: 'A multiline\nanswer' })).success, true);
  assert.equal((await ack(socket, 'student:save_answer', { questionNumber: 4, answer: 'out of bounds' })).success, false);
  assert.equal((await ack(socket, 'student:save_answer', { questionNumber: 2, answer: {} })).success, false);
  const impostor = await h.connect(), denied = event(impostor, 'student:join_error');
  impostor.emit('student:join', { name: 'Other', rollNo: ' r001 ', examCode: 'TEST' }); await denied;
  const activeFile = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'sessions/active-session.json')));
  assert.equal(activeFile.students.r001.answers[1], 'A multiline\nanswer');
  await h.close();
  const recovered = await harness(t, h.root);
  const rejoined = await join(recovered, { rollNo: ' r001 ', resumeToken: payload.student.resumeToken });
  assert.equal(rejoined.payload.student.answers[1], 'A multiline\nanswer');
  assert.equal(rejoined.payload.examState.status, 'active');
});

test('submission archives immediately, remains submitted after disconnect, and cannot be edited', async t => {
  const h = await active(t); const { socket, payload } = await join(h);
  const result = await ack(socket, 'student:submit_exam', { answers: { 1: '=SUM(A1:A2)', 2: '42' } });
  assert.equal(result.success, true); assert.equal(result.student.status, 'submitted');
  assert.equal((await ack(socket, 'student:save_answer', { questionNumber: 1, answer: 'changed' })).success, false);
  socket.disconnect();
  const rejoined = await join(h, { resumeToken: payload.student.resumeToken });
  assert.equal(rejoined.payload.student.status, 'submitted');
  const res = await h.request('/api/teacher/history/backup-json'); assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  const history = await res.json(); assert.equal(history[0].submittedCount, 1); assert.equal(history[0].students[0].answers[2], '42');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dataDir, 'sessions', history[0].id + '.json'))).students[0].status, 'submitted');
  const csv = await (await h.request(`/api/teacher/history/${history[0].id}/export-csv`)).text();
  assert.match(csv, /Q3 Answer/); assert.match(csv, /'=SUM/);
});

test('force submit and roster clearing archive server-side before reset, new exams isolate old candidates', async t => {
  const h = await active(t); const candidate = await join(h);
  await ack(candidate.socket, 'student:save_answer', { questionNumber: 1, answer: 'preserve me' });
  const forced = event(candidate.socket, 'student:force_submitted');
  assert.equal((await h.request('/api/teacher/student/force-submit', { method: 'POST', json: { studentSocketId: candidate.socket.id } })).status, 200);
  assert.equal((await forced).student.status, 'submitted');
  await h.request('/api/teacher/students/clear-inactive', { method: 'POST' });
  let history = await (await h.request('/api/teacher/history')).json();
  assert.equal(history.history[0].students[0].answers[1], 'preserve me');
  await h.request('/api/teacher/exam/end', { method: 'POST' });
  const previousId = history.history[0].id;
  await h.request('/api/teacher/exam/start', { method: 'POST' });
  const newCandidate = await join(h);
  assert.notEqual(newCandidate.payload.examState.sessionId, previousId);
  assert.deepEqual(newCandidate.payload.student.answers, {});
  assert.notEqual(newCandidate.payload.student.status, 'submitted');
});

test('expiry finalizes disconnected drafts on recovery; no examiner click is needed', async t => {
  const h = await active(t); const candidate = await join(h);
  await ack(candidate.socket, 'student:save_answer', { questionNumber: 1, answer: 'recover at expiry' });
  await h.close();
  const file = path.join(h.dataDir, 'sessions/active-session.json');
  const state = JSON.parse(fs.readFileSync(file)); state.examState.endTime = Date.now() - 1; atomicWrite(file, state);
  const restarted = await harness(t, h.root); await restarted.login();
  const history = (await (await restarted.request('/api/teacher/history')).json()).history;
  assert.equal(history[0].status, 'ended'); assert.equal(history[0].students[0].status, 'submitted');
  assert.equal(history[0].students[0].answers[1], 'recover at expiry');
});

test('backup restore is non-destructive, validates identifiers and accepts backups over 100KB', async t => {
  const h = await active(t); const candidate = await join(h);
  await ack(candidate.socket, 'student:submit_exam', { answers: { 1: 'original' } });
  const original = (await (await h.request('/api/teacher/history')).json()).history[0];
  const incoming = structuredClone(original); incoming.students[0].answers[1] = ''; incoming.students[0].answers[2] = 'restored';
  const res = await h.request('/api/teacher/history/restore-backup', { method: 'POST', json: { history: [incoming] } });
  const restored = (await res.json()).history[0];
  assert.equal(restored.students[0].answers[1], 'original'); assert.equal(restored.students[0].answers[2], 'restored');
  const bad = { ...incoming, id: '../escape' };
  assert.equal((await h.request('/api/teacher/history/restore-backup', { method: 'POST', json: { history: [bad] } })).status, 400);
  const large = { ...incoming, id: 'exam-large', students: Array.from({ length: 5 }, (_, i) => ({ ...incoming.students[0], rollNo: 'L' + i, answers: { 1: 'a'.repeat(30000) } })) };
  assert.equal((await h.request('/api/teacher/history/restore-backup', { method: 'POST', json: { history: [large] } })).status, 200);
});

test('atomic replicas recover corrupted master and deletion survives startup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proctorlock-store-'));
  const storage = createStorage(root);
  const record = { id: 'exam-one', totalQuestions: 1, students: [{ rollNo: ' R1 ', status: 'submitted', answers: { 1: 'kept' }, violations: [] }] };
  storage.saveHistory([record]);
  fs.writeFileSync(path.join(root, 'exam-history.json'), '{broken');
  assert.equal(createStorage(root).history()[0].students[0].answers[1], 'kept');
  storage.delete('exam-one'); assert.deepEqual(createStorage(root).history(), []);
  assert.equal(fs.readdirSync(root).some(f => f.endsWith('.tmp')), false);
});

function memoryScheduleStore() {
  const { encryptSchedule, decryptSchedule } = require('../lib/schedule-store');
  let encrypted = null;
  const secret = 'a-stable-test-encryption-key-for-scheduling';
  return {
    provider: 'github', fail: false,
    async load() { return encrypted ? decryptSchedule(encrypted, secret) : null; },
    async save(state, paper) {
      if (this.fail) throw new Error('Simulated storage outage');
      encrypted = encryptSchedule(state, paper, secret);
    }
  };
}

test('scheduled exam survives a completely empty Render disk and a student wakes it within the original window', async t => {
  const start = Date.parse('2030-01-15T10:00:00+05:30');
  const scheduleStore = memoryScheduleStore();
  const teacher = await harness(t, undefined, { now: () => start - 3600000, scheduleStore });
  await teacher.login();
  const configured = await teacher.configure({ scheduledStartTime: new Date(start).toISOString() });
  assert.equal(configured.res.status, 200); assert.equal(configured.data.examState.status, 'scheduled');
  const id = configured.data.examState.sessionId;
  await teacher.close();
  // New root means no history, active snapshot or uploaded PDF survived. No teacher logs in.
  const studentWake = await harness(t, undefined, { now: () => start + 20 * 60000, scheduleStore });
  assert.notEqual(studentWake.root, teacher.root);
  const state = (await (await studentWake.request('/api/exam/state')).json()).examState;
  assert.equal(state.sessionId, id); assert.equal(state.status, 'active');
  assert.equal(state.startTime, start); assert.equal(state.endTime, start + 3600000);
  const candidate = await join(studentWake);
  assert.equal(candidate.payload.student.status, 'in_test');
  assert.equal(candidate.payload.serverTime, start + 20 * 60000);
  const paper = await fetch(studentWake.base + state.pdfUrl + '?token=' + candidate.payload.student.resumeToken);
  assert.equal(paper.status, 200);
  assert.equal(Buffer.from(await paper.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('waking before a scheduled exam keeps candidates waiting; the first due request starts it exactly once', async t => {
  const start = Date.parse('2030-01-15T04:30:00Z');
  let now = start - 3600000;
  const scheduleStore = memoryScheduleStore();
  const h = await harness(t, undefined, { now: () => now, scheduleStore }); await h.login();
  assert.equal((await h.configure({ scheduledStartTime: new Date(start).toISOString() })).res.status, 200);
  const candidate = await join(h); assert.equal(candidate.payload.student.status, 'waiting');
  assert.equal((await ack(candidate.socket, 'student:save_answer', { questionNumber: 1, answer: 'too early' })).success, false);
  let starts = 0; candidate.socket.on('exam:started', () => { starts++; });
  const started = event(candidate.socket, 'exam:started'); now = start + 1234;
  const state = (await (await h.request('/api/exam/state')).json()).examState;
  assert.equal((await started).startTime, start); assert.equal(state.status, 'active');
  await h.request('/api/exam/state'); assert.equal(starts, 1);
  assert.equal((await ack(candidate.socket, 'student:save_answer', { questionNumber: 1, answer: 'now allowed' })).success, true);
});

test('first wake after the scheduled end closes the exam instead of granting a fresh duration', async t => {
  const start = Date.parse('2030-01-15T04:30:00Z'), scheduleStore = memoryScheduleStore();
  const teacher = await harness(t, undefined, { now: () => start - 3600000, scheduleStore }); await teacher.login();
  await teacher.configure({ scheduledStartTime: new Date(start).toISOString() }); await teacher.close();
  const lateWake = await harness(t, undefined, { now: () => start + 3600000, scheduleStore });
  const state = (await (await lateWake.request('/api/exam/state')).json()).examState;
  assert.equal(state.status, 'ended'); assert.equal(state.endTime, start + 3600000);
  const socket = await lateWake.connect(), denied = event(socket, 'student:join_error');
  socket.emit('student:join', { name: 'Late', rollNo: 'L1', examCode: 'TEST' });
  assert.match((await denied).message, /ended/);
});

test('schedule validation, authentication and missing cloud storage cannot silently create unsafe schedules', async t => {
  const h = await harness(t); await h.login();
  assert.equal((await h.configure({ scheduledStartTime: 'not-a-time' })).res.status, 400);
  assert.equal((await h.configure({ scheduledStartTime: '2020-01-01T10:00:00Z' })).res.status, 400);
  assert.equal((await h.configure({ scheduledStartTime: '2030-01-15T10:00' })).res.status, 400);
  const cloud = await harness(t, undefined, { requireDurableSchedules: true }); await cloud.login();
  const result = await cloud.configure({ scheduledStartTime: '2030-01-15T10:00:00Z' });
  assert.equal(result.res.status, 503); assert.match(result.data.error, /GitHub/);
  assert.equal((await cloud.request('/api/teacher/schedule-storage')).status, 200);
  assert.equal((await fetch(cloud.base + '/api/teacher/schedule-storage')).status, 401);
  assert.equal((await cloud.configure()).res.status, 200); // Manual exams remain available without extra storage.
});

test('failed durable save keeps the previous schedule and reports failure to the teacher', async t => {
  const start = Date.parse('2030-01-15T04:30:00Z'), scheduleStore = memoryScheduleStore();
  const h = await harness(t, undefined, { now: () => start - 3600000, scheduleStore }); await h.login();
  await h.configure({ scheduledStartTime: new Date(start).toISOString() });
  scheduleStore.fail = true;
  const changed = await h.configure({ title: 'Should not save', scheduledStartTime: new Date(start + 3600000).toISOString() });
  assert.equal(changed.res.status, 503);
  const state = (await (await h.request('/api/exam/state')).json()).examState;
  assert.equal(state.title, 'Algorithms'); assert.equal(state.scheduledStartTime, start);
  assert.equal(fs.readdirSync(h.uploadsDir).length, 1);
});

test('rescheduling and cancelling survive disk loss; early conclusion never reopens on the next wake', async t => {
  const start = Date.parse('2030-01-15T04:30:00Z'), scheduleStore = memoryScheduleStore();
  let now = start - 3600000;
  const h = await harness(t, undefined, { now: () => now, scheduleStore }); await h.login();
  await h.configure({ scheduledStartTime: new Date(start).toISOString() });
  await h.configure({ scheduledStartTime: '' }); await h.close();
  now = start + 600000;
  const wake = await harness(t, undefined, { now: () => now, scheduleStore });
  assert.equal((await (await wake.request('/api/exam/state')).json()).examState.status, 'created');
  await wake.login(); await wake.request('/api/teacher/exam/start', { method: 'POST' });
  await wake.request('/api/teacher/exam/end', { method: 'POST' }); await wake.close();
  const again = await harness(t, undefined, { now: () => now + 60000, scheduleStore });
  assert.equal((await (await again.request('/api/exam/state')).json()).examState.status, 'ended');
});

test('unavailable remote recovery fails closed rather than serving a blank or replaced exam', async t => {
  const h = await harness(t, undefined, { scheduleStore: { async load() { throw new Error('Network down'); } } });
  assert.equal((await h.request('/api/exam/state')).status, 503);
  assert.equal((await h.request('/api/health')).status, 503);
});
