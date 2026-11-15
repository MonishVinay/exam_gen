const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const session = require('express-session');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'teacher123';

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Ensure data directories exist (multi-tier persistence)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const sessionsDir = path.join(dataDir, 'sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

const historyFilePath = path.join(dataDir, 'exam-history.json');
const backupFilePath = path.join(dataDir, 'exam-history-backup.json');
const activeSessionFilePath = path.join(sessionsDir, 'active-session.json');

if (!fs.existsSync(historyFilePath)) {
  fs.writeFileSync(historyFilePath, JSON.stringify([], null, 2), 'utf-8');
}

// 1. Rock-Solid History Loading with Triple-Redundancy Fallback
function loadHistory() {
  // A. Try loading primary file
  try {
    if (fs.existsSync(historyFilePath)) {
      const content = fs.readFileSync(historyFilePath, 'utf-8').trim();
      if (content) {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    }
  } catch (err) {
    console.error('[STORAGE] Error reading primary history file:', err.message);
  }

  // B. Try loading backup copy
  try {
    if (fs.existsSync(backupFilePath)) {
      const backupContent = fs.readFileSync(backupFilePath, 'utf-8').trim();
      if (backupContent) {
        const parsed = JSON.parse(backupContent);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log('[STORAGE] Recovered history from backup copy!');
          // Restore primary from backup
          try { fs.writeFileSync(historyFilePath, backupContent, 'utf-8'); } catch (e) {}
          return parsed;
        }
      }
    }
  } catch (bErr) {
    console.error('[STORAGE] Error reading backup copy:', bErr.message);
  }

  // C. Scan individual session files in data/sessions/
  try {
    if (fs.existsSync(sessionsDir)) {
      const sessionFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json') && f !== 'active-session.json');
      if (sessionFiles.length > 0) {
        const recovered = [];
        for (const file of sessionFiles) {
          try {
            const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
            const entry = JSON.parse(raw);
            if (entry && entry.id) recovered.push(entry);
          } catch (e) {}
        }
        if (recovered.length > 0) {
          // Sort latest first
          recovered.sort((a, b) => (new Date(b.concludedAt || b.endedAt || 0)) - (new Date(a.concludedAt || a.endedAt || 0)));
          console.log(`[STORAGE] Recovered ${recovered.length} session(s) from sessions directory!`);
          saveHistory(recovered);
          return recovered;
        }
      }
    }
  } catch (sErr) {
    console.error('[STORAGE] Error scanning session files:', sErr.message);
  }

  return [];
}

// 2. Atomic Disk Writer (Prevents file corruption if process crashes mid-write)
function saveHistory(historyList) {
  if (!Array.isArray(historyList)) return false;
  try {
    const dataStr = JSON.stringify(historyList, null, 2);
    const tmpFile = `${historyFilePath}.${Date.now()}.tmp`;

    // Write to temp file first
    fs.writeFileSync(tmpFile, dataStr, 'utf-8');
    // Atomic rename
    fs.renameSync(tmpFile, historyFilePath);

    // Write redundant backup copy
    try {
      fs.writeFileSync(backupFilePath, dataStr, 'utf-8');
    } catch (bErr) {}

    return true;
  } catch (err) {
    console.error('[STORAGE] Error writing atomic history file:', err);
    try {
      // Direct write fallback
      fs.writeFileSync(historyFilePath, JSON.stringify(historyList, null, 2), 'utf-8');
      return true;
    } catch (fallbackErr) {
      console.error('[STORAGE] Fatal write failure:', fallbackErr);
      return false;
    }
  }
}

// 3. Persist Active Live State to Disk (For Instant Crash/Restart Recovery)
function persistActiveSessionToDisk() {
  try {
    const payload = {
      examState,
      students,
      updatedAt: Date.now()
    };
    const tmp = `${activeSessionFilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, activeSessionFilePath);
  } catch (err) {
    console.error('[STORAGE] Error persisting active session:', err.message);
  }
}

// 4. Archive Exam Session (Roll-Number Deduplication & Non-Destructive Merging)
function archiveCurrentExamSession(reason = 'Exam concluded') {
  const studentList = Object.values(students);
  if (studentList.length === 0 && !examState.pdfUrl && examState.status === 'idle') {
    return null;
  }

  const history = loadHistory();
  const sessionId = examState.sessionId || `exam-${examState.startTime || Date.now()}`;
  if (!examState.sessionId) {
    examState.sessionId = sessionId;
  }

  // Find existing session entry in history
  const existingIdx = history.findIndex(h => h.id === sessionId);
  const existingEntry = existingIdx >= 0 ? history[existingIdx] : null;

  // Student master map keyed by rollNo
  const studentsMap = {};

  // Step A: Load all previously archived students for this session (prevents data wipe on roster clear!)
  if (existingEntry && Array.isArray(existingEntry.students)) {
    for (const s of existingEntry.students) {
      const key = (s.rollNo || s.socketId || '').trim().toLowerCase();
      if (key) {
        studentsMap[key] = {
          ...s,
          answers: { ...(s.answers || {}) },
          violations: [...(s.violations || [])]
        };
      }
    }
  }

  // Step B: Merge in currently active students (latest answers, updated durations)
  for (const s of studentList) {
    const key = (s.rollNo || s.socketId || '').trim().toLowerCase();
    if (!key) continue;

    const existing = studentsMap[key];
    const liveAway = s.liveAwaySeconds || 0;
    const totalAway = (s.outDurationSeconds || 0) + liveAway;
    const currentAnswers = s.answers || {};

    if (!existing) {
      studentsMap[key] = {
        socketId: s.socketId,
        name: s.name,
        rollNo: s.rollNo,
        status: s.status,
        answers: { ...currentAnswers },
        answeredCount: Object.values(currentAnswers).filter(a => a && a.trim().length > 0).length,
        outDurationSeconds: totalAway,
        violations: [...(s.violations || [])],
        submittedAt: s.submittedAt || (s.status === 'submitted' ? 'Submitted' : (examState.status === 'ended' ? 'Concluded' : 'In Progress')),
        joinedAt: s.joinedAt
      };
    } else {
      // Non-destructive answer merge: NEVER wipe a previously answered question!
      const mergedAnswers = { ...(existing.answers || {}) };
      for (const [qNum, ans] of Object.entries(currentAnswers)) {
        if (ans !== undefined && ans !== null && ans !== '') {
          mergedAnswers[qNum] = ans;
        } else if (!mergedAnswers[qNum]) {
          mergedAnswers[qNum] = ans || '';
        }
      }

      // Merge violation logs uniquely
      const mergedViolations = [...(existing.violations || [])];
      for (const v of (s.violations || [])) {
        if (!mergedViolations.some(mv => mv.time === v.time && mv.type === v.type)) {
          mergedViolations.push(v);
        }
      }

      const isSub = s.status === 'submitted' || existing.status === 'submitted';

      studentsMap[key] = {
        socketId: s.socketId || existing.socketId,
        name: s.name || existing.name,
        rollNo: s.rollNo || existing.rollNo,
        status: isSub ? 'submitted' : s.status,
        answers: mergedAnswers,
        answeredCount: Object.values(mergedAnswers).filter(a => a && a.trim().length > 0).length,
        outDurationSeconds: Math.max(existing.outDurationSeconds || 0, totalAway),
        violations: mergedViolations,
        submittedAt: s.submittedAt || existing.submittedAt || (isSub ? 'Submitted' : (examState.status === 'ended' ? 'Concluded' : 'In Progress')),
        joinedAt: existing.joinedAt || s.joinedAt
      };
    }
  }

  const finalStudentsList = Object.values(studentsMap);

  const historyEntry = {
    id: sessionId,
    title: examState.title || existingEntry?.title || 'General Assessment',
    subject: examState.subject || existingEntry?.subject || '',
    examCode: examState.examCode || existingEntry?.examCode || 'EXAM101',
    totalQuestions: examState.totalQuestions || existingEntry?.totalQuestions || 10,
    durationMinutes: examState.durationMinutes || existingEntry?.durationMinutes || 60,
    pdfFileName: examState.pdfFileName || existingEntry?.pdfFileName || '',
    pdfUrl: examState.pdfUrl || existingEntry?.pdfUrl || '',
    startTime: examState.startTime || existingEntry?.startTime,
    endTime: examState.endTime || existingEntry?.endTime,
    endedAt: examState.status === 'ended' ? (existingEntry?.endedAt || new Date().toISOString()) : (existingEntry?.endedAt || null),
    concludedAt: existingEntry?.concludedAt || new Date().toISOString(),
    formattedDate: existingEntry?.formattedDate || new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }),
    reason: reason,
    totalStudents: finalStudentsList.length,
    submittedCount: finalStudentsList.filter(s => s.status === 'submitted' || s.submittedAt).length,
    students: finalStudentsList
  };

  if (existingIdx >= 0) {
    history[existingIdx] = historyEntry;
  } else {
    history.unshift(historyEntry);
  }

  saveHistory(history);

  // Per-Session Backup File
  try {
    const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
    fs.writeFileSync(sessionFile, JSON.stringify(historyEntry, null, 2), 'utf-8');
  } catch (e) {
    console.error('[STORAGE] Error writing individual session backup file:', e.message);
  }

  return historyEntry;
}

// Multer Storage Configuration for PDF
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const cleanName = `${Date.now()}-exam${ext}`;
    cb(null, cleanName);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'proctor-super-secret-key-99',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));

// Serve uploaded PDFs safely
app.use('/uploads', express.static(uploadsDir));
// Serve public frontend
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Exam State
let examState = {
  status: 'idle', // 'idle' | 'created' | 'active' | 'ended'
  title: 'General Assessment',
  subject: '',
  durationMinutes: 60,
  totalQuestions: 10,
  pdfUrl: null,
  pdfFileName: null,
  startTime: null,
  endTime: null,
  examCode: 'EXAM101'
};

// Connected Students Store: { socketId: { id, name, rollNo, status, inFullscreen, outDurationSeconds, violations: [], answers: {}, answeredCount: 0, joinedAt } }
let students = {};

// Disaster Recovery: Restore active exam session on server reboot if exists
try {
  if (fs.existsSync(activeSessionFilePath)) {
    const rawActive = fs.readFileSync(activeSessionFilePath, 'utf-8').trim();
    if (rawActive) {
      const activeData = JSON.parse(rawActive);
      if (activeData && activeData.examState && (activeData.examState.status === 'active' || activeData.examState.status === 'created')) {
        examState = { ...examState, ...activeData.examState };
        students = activeData.students || {};
        console.log(`[RECOVERY] Restored active exam "${examState.title}" with ${Object.keys(students).length} students from disk!`);
      }
    }
  }
} catch (recErr) {
  console.error('[RECOVERY] Failed to restore active session:', recErr.message);
}

// Helper: Authentication Middleware for Teacher
function requireTeacherAuth(req, res, next) {
  if (req.session && req.session.isTeacher) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Teacher login required.' });
}

// ========================
// API ROUTES
// ========================

// Teacher Login
app.post('/api/teacher/login', (req, res) => {
  const { password } = req.body;
  if (password === TEACHER_PASSWORD) {
    req.session.isTeacher = true;
    return res.json({ success: true, message: 'Authenticated successfully' });
  }
  return res.status(401).json({ success: false, error: 'Invalid teacher password' });
});

// Check Teacher Auth Status
app.get('/api/teacher/auth-status', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.isTeacher) });
});

// Teacher Logout
app.post('/api/teacher/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get Current Exam State (Public for students & teachers)
app.get('/api/exam/state', (req, res) => {
  res.json({
    examState,
    studentsCount: Object.keys(students).length
  });
});

// Teacher: Create/Upload Exam
app.post('/api/teacher/exam', requireTeacherAuth, upload.single('examPdf'), (req, res) => {
  try {
    const { title, subject, durationMinutes, examCode, totalQuestions } = req.body;

    if (req.file) {
      examState.pdfUrl = `/uploads/${req.file.filename}`;
      examState.pdfFileName = req.file.originalname;
    }

    examState.title = title || examState.title;
    examState.subject = subject || examState.subject;
    const parsedDuration = parseInt(durationMinutes, 10) || 60;
    examState.durationMinutes = Math.min(3000, Math.max(1, parsedDuration));
    examState.totalQuestions = Math.max(1, parseInt(totalQuestions, 10) || 10);
    examState.examCode = (examCode || 'EXAM101').toUpperCase().trim();
    examState.status = 'created';
    examState.startTime = null;
    examState.endTime = null;

    // Persist to disk
    persistActiveSessionToDisk();

    // Notify all connected sockets of state update
    io.emit('exam:updated', examState);

    res.json({ success: true, examState });
  } catch (err) {
    console.error('Error creating exam:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Teacher: Start Exam
app.post('/api/teacher/exam/start', requireTeacherAuth, (req, res) => {
  if (!examState.pdfUrl) {
    return res.status(400).json({ success: false, error: 'Please upload a PDF before starting the exam.' });
  }

  const now = Date.now();
  const durationMs = examState.durationMinutes * 60 * 1000;

  examState.sessionId = `exam-${now}`;
  examState.status = 'active';
  examState.startTime = now;
  examState.endTime = now + durationMs;

  persistActiveSessionToDisk();
  archiveCurrentExamSession('Exam commenced');

  io.emit('exam:started', {
    ...examState,
    serverTime: now
  });

  res.json({ success: true, examState });
});

// Teacher: End Exam (Conclude & Archive to History)
app.post('/api/teacher/exam/end', requireTeacherAuth, (req, res) => {
  examState.status = 'ended';

  // Save the complete session with all student responses to history
  const archived = archiveCurrentExamSession('Concluded by examiner');
  persistActiveSessionToDisk();

  io.emit('exam:ended', { message: 'The exam has been concluded by the examiner.' });
  if (archived) {
    io.to('teachers_room').emit('teacher:history_updated', loadHistory());
  }

  res.json({ success: true, examState, archived });
});

// Teacher: Get Student Answers (Current Live Exam or History Fallback)
app.get('/api/teacher/student-answers/:socketId', requireTeacherAuth, (req, res) => {
  const targetId = req.params.socketId;
  let student = students[targetId];

  // Fallback 1: lookup by rollNo in active session
  if (!student) {
    student = Object.values(students).find(s => s.rollNo === targetId);
  }

  // Fallback 2: lookup across archived exam history
  if (!student) {
    const history = loadHistory();
    for (const h of history) {
      const found = (h.students || []).find(s => s.socketId === targetId || s.rollNo === targetId);
      if (found) {
        student = found;
        break;
      }
    }
  }

  if (!student) {
    return res.status(404).json({ success: false, error: 'Student submission not found' });
  }

  res.json({
    success: true,
    student: {
      socketId: student.socketId,
      name: student.name,
      rollNo: student.rollNo,
      status: student.status,
      answers: student.answers || {},
      answeredCount: student.answeredCount || 0,
      totalQuestions: examState.totalQuestions || student.totalQuestions || 10,
      outDurationSeconds: student.outDurationSeconds || 0,
      violations: student.violations || [],
      submittedAt: student.submittedAt
    }
  });
});

// Teacher: Export Current Live Exam Submissions to CSV
app.get('/api/teacher/export-submissions', requireTeacherAuth, (req, res) => {
  const studentList = Object.values(students);
  const totalQ = examState.totalQuestions || 10;

  let header = ['Student Name', 'Roll Number', 'Status', 'Submitted At', 'Total Away (Seconds)', 'Total Flags', 'Questions Answered'];
  for (let i = 1; i <= totalQ; i++) {
    header.push(`Q${i} Answer`);
  }

  const rows = [header.join(',')];

  studentList.forEach(s => {
    const row = [
      `"${(s.name || '').replace(/"/g, '""')}"`,
      `"${(s.rollNo || '').replace(/"/g, '""')}"`,
      `"${s.status || ''}"`,
      `"${s.submittedAt || ''}"`,
      s.outDurationSeconds || 0,
      (s.violations || []).length,
      `${s.answeredCount || 0}/${totalQ}`
    ];

    for (let i = 1; i <= totalQ; i++) {
      const ans = s.answers && s.answers[i] ? s.answers[i] : '';
      row.push(`"${ans.replace(/"/g, '""')}"`);
    }

    rows.push(row.join(','));
  });

  const csvContent = rows.join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="exam-submissions-${Date.now()}.csv"`);
  res.status(200).send(csvContent);
});

// ========================
// EXAM HISTORY API ROUTES
// ========================

// Teacher: Get All Past Exam History
app.get('/api/teacher/history', requireTeacherAuth, (req, res) => {
  const history = loadHistory();
  res.json({ success: true, history });
});

// Teacher: Get Details of a Past Exam
app.get('/api/teacher/history/:id', requireTeacherAuth, (req, res) => {
  const history = loadHistory();
  const exam = history.find(h => h.id === req.params.id);
  if (!exam) {
    return res.status(404).json({ success: false, error: 'Exam history record not found' });
  }
  res.json({ success: true, exam });
});

// Teacher: Export Specific Past Exam from History to CSV
app.get('/api/teacher/history/:id/export-csv', requireTeacherAuth, (req, res) => {
  const history = loadHistory();
  const exam = history.find(h => h.id === req.params.id);
  if (!exam) {
    return res.status(404).send('Exam record not found');
  }

  const studentList = exam.students || [];
  const totalQ = exam.totalQuestions || 10;

  let header = ['Student Name', 'Roll Number', 'Status', 'Submitted At', 'Total Away (Seconds)', 'Total Flags', 'Questions Answered'];
  for (let i = 1; i <= totalQ; i++) {
    header.push(`Q${i} Answer`);
  }

  const rows = [header.join(',')];

  studentList.forEach(s => {
    const row = [
      `"${(s.name || '').replace(/"/g, '""')}"`,
      `"${(s.rollNo || '').replace(/"/g, '""')}"`,
      `"${s.status || ''}"`,
      `"${s.submittedAt || ''}"`,
      s.outDurationSeconds || 0,
      (s.violations || []).length,
      `${s.answeredCount || 0}/${totalQ}`
    ];

    for (let i = 1; i <= totalQ; i++) {
      const ans = s.answers && s.answers[i] ? s.answers[i] : '';
      row.push(`"${ans.replace(/"/g, '""')}"`);
    }

    rows.push(row.join(','));
  });

  const csvContent = rows.join('\r\n');
  const safeTitle = (exam.title || 'exam').replace(/[^a-zA-Z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}-history-${exam.id}.csv"`);
  res.status(200).send(csvContent);
});

// Teacher: Delete Past Exam from History
app.delete('/api/teacher/history/:id', requireTeacherAuth, (req, res) => {
  let history = loadHistory();
  const initialLen = history.length;
  history = history.filter(h => h.id !== req.params.id);
  saveHistory(history);

  // Also remove individual session file if exists
  try {
    const sFile = path.join(sessionsDir, `${req.params.id}.json`);
    if (fs.existsSync(sFile)) fs.unlinkSync(sFile);
  } catch (e) {}

  io.to('teachers_room').emit('teacher:history_updated', history);
  res.json({ success: true, deleted: initialLen > history.length });
});

// Teacher: Download Full Permanent History Backup (JSON file)
app.get('/api/teacher/history/backup-json', requireTeacherAuth, (req, res) => {
  const history = loadHistory();
  const jsonContent = JSON.stringify(history, null, 2);
  const filename = `proctorlock-exam-history-backup-${Date.now()}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(jsonContent);
});

// Teacher: Restore / Import History from Client Backup or File
app.post('/api/teacher/history/restore-backup', requireTeacherAuth, (req, res) => {
  try {
    const { history: importedHistory } = req.body;
    if (!Array.isArray(importedHistory)) {
      return res.status(400).json({ success: false, error: 'Invalid history payload. Array expected.' });
    }

    const currentHistory = loadHistory();
    const historyMap = {};

    // 1. Index existing history
    for (const h of currentHistory) {
      if (h && h.id) historyMap[h.id] = h;
    }

    // 2. Non-destructively merge incoming records
    let addedCount = 0;
    for (const h of importedHistory) {
      if (h && h.id) {
        if (!historyMap[h.id]) {
          historyMap[h.id] = h;
          addedCount++;
        } else {
          // Merge students inside session
          const existingStudents = historyMap[h.id].students || [];
          const incomingStudents = h.students || [];
          const sMap = {};
          for (const s of existingStudents) {
            const k = (s.rollNo || s.socketId || '').trim().toLowerCase();
            if (k) sMap[k] = s;
          }
          for (const s of incomingStudents) {
            const k = (s.rollNo || s.socketId || '').trim().toLowerCase();
            if (k) {
              if (!sMap[k]) {
                sMap[k] = s;
              } else {
                // Merge answers
                sMap[k].answers = { ...(sMap[k].answers || {}), ...(s.answers || {}) };
                sMap[k].answeredCount = Object.values(sMap[k].answers).filter(a => a && a.trim().length > 0).length;
              }
            }
          }
          historyMap[h.id].students = Object.values(sMap);
          historyMap[h.id].totalStudents = historyMap[h.id].students.length;
        }
      }
    }

    const mergedList = Object.values(historyMap);
    // Sort latest first
    mergedList.sort((a, b) => (new Date(b.concludedAt || b.endedAt || 0)) - (new Date(a.concludedAt || a.endedAt || 0)));

    saveHistory(mergedList);

    // Save individual session backup files
    for (const entry of mergedList) {
      try {
        const sFile = path.join(sessionsDir, `${entry.id}.json`);
        fs.writeFileSync(sFile, JSON.stringify(entry, null, 2), 'utf-8');
      } catch (e) {}
    }

    io.to('teachers_room').emit('teacher:history_updated', mergedList);
    console.log(`[STORAGE] Restored/merged history: ${mergedList.length} total sessions (${addedCount} new).`);

    res.json({ success: true, count: mergedList.length, added: addedCount, history: mergedList });
  } catch (err) {
    console.error('Failed to restore backup:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Teacher: Manually Archive Current Session Now
app.post('/api/teacher/history/archive-now', requireTeacherAuth, (req, res) => {
  const archived = archiveCurrentExamSession('Manual archive by examiner');
  if (archived) {
    io.to('teachers_room').emit('teacher:history_updated', loadHistory());
    return res.json({ success: true, archived });
  }
  res.status(400).json({ success: false, error: 'No active data to archive.' });
});

// Teacher: Force Submit Student
app.post('/api/teacher/student/force-submit', requireTeacherAuth, (req, res) => {
  const { studentSocketId, reason } = req.body;
  if (students[studentSocketId]) {
    students[studentSocketId].status = 'submitted';
    io.to(studentSocketId).emit('student:force_submitted', { reason: reason || 'Submitted by examiner' });
    io.emit('teacher:students_update', Object.values(students));
    return res.json({ success: true });
  }
  res.status(404).json({ success: false, error: 'Student not found' });
});

// Teacher: Clear and wipe all student sessions from dashboard
app.post('/api/teacher/students/clear-inactive', requireTeacherAuth, (req, res) => {
  const previousCount = Object.keys(students).length;

  // Auto-archive active session before wiping roster so student responses are permanently kept!
  if (previousCount > 0) {
    archiveCurrentExamSession('Archived on roster refresh');
  }

  // Disconnect any currently attached student sockets
  if (io.sockets && io.in) {
    try {
      io.in('students_room').disconnectSockets(true);
    } catch (e) {}
  }

  // WIPE ALL STUDENT SESSIONS COMPLETELY
  students = {};
  persistActiveSessionToDisk();

  // Broadcast empty roster to teachers and refresh history list
  io.to('teachers_room').emit('teacher:students_update', []);
  io.to('teachers_room').emit('teacher:history_updated', loadHistory());
  io.to('teachers_room').emit('teacher:new_notification', {
    type: 'warning',
    title: 'Roster Reset',
    message: `All ${previousCount} student session(s) vanished from the live monitor. Responses are saved in Exam History. Only fresh logins entering from now on will appear.`,
    timestamp: new Date().toLocaleTimeString()
  });

  res.json({
    success: true,
    removedCount: previousCount,
    remainingCount: 0
  });
});

// JSON 404 Fallback for all /api endpoints so clients never receive HTML error pages
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Endpoint not found: ${req.method} ${req.originalUrl}` });
});

// Live continuous auto-sync to disk
let liveHistorySyncTimer = null;
function scheduleLiveHistorySync() {
  if (liveHistorySyncTimer) return;
  liveHistorySyncTimer = setTimeout(() => {
    liveHistorySyncTimer = null;
    try {
      persistActiveSessionToDisk();
      archiveCurrentExamSession('Live continuous auto-save');
    } catch (e) {}
  }, 1000);
}

// ========================
// REAL-TIME SOCKET.IO LOGIC
// ========================
io.on('connection', (socket) => {
  // Check if incoming connection is teacher
  socket.on('teacher:join', () => {
    socket.join('teachers_room');
    socket.emit('exam:state_sync', examState);
    socket.emit('teacher:students_update', Object.values(students));
    socket.emit('teacher:history_updated', loadHistory());
  });

  // Teacher manually clears/resets all student sessions via socket
  socket.on('teacher:clear_inactive', () => {
    if (io.sockets && io.in) {
      try {
        io.in('students_room').disconnectSockets(true);
      } catch (e) {}
    }
    students = {};
    persistActiveSessionToDisk();
    io.to('teachers_room').emit('teacher:students_update', []);
  });

  // Student joining test room (Roll-number based lookup & seamless reconnection)
  socket.on('student:join', (data) => {
    const { name, rollNo, examCode } = data;
    const cleanName = (name || '').trim();
    const cleanRoll = (rollNo || '').trim();

    // Validate exam code
    if (examState.examCode && examCode && examCode.toUpperCase().trim() !== examState.examCode) {
      return socket.emit('student:join_error', { message: 'Invalid Exam Code. Please verify with your teacher.' });
    }

    // Check if this student is already registered by rollNo
    let existingSocketId = null;
    let existingStudent = null;

    for (const [sId, s] of Object.entries(students)) {
      if (s.rollNo && s.rollNo.toLowerCase() === cleanRoll.toLowerCase()) {
        existingSocketId = sId;
        existingStudent = s;
        break;
      }
    }

    if (existingStudent) {
      // Reconnecting student! Clean up old socket key and preserve all answers & progress
      if (existingSocketId !== socket.id) {
        delete students[existingSocketId];
      }
      existingStudent.socketId = socket.id;
      existingStudent.name = cleanName || existingStudent.name;
      existingStudent.status = existingStudent.status === 'submitted' ? 'submitted' : (examState.status === 'active' ? 'in_test' : 'waiting');
      existingStudent.inFullscreen = false;
      existingStudent.outOfFullscreenSince = null;
      students[socket.id] = existingStudent;
    } else {
      // Check if student existed in current session archive
      const history = loadHistory();
      const currentArchive = history.find(h => h.id === examState.sessionId);
      const archivedStudent = currentArchive ? (currentArchive.students || []).find(s => s.rollNo && s.rollNo.toLowerCase() === cleanRoll.toLowerCase()) : null;

      students[socket.id] = {
        socketId: socket.id,
        name: cleanName,
        rollNo: cleanRoll,
        status: archivedStudent?.status === 'submitted' ? 'submitted' : (examState.status === 'active' ? 'in_test' : 'waiting'),
        inFullscreen: false,
        outOfFullscreenSince: null,
        outDurationSeconds: archivedStudent?.outDurationSeconds || 0,
        violations: archivedStudent?.violations ? [...archivedStudent.violations] : [],
        answers: archivedStudent?.answers ? { ...archivedStudent.answers } : {},
        answeredCount: archivedStudent?.answeredCount || 0,
        submittedAt: archivedStudent?.submittedAt || null,
        joinedAt: archivedStudent?.joinedAt || new Date().toLocaleTimeString()
      };
    }

    // Persist active state to disk immediately
    persistActiveSessionToDisk();
    archiveCurrentExamSession('Student joined');

    socket.join('students_room');
    socket.emit('student:joined_success', {
      student: students[socket.id],
      examState,
      serverTime: Date.now()
    });

    // Notify teachers
    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
    io.to('teachers_room').emit('teacher:history_updated', loadHistory());
    io.to('teachers_room').emit('teacher:new_notification', {
      type: 'info',
      title: 'Student Joined',
      message: `${cleanName} (${cleanRoll}) joined the room.`,
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // Student enters fullscreen
  socket.on('student:fullscreen_entered', () => {
    const student = students[socket.id];
    if (!student) return;

    if (student.outOfFullscreenSince) {
      // Calculate how long they were away
      const awayMs = Date.now() - student.outOfFullscreenSince;
      const awaySeconds = Math.max(1, Math.round(awayMs / 1000));
      student.outDurationSeconds += awaySeconds;
      student.outOfFullscreenSince = null;

      const logMsg = `Returned to fullscreen after ${awaySeconds}s (Total away: ${student.outDurationSeconds}s)`;
      student.violations.push({
        type: 'fullscreen_resumed',
        details: logMsg,
        time: new Date().toLocaleTimeString()
      });

      io.to('teachers_room').emit('teacher:new_notification', {
        type: 'warning',
        title: 'Fullscreen Resumed',
        studentName: student.name,
        rollNo: student.rollNo,
        message: `${student.name} returned to fullscreen after ${awaySeconds}s.`,
        timestamp: new Date().toLocaleTimeString()
      });
    }

    student.inFullscreen = true;
    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
  });

  // Student exits fullscreen
  socket.on('student:fullscreen_exited', () => {
    const student = students[socket.id];
    if (!student) return;

    student.inFullscreen = false;
    student.outOfFullscreenSince = Date.now();

    const logEntry = {
      type: 'fullscreen_exit',
      details: 'Exited fullscreen mode',
      time: new Date().toLocaleTimeString()
    };
    student.violations.push(logEntry);

    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
    io.to('teachers_room').emit('teacher:new_notification', {
      type: 'danger',
      title: '⚠️ Fullscreen Exit Flag',
      studentName: student.name,
      rollNo: student.rollNo,
      message: `${student.name} (${student.rollNo}) EXITED full screen mode!`,
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // Student violation event (Tab switch, Blur, Copy, Paste, Screenshot, Devtools)
  socket.on('student:violation', (data) => {
    const student = students[socket.id];
    if (!student) return;

    const { type, details } = data;
    const logEntry = {
      type: type || 'proctor_flag',
      details: details || 'Suspicious activity detected',
      time: new Date().toLocaleTimeString()
    };
    student.violations.push(logEntry);

    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
    io.to('teachers_room').emit('teacher:new_notification', {
      type: 'danger',
      title: `⚠️ Flag: ${type}`,
      studentName: student.name,
      rollNo: student.rollNo,
      message: `${student.name} (${student.rollNo}): ${details}`,
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // Student updates/saves an answer (auto-save draft & live disk persistence)
  socket.on('student:save_answer', (data) => {
    const student = students[socket.id];
    if (!student) return;

    const { questionNumber, answer } = data;
    if (!student.answers) student.answers = {};
    student.answers[questionNumber] = answer;
    student.answeredCount = Object.values(student.answers).filter(a => a && a.trim().length > 0).length;

    // Trigger continuous background auto-save to disk
    scheduleLiveHistorySync();

    // Notify teacher of answering progress
    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
  });

  // Student submits exam (Immediate Disk Archival Guaranteed)
  socket.on('student:submit_exam', (data) => {
    const student = students[socket.id];
    if (!student) return;

    if (data && data.answers) {
      student.answers = data.answers;
    }
    student.answeredCount = Object.values(student.answers || {}).filter(a => a && a.trim().length > 0).length;
    student.status = 'submitted';
    student.submittedAt = new Date().toLocaleTimeString();
    student.inFullscreen = false;

    if (student.outOfFullscreenSince) {
      const awayMs = Date.now() - student.outOfFullscreenSince;
      student.outDurationSeconds += Math.round(awayMs / 1000);
      student.outOfFullscreenSince = null;
    }

    // ALWAYS archive immediately on student submission, regardless of exam status!
    persistActiveSessionToDisk();
    archiveCurrentExamSession('Student submission');
    io.to('teachers_room').emit('teacher:history_updated', loadHistory());

    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
    io.to('teachers_room').emit('teacher:new_notification', {
      type: 'success',
      title: 'Exam Submitted',
      studentName: student.name,
      rollNo: student.rollNo,
      message: `${student.name} (${student.rollNo}) finished and submitted the exam. (${student.answeredCount}/${examState.totalQuestions || 10} questions answered).`,
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // Disconnection
  socket.on('disconnect', () => {
    if (students[socket.id]) {
      const student = students[socket.id];
      student.status = 'disconnected';
      student.inFullscreen = false;

      io.to('teachers_room').emit('teacher:students_update', Object.values(students));
      io.to('teachers_room').emit('teacher:new_notification', {
        type: 'warning',
        title: 'Student Disconnected',
        studentName: student.name,
        rollNo: student.rollNo,
        message: `${student.name} (${student.rollNo}) lost connection.`,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });
});

// Periodic ticker: Update outside fullscreen timer and check exam duration
setInterval(() => {
  let changed = false;
  const now = Date.now();

  // Check if exam is active and timer has concluded
  if (examState.status === 'active' && examState.endTime && now >= examState.endTime) {
    examState.status = 'ended';
    const archived = archiveCurrentExamSession('Exam duration completed');
    io.emit('exam:ended', { message: 'The assessment time duration has concluded.' });
    if (archived) {
      io.to('teachers_room').emit('teacher:history_updated', loadHistory());
    }
  }

  for (const socketId in students) {
    const student = students[socketId];
    if (student.status === 'in_test' && !student.inFullscreen && student.outOfFullscreenSince) {
      // Calculate live seconds
      const currentAwaySeconds = Math.round((now - student.outOfFullscreenSince) / 1000);
      student.liveAwaySeconds = currentAwaySeconds;
      changed = true;
    } else {
      student.liveAwaySeconds = 0;
    }
  }

  if (changed) {
    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
  }
}, 2000);

// Start Server with dynamic fallback if port is in use
const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

function startServer(port) {
  server.listen(port, () => {
    console.log(`===============================================`);
    console.log(`🎓 Proctor Exam Server running on port ${port}`);
    console.log(`🌐 Student URL: http://localhost:${port}/student.html`);
    console.log(`👨‍🏫 Teacher URL: http://localhost:${port}/teacher.html`);
    console.log(`🔑 Teacher Default Password: ${TEACHER_PASSWORD}`);
    console.log(`===============================================`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !process.env.PORT) {
      console.log(`Port ${port} in use, attempting port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(DEFAULT_PORT);
