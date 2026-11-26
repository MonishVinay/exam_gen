const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const vm = require('node:vm');

// Terminal-only DOM verification: no real browser, desktop input or mouse control.
function page(t, name, initialize = () => {}) {
  const html = fs.readFileSync(path.join(__dirname, `../public/${name}.html`), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, handlers = new Map(), sent = [];
  const socket = {
    connected: true,
    on(name, handler) { handlers.set(name, handler); },
    timeout() { return socket; },
    emit(name, data, callback) { sent.push({ name, data }); if (callback) callback(null, { success: true }); },
    disconnect() {}
  };
  w.io = () => socket;
  w.alert = () => {};
  w.confirm = () => true;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  initialize(w, handlers, socket);
  const context = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(path.join(__dirname, `../public/js/${name}.js`), 'utf8'), context);
  t.after(() => w.close());
  return { w, handlers, socket, sent, eval: code => vm.runInContext(code, context) };
}
const exam = { sessionId: 'exam-dom', title: 'Algorithms', examCode: 'TEST', status: 'active', totalQuestions: 3, endTime: Date.now() + 3600000 };
const candidate = { name: "Alex O'Neil", rollNo: 'R1', resumeToken: 'test-token', status: 'in_test', answers: { 1: 'old server answer' }, violations: [], outDurationSeconds: 7 };

test('candidate restores newer local drafts per session and treats answer text as text', t => {
  const p = page(t, 'student');
  p.w.localStorage.setItem('PROCTOR_DRAFT_exam-dom_r1', JSON.stringify({ 1: '</textarea><img src=x onerror=alert(1)>', 2: 'local answer' }));
  p.eval(`currentExamState = ${JSON.stringify(exam)}; currentStudent = ${JSON.stringify(candidate)}; buildAnswerInterface(3);`);
  assert.equal(p.w.document.getElementById('answer-q-1').value, '</textarea><img src=x onerror=alert(1)>');
  assert.equal(p.w.document.querySelectorAll('#answers-inputs-container img').length, 0);
  assert.equal(p.w.document.getElementById('answer-q-2').value, 'local answer');
  assert.equal(p.w.document.getElementById('answered-progress-badge').textContent, '2 / 3 Answered');
  p.eval(`currentExamState = { ...currentExamState, sessionId: 'exam-next' }; currentStudent.answers = {}; studentAnswers = {}; buildAnswerInterface(3);`);
  assert.equal(p.w.document.getElementById('answer-q-1').value, '');
});

test('candidate submission success waits for acknowledgement and reconnect syncs unsent drafts', t => {
  const p = page(t, 'student');
  p.eval(`currentExamState = ${JSON.stringify(exam)}; currentStudent = ${JSON.stringify(candidate)}; initStudentSocket('Alex', 'R1', 'TEST'); studentAnswers = {1: 'newer local answer'}; isExamActive = true;`);
  let confirm;
  p.socket.emit = (name, data, callback) => {
    p.sent.push({ name, data });
    if (name === 'student:submit_exam') confirm = callback;
  };
  p.eval('finalizeExamSubmission()');
  assert.equal(p.w.document.getElementById('submitted-screen').classList.contains('hidden'), true);
  assert.equal(p.w.document.getElementById('student-submit-btn').disabled, true);
  confirm(null, { success: true, student: { ...candidate, status: 'submitted', answers: { 1: 'newer local answer' } } });
  assert.equal(p.w.document.getElementById('submitted-screen').classList.contains('hidden'), false);
  assert.equal(p.w.document.getElementById('final-away-duration').textContent, '00:07');
  p.eval('isExamActive = true;');
  p.handlers.get('student:joined_success')({ student: candidate, examState: exam, serverTime: Date.now() });
  assert.equal(p.sent.some(e => e.name === 'student:save_answer' && e.data.answer === 'newer local answer'), true);
});

test('candidate installs sensors once and flags developer tools / observable screenshot shortcuts', t => {
  const p = page(t, 'student');
  p.eval('isExamActive = true; setupProctoringSensors(); setupProctoringSensors();');
  p.w.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'F12', bubbles: true, cancelable: true }));
  assert.equal(p.eval('violationsCount'), 1);
  p.w.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: '3', metaKey: true, shiftKey: true, cancelable: true }));
  assert.equal(p.eval('violationsCount'), 2);
});

test('teacher first socket sync cannot erase a browser backup before HTTP recovery', async t => {
  const cached = [{ id: 'exam-cached', title: 'Recovered', totalQuestions: 3, students: [] }];
  let restores = 0;
  const p = page(t, 'teacher', w => {
    w.localStorage.setItem('PROCTOR_PERMANENT_EXAM_HISTORY', JSON.stringify(cached));
    w.fetch = async (url, options) => {
      if (url.endsWith('restore-backup')) { restores++; return { ok: true, json: async () => ({ history: cached }) }; }
      if (url.endsWith('auth-status')) return { ok: true, json: async () => ({ authenticated: false }) };
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ history: [] }) };
    };
  });
  p.eval('initSocket()');
  p.handlers.get('teacher:history_updated')([]);
  assert.deepEqual(JSON.parse(p.w.localStorage.getItem('PROCTOR_PERMANENT_EXAM_HISTORY')), cached);
  await p.eval('fetchExamHistory()');
  assert.equal(restores, 1);
  assert.equal(p.eval('examHistoryList[0].id'), 'exam-cached');
});

test('teacher answer review uses memory and roster text cannot create injected handlers', t => {
  const p = page(t, 'teacher', w => { w.fetch = async () => ({ json: async () => ({ authenticated: false }) }); });
  const malicious = { ...candidate, connected: true, socketId: 'socket-one', name: '<img src=x onerror=alert(1)>', rollNo: "R'001", answeredCount: 1 };
  p.eval(`currentExamState = ${JSON.stringify(exam)}; studentsList = [${JSON.stringify(malicious)}]; renderStudentsRoster();`);
  assert.equal(p.w.document.querySelectorAll('#student-roster-body img').length, 0);
  let calls = 0;
  p.w.fetch = () => { calls++; throw new Error('Answer review must not fetch'); };
  p.eval("viewStudentAnswers('socket-one', 'R1')");
  assert.equal(calls, 0);
  assert.equal(p.w.document.getElementById('answers-modal').classList.contains('hidden'), false);
  assert.equal(p.w.document.getElementById('answers-modal-student-name').textContent, "<img src=x onerror=alert(1)>'s Answer Sheet");
});

test('teacher schedule uses an absolute timezone-aware timestamp and displays its fixed window', async t => {
  let savedStart;
  const p = page(t, 'teacher', w => {
    w.fetch = async (url, options) => {
      if (url === '/api/teacher/exam') {
        savedStart = options.body.get('scheduledStartTime');
        return { json: async () => ({ success: true, examState: { ...exam, status: 'scheduled', durationMinutes: 60, scheduledStartTime: Date.parse(savedStart) } }) };
      }
      return { json: async () => ({ authenticated: false }) };
    };
  });
  const localDate = '2030-01-15T10:00';
  p.w.document.getElementById('exam-scheduled-start-input').value = localDate;
  p.w.document.getElementById('exam-config-form').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(savedStart, new p.w.Date(localDate).toISOString());
  assert.equal(p.w.document.getElementById('exam-status-badge').textContent, 'Scheduled');
  assert.equal(p.w.document.getElementById('start-exam-btn').textContent, 'Start Now Instead');
  assert.match(p.w.document.getElementById('exam-schedule-help').textContent, /end time stays fixed/);
});

test('scheduled candidates see the start/end window while waiting and unjoined sockets cannot launch an exam', t => {
  const p = page(t, 'student');
  p.eval(`initStudentSocket('Alex', 'R1', 'TEST');`);
  p.handlers.get('exam:started')(exam);
  assert.equal(p.w.document.getElementById('permission-screen').classList.contains('hidden'), true);
  p.eval(`currentExamState = ${JSON.stringify({ ...exam, status: 'scheduled', durationMinutes: 60, scheduledStartTime: Date.parse('2030-01-15T10:00:00Z') })}; currentStudent = ${JSON.stringify(candidate)}; showWaitingScreen();`);
  assert.equal(p.w.document.getElementById('waiting-heading').textContent, 'Waiting for Scheduled Start');
  assert.match(p.w.document.getElementById('waiting-start-details').textContent, /Starts .*Ends /);
});
