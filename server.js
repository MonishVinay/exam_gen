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

// Ensure data folder and exam history file exist
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const historyFilePath = path.join(dataDir, 'exam-history.json');
if (!fs.existsSync(historyFilePath)) {
  fs.writeFileSync(historyFilePath, JSON.stringify([], null, 2), 'utf-8');
}

function loadHistory() {
  try {
    if (fs.existsSync(historyFilePath)) {
      const content = fs.readFileSync(historyFilePath, 'utf-8');
      return JSON.parse(content || '[]');
    }
  } catch (err) {
    console.error('Error reading history file:', err);
  }
  return [];
}

function saveHistory(historyList) {
  try {
    fs.writeFileSync(historyFilePath, JSON.stringify(historyList, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Error writing history file:', err);
    return false;
  }
}

// Helper: Archive Current Exam Session with all student responses
function archiveCurrentExamSession(reason = 'Exam concluded') {
  const studentList = Object.values(students);
  if (studentList.length === 0 && !examState.pdfUrl) {
    return null;
  }

  const history = loadHistory();
  const sessionId = examState.sessionId || `exam-${examState.startTime || Date.now()}`;

  const formattedStudents = studentList.map(s => ({
    socketId: s.socketId,
    name: s.name,
    rollNo: s.rollNo,
    status: s.status,
    answers: s.answers || {},
    answeredCount: Object.values(s.answers || {}).filter(a => a && a.trim().length > 0).length,
    outDurationSeconds: (s.outDurationSeconds || 0) + (s.liveAwaySeconds || 0),
    violations: s.violations || [],
    submittedAt: s.submittedAt || (s.status === 'submitted' ? 'Submitted' : (examState.status === 'ended' ? 'Concluded' : 'In Progress')),
    joinedAt: s.joinedAt
  }));

  const historyEntry = {
    id: sessionId,
    title: examState.title || 'General Assessment',
    subject: examState.subject || '',
    examCode: examState.examCode || 'EXAM101',
    totalQuestions: examState.totalQuestions || 10,
    durationMinutes: examState.durationMinutes || 60,
    pdfFileName: examState.pdfFileName || '',
    pdfUrl: examState.pdfUrl || '',
    startTime: examState.startTime,
    endTime: examState.endTime,
    endedAt: new Date().toISOString(),
    formattedDate: new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }),
    reason: reason,
    totalStudents: formattedStudents.length,
    submittedCount: formattedStudents.filter(s => s.status === 'submitted' || s.submittedAt).length,
    students: formattedStudents
  };

  const existingIdx = history.findIndex(h => h.id === sessionId);
  if (existingIdx >= 0) {
    history[existingIdx] = historyEntry;
  } else {
    history.unshift(historyEntry);
  }

  saveHistory(history);
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
    examState.durationMinutes = parseInt(durationMinutes, 10) || 60;
    examState.totalQuestions = Math.max(1, parseInt(totalQuestions, 10) || 10);
    examState.examCode = (examCode || 'EXAM101').toUpperCase().trim();
    examState.status = 'created';
    examState.startTime = null;
    examState.endTime = null;

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

  io.to('teachers_room').emit('teacher:history_updated', history);
  res.json({ success: true, deleted: initialLen > history.length });
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
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `Endpoint not found: ${req.method} ${req.originalUrl}` });
});

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
    io.to('teachers_room').emit('teacher:students_update', []);
  });

  // Student joining test room
  socket.on('student:join', (data) => {
    const { name, rollNo, examCode } = data;

    // Validate exam code
    if (examState.examCode && examCode && examCode.toUpperCase().trim() !== examState.examCode) {
      return socket.emit('student:join_error', { message: 'Invalid Exam Code. Please verify with your teacher.' });
    }

    students[socket.id] = {
      socketId: socket.id,
      name: name.trim(),
      rollNo: rollNo.trim(),
      status: examState.status === 'active' ? 'in_test' : 'waiting',
      inFullscreen: false,
      outOfFullscreenSince: null,
      outDurationSeconds: 0,
      violations: [],
      answers: {},
      answeredCount: 0,
      submittedAt: null,
      joinedAt: new Date().toLocaleTimeString()
    };

    socket.join('students_room');
    socket.emit('student:joined_success', {
      student: students[socket.id],
      examState,
      serverTime: Date.now()
    });

    // Notify teachers
    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
    io.to('teachers_room').emit('teacher:new_notification', {
      type: 'info',
      title: 'Student Joined',
      message: `${name} (${rollNo}) joined the room.`,
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

  // Student updates/saves an answer (auto-save draft)
  socket.on('student:save_answer', (data) => {
    const student = students[socket.id];
    if (!student) return;

    const { questionNumber, answer } = data;
    if (!student.answers) student.answers = {};
    student.answers[questionNumber] = answer;
    student.answeredCount = Object.values(student.answers).filter(a => a && a.trim().length > 0).length;

    // Notify teacher of answering progress
    io.to('teachers_room').emit('teacher:students_update', Object.values(students));
  });

  // Student submits exam
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

    // Auto-update history archive if exam is ended
    if (examState.status === 'ended') {
      archiveCurrentExamSession('Exam concluded');
      io.to('teachers_room').emit('teacher:history_updated', loadHistory());
    }

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
