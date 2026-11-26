const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { Server } = require('socket.io');
const session = require('express-session');
const multer = require('multer');
const { createStorage, mergeHistory, rollKey, answeredCount, safeId } = require('./lib/storage');
const { createGitHubScheduleStore } = require('./lib/schedule-store');

function createApp(options = {}) {
  const clock = options.now || Date.now;
  const app = express(), server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 2 * 1024 * 1024 });
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const uploadsDir = options.uploadsDir || process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const storage = createStorage(dataDir);
  const scheduleStore = options.scheduleStore || (process.env.EXAM_STORAGE_TOKEN ? createGitHubScheduleStore({
    token: process.env.EXAM_STORAGE_TOKEN, repo: process.env.EXAM_STORAGE_REPO || process.env.RENDER_GIT_REPO_SLUG,
    secret: process.env.EXAM_STORAGE_KEY || process.env.SESSION_SECRET,
    branch: process.env.EXAM_STORAGE_BRANCH || 'proctorlock-exams'
  }) : null);
  const requireDurableSchedules = options.requireDurableSchedules ?? process.env.RENDER === 'true';
  let initialized = false, savingExam = false;
  const password = options.password || process.env.TEACHER_PASSWORD || 'teacher123';
  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 86400000 }
  });
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(sessionMiddleware);
  io.engine.use(sessionMiddleware);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.get('host')) return res.status(403).json({ success: false, error: 'Origin not allowed' });
      } catch { return res.status(403).json({ success: false, error: 'Invalid origin' }); }
    }
    next();
  });
  app.use(express.static(path.join(__dirname, 'public')));
  let examState = {
    sessionId: null, status: 'idle', title: 'General Assessment', subject: '', durationMinutes: 60,
    totalQuestions: 10, pdfUrl: null, pdfFileName: null, startTime: null, endTime: null,
    scheduledStartTime: null, examCode: 'EXAM101'
  };
  // Candidate identity remains stable across socket reconnections.
  let students = new Map();
  const recovered = storage.readActive();
  if (recovered?.examState) {
    examState = { ...examState, ...recovered.examState };
    for (const s of Object.values(recovered.students || {})) {
      if (!s.rollNo) continue;
      s.connected = false; s.inFullscreen = false;
      if (s.status !== 'submitted') {
        s.status = 'disconnected';
        if (examState.status === 'active') s.outOfFullscreenSince ||= recovered.updatedAt || clock();
      }
      students.set(rollKey(s.rollNo), s);
    }
  }
  const nowISO = () => new Date(clock()).toISOString();
  function snapshot(s) {
    return { ...s, liveAwaySeconds: s.outOfFullscreenSince && s.status !== 'submitted' ? Math.max(0, Math.round((clock() - s.outOfFullscreenSince) / 1000)) : 0 };
  }
  const roster = () => [...students.values()].map(snapshot);
  function persist() { storage.saveActive({ examState, students: Object.fromEntries(students), updatedAt: clock() }); }
  function archive(reason) {
    if (!examState.sessionId) return null;
    const old = storage.history().find(e => e.id === examState.sessionId);
    const entry = {
      ...examState, id: examState.sessionId, reason, concludedAt: old?.concludedAt || nowISO(),
      endedAt: examState.status === 'ended' ? old?.endedAt || nowISO() : null,
      formattedDate: old?.formattedDate || new Date().toLocaleString('en-US'),
      students: roster().map(s => ({ ...s, outDurationSeconds: s.outDurationSeconds + s.liveAwaySeconds, liveAwaySeconds: 0, outOfFullscreenSince: null }))
    };
    const list = mergeHistory([storage.history(), [entry]]);
    storage.saveHistory(list);
    io.to('teachers_room').emit('teacher:history_updated', list);
    return list.find(e => e.id === entry.id);
  }
  function broadcast() { io.to('teachers_room').emit('teacher:students_update', roster()); }
  function notify(type, title, message) {
    io.to('teachers_room').emit('teacher:new_notification', { type, title, message, timestamp: new Date().toLocaleTimeString() });
  }
  function settleAway(s) {
    if (s.outOfFullscreenSince) s.outDurationSeconds += Math.max(0, Math.round((clock() - s.outOfFullscreenSince) / 1000));
    s.outOfFullscreenSince = null; s.liveAwaySeconds = 0;
  }
  function finishStudent(s) {
    settleAway(s); s.status = 'submitted'; s.submittedAt ||= nowISO(); s.inFullscreen = false;
    s.answeredCount = answeredCount(s.answers);
  }
  function conclude(reason) {
    examState.status = 'ended';
    for (const s of students.values()) finishStudent(s);
    persist(); const entry = archive(reason); broadcast();
    io.to('students_room').emit('exam:ended', { message: reason });
    io.to('teachers_room').emit('exam:ended', { message: reason });
    return entry;
  }
  function paperExists() {
    return !!examState.pdfUrl && fs.existsSync(path.join(uploadsDir, path.basename(examState.pdfUrl)));
  }
  function activateExam(startTime) {
    examState.status = 'active'; examState.startTime = startTime;
    examState.endTime = startTime + examState.durationMinutes * 60000;
    for (const s of students.values()) if (s.status !== 'submitted') {
      s.status = s.connected ? 'in_test' : 'disconnected';
      // A sleeping server must not charge candidates for time before it resumed.
      s.outOfFullscreenSince ||= clock();
    }
    if (examState.endTime <= clock()) {
      conclude('The scheduled assessment window has ended.');
      return;
    }
    persist(); archive('Assessment commenced'); broadcast();
    io.emit('exam:started', { ...examState, serverTime: clock() });
  }
  function reconcileExamTiming() {
    if (!savingExam && examState.status === 'scheduled' && examState.scheduledStartTime <= clock()) {
      if (paperExists()) activateExam(examState.scheduledStartTime);
    }
    if (examState.status === 'active' && examState.endTime <= clock()) conclude('The assessment time has completed.');
  }
  // Reconcile persisted timestamps at boot and on requests; correctness never depends on a timer firing while asleep.
  const ready = (async () => {
    if (scheduleStore) {
      const saved = await scheduleStore.load();
      if (saved) {
        const sameSession = saved.examState.sessionId === examState.sessionId;
        examState = { ...examState, ...saved.examState };
        if (!sameSession) students = new Map();
        const paperPath = path.join(uploadsDir, path.basename(examState.pdfUrl));
        fs.writeFileSync(`${paperPath}.tmp`, saved.paper);
        fs.renameSync(`${paperPath}.tmp`, paperPath);
        persist();
      }
    }
    reconcileExamTiming();
    initialized = true;
  })();
  ready.catch(() => {});
  app.use(['/api', '/uploads'], async (req, res, next) => {
    try { await ready; reconcileExamTiming(); next(); } catch {
      res.status(503).json({ success: false, error: 'Exam recovery is unavailable. Ask the examiner to check schedule storage settings.' });
    }
  });
  io.use((socket, next) => { ready.then(() => next(), () => next(new Error('Exam recovery unavailable'))); });
  async function saveRemoteExam(state) {
    if (scheduleStore) await scheduleStore.save(state, fs.readFileSync(path.join(uploadsDir, path.basename(state.pdfUrl))));
  }
  function lockExamSave(req, res, next) {
    if (savingExam) return res.status(409).json({ success: false, error: 'An assessment change is already being saved. Try again shortly.' });
    savingExam = true;
    res.once('finish', () => { savingExam = false; });
    res.once('close', () => { savingExam = false; });
    next();
  }
  function requireTeacher(req, res, next) {
    if (req.session?.isTeacher) return next();
    res.status(401).json({ success: false, error: 'Teacher login required' });
  }
  function validAnswers(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(value).every(([q, answer]) => /^[1-9]\d*$/.test(q) && Number(q) <= examState.totalQuestions && typeof answer === 'string' && answer.length <= 50000);
  }
  const upload = multer({
    storage: multer.diskStorage({ destination: uploadsDir, filename: (req, file, cb) => cb(null, `${randomUUID()}.pdf`) }),
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(file.mimetype === 'application/pdf' && /\.pdf$/i.test(file.originalname) ? null : new Error('Only PDF files are allowed'), true)
  });
  app.get('/api/health', (req, res) => res.json({ status: 'ok', app: 'ProctorLock' }));
  const attempts = new Map();
  app.post('/api/teacher/login', (req, res, next) => {
    const now = clock();
    for (const [ip, a] of attempts) if (a.until < now) attempts.delete(ip);
    const attempt = attempts.get(req.ip) || { count: 0, until: now + 600000 };
    if (attempt.count >= 20) return res.status(429).json({ success: false, error: 'Too many attempts. Try again in 10 minutes.' });
    const supplied = Buffer.from(typeof req.body?.password === 'string' ? req.body.password : ''), expected = Buffer.from(password);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      attempt.count++; attempts.set(req.ip, attempt);
      return res.status(401).json({ success: false, error: 'Invalid teacher password' });
    }
    attempts.delete(req.ip);
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.isTeacher = true;
      req.session.save(error => error ? next(error) : res.json({ success: true }));
    });
  });
  app.get('/api/teacher/auth-status', (req, res) => res.json({ authenticated: !!req.session?.isTeacher }));
  app.get('/api/teacher/schedule-storage', requireTeacher, (req, res) => res.json({
    sleepSafe: !!scheduleStore, provider: scheduleStore?.provider || 'local',
    message: scheduleStore
      ? 'The schedule and PDF are saved encrypted outside Render. Students can wake the app without the teacher.'
      : requireDurableSchedules ? 'To schedule exams through Render sleep, configure EXAM_STORAGE_TOKEN, EXAM_STORAGE_REPO and a stable EXAM_STORAGE_KEY in Render. No database is needed.'
        : 'Local schedules survive restarts only while these files remain available. Configure GitHub storage before using Render free tier.'
  }));
  app.post('/api/teacher/logout', (req, res, next) => {
    const sid = req.sessionID;
    for (const socket of io.sockets.sockets.values()) if (socket.request.sessionID === sid) socket.disconnect(true);
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('connect.sid'); res.json({ success: true });
    });
  });
  app.get('/api/exam/state', (req, res) => res.json({ examState, studentsCount: roster().filter(s => s.connected).length, serverTime: clock() }));
  app.use('/uploads', (req, res, next) => {
    if (req.session?.isTeacher) return next();
    const token = req.query.token;
    const candidate = [...students.values()].find(s => typeof token === 'string' && s.resumeToken === token);
    if (!candidate || examState.status !== 'active' || candidate.status === 'submitted') return res.status(403).json({ error: 'Join the active exam to view its question paper' });
    if (`/uploads${req.path}` !== examState.pdfUrl) return res.status(403).json({ error: 'Paper unavailable' });
    next();
  }, express.static(uploadsDir, { dotfiles: 'deny' }));
  app.post('/api/teacher/exam', requireTeacher, lockExamSave, (req, res, next) => {
    if (examState.status === 'active') return res.status(409).json({ success: false, error: 'Conclude the active assessment before changing its configuration.' });
    next();
  }, upload.single('examPdf'), async (req, res) => {
    const { title, subject = '', examCode, durationMinutes, totalQuestions, scheduledStartTime } = req.body;
    const duration = Number(durationMinutes), questions = Number(totalQuestions);
    function reject(message) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: message });
    }
    if (typeof title !== 'string' || !title.trim() || title.length > 200 || typeof subject !== 'string' || subject.length > 200) return reject('Enter a title and subject of up to 200 characters.');
    if (!Number.isInteger(duration) || duration < 1 || duration > 3000 || !Number.isInteger(questions) || questions < 1 || questions > 200) return reject('Duration must be 1–3000 minutes and questions must be 1–200.');
    if (typeof examCode !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(examCode.trim())) return reject('Use 1–40 letters, numbers, underscores or hyphens for the join code.');
    const scheduled = scheduledStartTime ? Date.parse(scheduledStartTime) : null;
    if (scheduledStartTime && (!Number.isFinite(scheduled) || !/[zZ]$|[+-]\d{2}:\d{2}$/.test(scheduledStartTime) || scheduled <= clock())) return reject('Choose a future scheduled start time with a timezone.');
    if (scheduled && requireDurableSchedules && !scheduleStore) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(503).json({ success: false, error: 'Sleep-safe scheduling needs GitHub storage. Configure EXAM_STORAGE_TOKEN, EXAM_STORAGE_REPO and EXAM_STORAGE_KEY in Render. No database is required.' });
    }
    if (req.file) {
      const fd = fs.openSync(req.file.path, 'r'), header = Buffer.alloc(5);
      try { fs.readSync(fd, header, 0, 5, 0); } finally { fs.closeSync(fd); }
      if (header.toString() !== '%PDF-') return reject('The uploaded file is not a valid PDF.');
    }
    if (!req.file && !paperExists()) return reject('Upload a PDF question paper. The previous file is unavailable.');
    const nextState = {
      ...examState, sessionId: ['created', 'scheduled'].includes(examState.status) ? examState.sessionId : `exam-${randomUUID()}`,
      status: scheduled ? 'scheduled' : 'created', scheduledStartTime: scheduled,
      title: title.trim(), subject: subject.trim(), durationMinutes: duration,
      totalQuestions: questions, examCode: examCode.trim().toUpperCase(), startTime: null, endTime: null,
      pdfUrl: req.file ? `/uploads/${req.file.filename}` : examState.pdfUrl,
      pdfFileName: req.file ? req.file.originalname : examState.pdfFileName
    };
    try { await saveRemoteExam(nextState); } catch {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(503).json({ success: false, error: 'The exam could not be saved to GitHub storage. The previous assessment is unchanged. Check the repository token and retry.' });
    }
    archive('Archived before assessment reconfiguration');
    if (examState.status === 'ended') {
      io.in('students_room').disconnectSockets(true); students = new Map();
    }
    examState = nextState;
    persist(); io.emit('exam:updated', examState); broadcast();
    res.json({ success: true, examState });
  });
  app.post('/api/teacher/exam/start', requireTeacher, lockExamSave, async (req, res) => {
    if (!examState.pdfUrl || examState.status === 'idle') return res.status(400).json({ success: false, error: 'Upload and save an assessment first.' });
    if (examState.status === 'active') return res.status(409).json({ success: false, error: 'Assessment already active.' });
    if (!fs.existsSync(path.join(uploadsDir, path.basename(examState.pdfUrl)))) return res.status(400).json({ success: false, error: 'The question paper is missing. Upload it again.' });
    const startTime = clock();
    const nextState = { ...examState, status: 'active', scheduledStartTime: null, startTime,
      endTime: startTime + examState.durationMinutes * 60000,
      sessionId: examState.status === 'ended' ? `exam-${randomUUID()}` : examState.sessionId };
    try { await saveRemoteExam(nextState); } catch {
      return res.status(503).json({ success: false, error: 'The start could not be saved to schedule storage. Please retry.' });
    }
    if (examState.status === 'ended') {
      archive('Archived before restart'); io.in('students_room').disconnectSockets(true); students = new Map();
    }
    examState = nextState;
    activateExam(startTime);
    res.json({ success: true, examState });
  });
  app.post('/api/teacher/exam/end', requireTeacher, lockExamSave, async (req, res) => {
    if (examState.status !== 'active') return res.status(409).json({ success: false, error: 'No active assessment.' });
    try { await saveRemoteExam({ ...examState, status: 'ended' }); } catch {
      return res.status(503).json({ success: false, error: 'The early conclusion could not be saved to schedule storage. Please retry.' });
    }
    res.json({ success: true, archived: conclude('The assessment was concluded by the examiner.'), examState });
  });
  app.post('/api/teacher/student/force-submit', requireTeacher, (req, res) => {
    const s = [...students.values()].find(s => s.socketId === req.body?.studentSocketId);
    if (!s) return res.status(404).json({ success: false, error: 'Candidate not found' });
    finishStudent(s); persist(); archive('Examiner forced submission'); broadcast();
    io.to(s.socketId).emit('student:force_submitted', { reason: String(req.body.reason || 'Submitted by examiner').slice(0, 500), student: snapshot(s) });
    res.json({ success: true });
  });
  function clearRoster() {
    const count = students.size;
    archive('Archived on roster refresh');
    io.in('students_room').disconnectSockets(true); students = new Map(); persist(); broadcast();
    notify('warning', 'Roster reset', `${count} candidates archived and cleared. New logins can join.`);
    return count;
  }
  app.post('/api/teacher/students/clear-inactive', requireTeacher, (req, res) => res.json({ success: true, removedCount: clearRoster(), remainingCount: 0 }));
  app.get('/api/teacher/history', requireTeacher, (req, res) => res.json({ success: true, history: storage.history() }));
  app.get('/api/teacher/history/backup-json', requireTeacher, (req, res) => res.attachment(`proctorlock-backup-${clock()}.json`).json(storage.history()));
  app.post('/api/teacher/history/restore-backup', requireTeacher, (req, res) => {
    const list = req.body?.history;
    if (!Array.isArray(list) || list.length > 10000 || list.some(e => !e || !safeId(e.id) || !Array.isArray(e.students) || !Number.isInteger(e.totalQuestions) || e.totalQuestions < 1 || e.totalQuestions > 200 || e.students.some(s => !s || typeof s.rollNo !== 'string' || !rollKey(s.rollNo) || !s.answers || typeof s.answers !== 'object' || Array.isArray(s.answers) || Object.values(s.answers).some(a => typeof a !== 'string') || (s.violations !== undefined && !Array.isArray(s.violations))))) return res.status(400).json({ success: false, error: 'Invalid exam history backup' });
    const before = storage.history().length, history = storage.restore(list);
    io.to('teachers_room').emit('teacher:history_updated', history);
    res.json({ success: true, count: history.length, added: history.length - before, history });
  });
  app.post('/api/teacher/history/archive-now', requireTeacher, (req, res) => res.json({ success: true, archived: archive('Manual archive') }));
  app.get('/api/teacher/history/:id', requireTeacher, (req, res) => {
    const exam = storage.history().find(e => e.id === req.params.id);
    if (!exam) return res.status(404).json({ success: false, error: 'Exam not found' });
    res.json({ success: true, exam });
  });
  app.delete('/api/teacher/history/:id', requireTeacher, (req, res) => {
    if (!safeId(req.params.id)) return res.status(400).json({ success: false, error: 'Invalid identifier' });
    if (examState.sessionId === req.params.id && examState.status === 'active') return res.status(409).json({ success: false, error: 'Conclude the active exam before deleting its history.' });
    const exists = storage.history().some(e => e.id === req.params.id), history = storage.delete(req.params.id);
    // Prevent a later shutdown snapshot from recreating an explicitly deleted, ended exam.
    if (examState.sessionId === req.params.id) { examState.sessionId = null; persist(); }
    io.to('teachers_room').emit('teacher:history_updated', history); res.json({ success: true, deleted: exists });
  });
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function exportCSV(res, exam, list) {
    const header = ['Student Name', 'Roll Number', 'Status', 'Submitted At', 'Total Away (Seconds)', 'Total Flags', 'Questions Answered', ...Array.from({ length: exam.totalQuestions }, (_, i) => `Q${i + 1} Answer`)];
    const rows = list.map(s => [s.name, s.rollNo, s.status, s.submittedAt, (s.outDurationSeconds || 0) + (s.liveAwaySeconds || 0), (s.violations || []).length, `${answeredCount(s.answers)}/${exam.totalQuestions}`, ...Array.from({ length: exam.totalQuestions }, (_, i) => s.answers?.[i + 1] || '')]);
    res.attachment(`exam-${exam.sessionId || exam.id || 'live'}.csv`).type('text/csv; charset=utf-8').send('\uFEFF' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n'));
  }
  app.get('/api/teacher/export-submissions', requireTeacher, (req, res) => exportCSV(res, examState, roster()));
  app.get('/api/teacher/history/:id/export-csv', requireTeacher, (req, res) => {
    const exam = storage.history().find(e => e.id === req.params.id);
    if (!exam) return res.status(404).json({ success: false, error: 'Exam not found' });
    exportCSV(res, exam, exam.students);
  });
  app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'API endpoint not found' }));
  app.use((error, req, res, next) => {
    console.error(error.message);
    res.status(error.status || (error instanceof multer.MulterError ? 400 : 500)).json({ success: false, error: error.message });
  });
  io.on('connection', socket => {
    try { reconcileExamTiming(); } catch { socket.disconnect(true); return; }
    if (socket.handshake.headers.origin) {
      try { if (new URL(socket.handshake.headers.origin).host !== socket.handshake.headers.host) return socket.disconnect(true); }
      catch { return socket.disconnect(true); }
    }
    const authorizedTeacher = callback => {
      if (!socket.request.session?.isTeacher) return socket.emit('teacher:auth_error', { message: 'Teacher login required' });
      socket.request.session.reload(error => {
        if (error || !socket.request.session?.isTeacher) { socket.leave('teachers_room'); return socket.emit('teacher:auth_error', { message: 'Session expired. Sign in again.' }); }
        try { callback(); } catch (error) { socket.emit('operation:error', { message: error.message }); }
      });
    };
    socket.on('teacher:join', () => authorizedTeacher(() => {
      socket.join('teachers_room'); socket.emit('exam:state_sync', examState);
      socket.emit('teacher:students_update', roster()); socket.emit('teacher:history_updated', storage.history());
    }));
    socket.on('teacher:clear_inactive', () => authorizedTeacher(clearRoster));
    socket.on('student:join', (data = {}) => {
      try {
        reconcileExamTiming();
        if (!['created', 'scheduled', 'active', 'ended'].includes(examState.status)) return socket.emit('student:join_error', { message: 'No assessment is available yet.' });
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 120 || typeof data.rollNo !== 'string' || !data.rollNo.trim() || data.rollNo.length > 80 || typeof data.examCode !== 'string' || data.examCode.trim().toUpperCase() !== examState.examCode) return socket.emit('student:join_error', { message: 'Enter your name, roll number and a valid exam code.' });
        const key = rollKey(data.rollNo);
        if (socket.data.roll && socket.data.roll !== key) return socket.emit('student:join_error', { message: 'Already joined as another candidate.' });
        let s = students.get(key);
        if (!s) {
          const archived = storage.history().find(e => e.id === examState.sessionId)?.students.find(s => rollKey(s.rollNo) === key);
          s = archived ? { ...archived, answers: { ...archived.answers }, violations: [...archived.violations] } : {
            name: data.name.trim(), rollNo: data.rollNo.trim(), status: 'waiting', answers: {}, answeredCount: 0,
            outDurationSeconds: 0, violations: [], submittedAt: null, joinedAt: nowISO()
          };
        }
        if (s.resumeToken && data.resumeToken !== s.resumeToken) return socket.emit('student:join_error', { message: 'This roll number is already registered. Resume from the original browser or contact the examiner.' });
        if (examState.status === 'ended' && s.status !== 'submitted') return socket.emit('student:join_error', { message: 'This assessment has ended.' });
        if (s.socketId && s.socketId !== socket.id) io.sockets.sockets.get(s.socketId)?.disconnect(true);
        s.resumeToken ||= randomBytes(32).toString('hex'); s.socketId = socket.id; s.connected = true; s.inFullscreen = false;
        if (s.status !== 'submitted') {
          s.status = examState.status === 'active' ? 'in_test' : 'waiting';
          if (examState.status === 'active') s.outOfFullscreenSince ||= clock();
        }
        students.set(key, s); socket.data.roll = key; socket.data.sessionId = examState.sessionId;
        socket.join('students_room'); persist(); archive('Candidate joined');
        socket.emit('student:joined_success', { student: snapshot(s), examState, serverTime: clock() });
        broadcast(); notify('info', 'Candidate joined', `${s.name} (${s.rollNo}) joined the room.`);
      } catch (error) { socket.emit('student:join_error', { message: error.message }); }
    });
    function currentStudent() {
      const s = students.get(socket.data.roll);
      return s && s.socketId === socket.id && socket.data.sessionId === examState.sessionId ? s : null;
    }
    function editableStudent() {
      const s = currentStudent();
      reconcileExamTiming();
      return s && s.status !== 'submitted' && examState.status === 'active' ? s : null;
    }
    function addViolation(s, type, details) {
      if (s.violations.length >= 5000) return;
      s.violations.push({ id: randomUUID(), type, details, time: new Date().toLocaleTimeString(), timestamp: nowISO() });
      notify('danger', `Flag: ${type}`, `${s.name} (${s.rollNo}): ${details}`);
    }
    function socketAction(event, handler) {
      socket.on(event, (data, ack) => {
        if (typeof data === 'function') { ack = data; data = {}; }
        try { handler(data || {}, typeof ack === 'function' ? ack : () => {}); }
        catch (error) { if (typeof ack === 'function') ack({ success: false, error: error.message }); socket.emit('operation:error', { message: error.message }); }
      });
    }
    socketAction('student:fullscreen_entered', () => {
      const s = editableStudent(); if (!s) return;
      settleAway(s); s.inFullscreen = true; persist(); broadcast();
    });
    socketAction('student:fullscreen_exited', () => {
      const s = editableStudent(); if (!s || !s.inFullscreen) return;
      s.inFullscreen = false; s.outOfFullscreenSince ||= clock();
      addViolation(s, 'fullscreen_exit', 'Exited fullscreen mode'); persist(); broadcast();
    });
    socketAction('student:violation', data => {
      const s = editableStudent(); if (!s || typeof data.type !== 'string' || typeof data.details !== 'string') return;
      const last = s.violations.at(-1);
      if (last?.type === data.type && clock() - new Date(last.timestamp).getTime() < 1000) return;
      addViolation(s, data.type.slice(0, 60), data.details.slice(0, 500)); persist(); broadcast();
    });
    socketAction('student:save_answer', (data, ack) => {
      const s = editableStudent();
      if (!s) return ack({ success: false, error: 'Assessment is closed or already submitted' });
      if (!validAnswers({ [data.questionNumber]: data.answer })) return ack({ success: false, error: 'Invalid answer' });
      s.answers[data.questionNumber] = data.answer; s.answeredCount = answeredCount(s.answers);
      persist(); scheduleArchive(); broadcast(); ack({ success: true });
    });
    socketAction('student:submit_exam', (data, ack) => {
      const s = currentStudent(); if (!s) return ack({ success: false, error: 'Join the assessment first' });
      reconcileExamTiming();
      if (s.status !== 'submitted') {
        if (examState.status !== 'active' || !validAnswers(data.answers || {})) return ack({ success: false, error: 'Invalid submission or assessment closed' });
        s.answers = { ...s.answers, ...data.answers }; finishStudent(s); persist(); archive('Candidate submission'); broadcast();
        notify('success', 'Assessment submitted', `${s.name} (${s.rollNo}) submitted ${s.answeredCount}/${examState.totalQuestions} answers.`);
      }
      ack({ success: true, student: snapshot(s) });
    });
    socket.on('disconnect', () => {
      const s = currentStudent(); if (!s) return;
      s.connected = false; s.inFullscreen = false;
      if (s.status !== 'submitted') { s.status = 'disconnected'; if (examState.status === 'active') s.outOfFullscreenSince ||= clock(); }
      try { persist(); archive('Candidate disconnected'); } catch (error) { console.error(error.message); }
      broadcast();
    });
  });
  let archiveTimer;
  function scheduleArchive() {
    if (archiveTimer) return;
    archiveTimer = setTimeout(() => {
      archiveTimer = null;
      try { archive('Live answer autosave'); } catch (error) { console.error(error.message); }
    }, 1000);
  }
  const ticker = setInterval(() => {
    try {
      if (!initialized || savingExam) return;
      reconcileExamTiming();
      if (examState.status === 'active') broadcast();
    } catch (error) { console.error(error.message); }
  }, 2000);
  const expiryTimer = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) if (socket.rooms.has('teachers_room')) {
      socket.request.session.reload(error => { if (error || !socket.request.session?.isTeacher) socket.disconnect(true); });
    }
  }, 60000);
  async function close() {
    clearInterval(ticker); clearInterval(expiryTimer); clearTimeout(archiveTimer);
    if (initialized) { persist(); if (examState.sessionId) archive('Server shutdown'); }
    await new Promise(resolve => io.close(resolve));
  }
  return { app, server, close, ready };
}
if (require.main === module) {
  const instance = createApp(), port = Number(process.env.PORT) || 3000;
  instance.server.listen(port, '0.0.0.0', () => console.log(`ProctorLock listening on http://localhost:${port}`));
  instance.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await instance.close(); process.exit(0); });
}
module.exports = { createApp };
