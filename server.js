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

  examState.status = 'active';
  examState.startTime = now;
  examState.endTime = now + durationMs;

  io.emit('exam:started', {
    ...examState,
    serverTime: now
  });

  res.json({ success: true, examState });
});

// Teacher: End Exam
app.post('/api/teacher/exam/end', requireTeacherAuth, (req, res) => {
  examState.status = 'ended';
  io.emit('exam:ended', { message: 'The exam has been concluded by the examiner.' });
  res.json({ success: true, examState });
});

// Teacher: Get Student Answers
app.get('/api/teacher/student-answers/:socketId', requireTeacherAuth, (req, res) => {
  const student = students[req.params.socketId];
  if (!student) {
    return res.status(404).json({ success: false, error: 'Student not found' });
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
      totalQuestions: examState.totalQuestions,
      outDurationSeconds: student.outDurationSeconds,
      violations: student.violations,
      submittedAt: student.submittedAt
    }
  });
});

// Teacher: Export All Submissions to CSV
app.get('/api/teacher/export-submissions', requireTeacherAuth, (req, res) => {
  const studentList = Object.values(students);
  const totalQ = examState.totalQuestions || 10;

  // Build CSV Header
  let header = ['Student Name', 'Roll Number', 'Status', 'Total Away (Seconds)', 'Total Flags', 'Questions Answered'];
  for (let i = 1; i <= totalQ; i++) {
    header.push(`Q${i} Answer`);
  }

  const rows = [header.join(',')];

  studentList.forEach(s => {
    const row = [
      `"${(s.name || '').replace(/"/g, '""')}"`,
      `"${(s.rollNo || '').replace(/"/g, '""')}"`,
      `"${s.status || ''}"`,
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

// ========================
// REAL-TIME SOCKET.IO LOGIC
// ========================
io.on('connection', (socket) => {
  // Check if incoming connection is teacher
  socket.on('teacher:join', () => {
    socket.join('teachers_room');
    socket.emit('exam:state_sync', examState);
    socket.emit('teacher:students_update', Object.values(students));
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

// Periodic ticker: Update outside fullscreen timer for students currently out of fullscreen
setInterval(() => {
  let changed = false;
  const now = Date.now();

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
