// Teacher Console Logic & Real-Time Socket Connection

let socket = null;
let currentExamState = null;
let studentsList = [];
let examCountdownInterval = null;

// DOM Elements
const loginContainer = document.getElementById('login-container');
const dashboardContainer = document.getElementById('dashboard-container');
const loginForm = document.getElementById('teacher-login-form');
const passwordInput = document.getElementById('teacher-password-input');
const loginErrorMsg = document.getElementById('login-error-msg');
const logoutBtn = document.getElementById('logout-btn');

// Exam Config Form Elements
const examConfigForm = document.getElementById('exam-config-form');
const examTitleInput = document.getElementById('exam-title-input');
const examSubjectInput = document.getElementById('exam-subject-input');
const examDurationInput = document.getElementById('exam-duration-input');
const examQuestionsInput = document.getElementById('exam-questions-input');
const examCodeInput = document.getElementById('exam-code-input');
const examPdfFile = document.getElementById('exam-pdf-file');
const currentPdfStatus = document.getElementById('current-pdf-status');
const startExamBtn = document.getElementById('start-exam-btn');
const endExamBtn = document.getElementById('end-exam-btn');

// Dashboard Elements
const examStatusBadge = document.getElementById('exam-status-badge');
const currentExamMeta = document.getElementById('current-exam-meta');
const liveTimerContainer = document.getElementById('live-timer-container');
const dashboardCountdown = document.getElementById('dashboard-countdown');
const displayShareCode = document.getElementById('display-share-code');
const rosterCount = document.getElementById('roster-count');
const studentRosterBody = document.getElementById('student-roster-body');
const activityFeed = document.getElementById('activity-feed');
const emptyFeedPlaceholder = document.getElementById('empty-feed-placeholder');

// KPI Counters
const kpiTotalStudents = document.getElementById('kpi-total-students');
const kpiInFullscreen = document.getElementById('kpi-in-fullscreen');
const kpiOutFullscreen = document.getElementById('kpi-out-fullscreen');
const kpiTotalFlags = document.getElementById('kpi-total-flags');

// Modal Elements - Violations
const violationModal = document.getElementById('violation-modal');
const modalStudentName = document.getElementById('modal-student-name');
const modalStudentRoll = document.getElementById('modal-student-roll');
const modalTotalAway = document.getElementById('modal-total-away');
const modalTotalFlags = document.getElementById('modal-total-flags');
const modalViolationsList = document.getElementById('modal-violations-list');
const closeModalBtn = document.getElementById('close-modal-btn');

// Modal Elements - Submitted Answers
const answersModal = document.getElementById('answers-modal');
const answersModalStudentName = document.getElementById('answers-modal-student-name');
const answersModalStudentMeta = document.getElementById('answers-modal-student-meta');
const answersModalCount = document.getElementById('answers-modal-count');
const answersModalAway = document.getElementById('answers-modal-away');
const answersModalFlags = document.getElementById('answers-modal-flags');
const answersModalList = document.getElementById('answers-modal-list');
const closeAnswersModalBtn = document.getElementById('close-answers-modal-btn');

// Initialize Check
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/teacher/auth-status');
    const data = await res.json();
    if (data.authenticated) {
      showDashboard();
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin();
  }
});

// Helper: Format Seconds to MM:SS
function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds < 0) return '00:00';
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Show / Hide Views
function showLogin() {
  loginContainer.classList.remove('hidden');
  dashboardContainer.classList.add('hidden');
}

function showDashboard() {
  loginContainer.classList.add('hidden');
  dashboardContainer.classList.remove('hidden');
  initSocket();
  fetchExamState();
}

// Teacher Login
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginErrorMsg.classList.add('hidden');

  const password = passwordInput.value;

  try {
    const res = await fetch('/api/teacher/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await res.json();
    if (data.success) {
      showDashboard();
    } else {
      loginErrorMsg.classList.remove('hidden');
    }
  } catch (err) {
    loginErrorMsg.classList.remove('hidden');
  }
});

// Logout
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/teacher/logout', { method: 'POST' });
  if (socket) socket.disconnect();
  showLogin();
});

// Fetch Initial State
async function fetchExamState() {
  try {
    const res = await fetch('/api/exam/state');
    const data = await res.json();
    updateExamUI(data.examState);
  } catch (err) {
    console.error('Failed to fetch exam state:', err);
  }
}

// Initialize Socket.io Connection
function initSocket() {
  if (socket) return;

  socket = io();

  socket.on('connect', () => {
    socket.emit('teacher:join');
  });

  socket.on('exam:state_sync', (state) => {
    updateExamUI(state);
  });

  socket.on('exam:started', (state) => {
    updateExamUI(state);
    addFeedNotification({
      type: 'success',
      title: 'Exam Commenced',
      message: `The test "${state.title}" has officially begun. Duration: ${state.durationMinutes} mins.`
    });
  });

  socket.on('exam:ended', (data) => {
    fetchExamState();
    addFeedNotification({
      type: 'warning',
      title: 'Exam Ended',
      message: data.message || 'Exam was concluded.'
    });
  });

  socket.on('exam:updated', (state) => {
    updateExamUI(state);
  });

  socket.on('teacher:students_update', (updatedStudents) => {
    studentsList = updatedStudents;
    renderStudentsRoster();
  });

  socket.on('teacher:new_notification', (notif) => {
    addFeedNotification(notif);
  });
}

// Update Exam UI based on state
function updateExamUI(state) {
  currentExamState = state;
  if (!state) return;

  examTitleInput.value = state.title || '';
  examSubjectInput.value = state.subject || '';
  examDurationInput.value = state.durationMinutes || 60;
  if (examQuestionsInput) {
    examQuestionsInput.value = state.totalQuestions || 10;
  }
  examCodeInput.value = state.examCode || 'EXAM101';
  displayShareCode.textContent = state.examCode || 'EXAM101';

  if (state.pdfFileName) {
    currentPdfStatus.innerHTML = `<span class="text-emerald-400 font-semibold"><i class="fa-solid fa-file-pdf mr-1"></i> ${state.pdfFileName}</span>`;
  } else {
    currentPdfStatus.textContent = 'No PDF uploaded yet';
  }

  const questionsCount = state.totalQuestions || 10;

  // Update status badge
  if (state.status === 'active') {
    examStatusBadge.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-pulse';
    examStatusBadge.textContent = 'In Progress (Active)';
    currentExamMeta.textContent = `${state.title} (${state.examCode}) • ${state.durationMinutes} mins • ${questionsCount} Qs`;
    
    startExamBtn.classList.add('hidden');
    endExamBtn.classList.remove('hidden');

    startExamCountdown(state.endTime);
  } else if (state.status === 'created') {
    examStatusBadge.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/30';
    examStatusBadge.textContent = 'Ready to Start';
    currentExamMeta.textContent = `${state.title} (${state.examCode}) • ${questionsCount} Qs • PDF Loaded`;
    
    startExamBtn.classList.remove('hidden');
    endExamBtn.classList.add('hidden');
    liveTimerContainer.classList.add('hidden');
    clearInterval(examCountdownInterval);
  } else if (state.status === 'ended') {
    examStatusBadge.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30';
    examStatusBadge.textContent = 'Concluded';
    currentExamMeta.textContent = `${state.title} (${state.examCode}) • Finished`;
    
    startExamBtn.classList.remove('hidden');
    startExamBtn.textContent = 'Restart Exam';
    endExamBtn.classList.add('hidden');
    liveTimerContainer.classList.add('hidden');
    clearInterval(examCountdownInterval);
  } else {
    examStatusBadge.className = 'text-[11px] px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
    examStatusBadge.textContent = 'Idle';
    currentExamMeta.textContent = 'No active exam configuration';
    
    startExamBtn.classList.remove('hidden');
    endExamBtn.classList.add('hidden');
    liveTimerContainer.classList.add('hidden');
    clearInterval(examCountdownInterval);
  }
}

// Exam Countdown Timer
function startExamCountdown(endTime) {
  liveTimerContainer.classList.remove('hidden');
  clearInterval(examCountdownInterval);

  function update() {
    const remainingMs = endTime - Date.now();
    if (remainingMs <= 0) {
      dashboardCountdown.textContent = '00:00:00';
      clearInterval(examCountdownInterval);
      return;
    }

    const hours = Math.floor(remainingMs / (1000 * 60 * 60));
    const mins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
    const secs = Math.floor((remainingMs % (1000 * 60)) / 1000);

    dashboardCountdown.textContent = 
      `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  update();
  examCountdownInterval = setInterval(update, 1000);
}

// Save Exam Setup & Upload PDF
examConfigForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = new FormData();
  formData.append('title', examTitleInput.value);
  formData.append('subject', examSubjectInput.value);
  formData.append('durationMinutes', examDurationInput.value);
  formData.append('totalQuestions', examQuestionsInput.value);
  formData.append('examCode', examCodeInput.value);

  if (examPdfFile.files.length > 0) {
    formData.append('examPdf', examPdfFile.files[0]);
  }

  try {
    const saveBtn = document.getElementById('save-exam-btn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Uploading...</span>';

    const res = await fetch('/api/teacher/exam', {
      method: 'POST',
      body: formData
    });

    const data = await res.json();
    if (data.success) {
      updateExamUI(data.examState);
      alert('Exam details and PDF saved successfully!');
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to upload exam: ${err.message}`);
  } finally {
    const saveBtn = document.getElementById('save-exam-btn');
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> <span>Save & Upload PDF</span>';
  }
});

// Start Exam Button
startExamBtn.addEventListener('click', async () => {
  if (!currentExamState || !currentExamState.pdfUrl) {
    alert('Please upload a PDF question paper first before starting the exam.');
    return;
  }

  if (confirm(`Start the exam "${currentExamState.title}" for all students now? Duration: ${currentExamState.durationMinutes} mins.`)) {
    try {
      const res = await fetch('/api/teacher/exam/start', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        alert(data.error);
      }
    } catch (err) {
      alert('Failed to start exam: ' + err.message);
    }
  }
});

// End Exam Button
endExamBtn.addEventListener('click', async () => {
  if (confirm('Are you sure you want to conclude the exam? All student assessments will be finalized.')) {
    try {
      await fetch('/api/teacher/exam/end', { method: 'POST' });
    } catch (err) {
      alert('Failed to end exam: ' + err.message);
    }
  }
});

// Render Real-time Student Roster Table
function renderStudentsRoster() {
  rosterCount.textContent = `${studentsList.length} Connected`;
  kpiTotalStudents.textContent = studentsList.length;

  let inFullCount = 0;
  let outFullCount = 0;
  let totalViolations = 0;

  if (studentsList.length === 0) {
    studentRosterBody.innerHTML = `
      <tr id="empty-roster-row">
        <td colspan="7" class="py-12 text-center text-slate-500 text-sm">
          <i class="fa-regular fa-folder-open text-3xl mb-3 block text-slate-600"></i>
          No students have joined this test room yet.<br>
          <span class="text-xs text-slate-600">Share Exam Code <strong class="text-slate-400">${currentExamState?.examCode || 'EXAM101'}</strong> with students.</span>
        </td>
      </tr>
    `;
    kpiInFullscreen.textContent = '0';
    kpiOutFullscreen.textContent = '0';
    kpiTotalFlags.textContent = '0';
    return;
  }

  studentRosterBody.innerHTML = '';

  studentsList.forEach((student) => {
    totalViolations += student.violations.length;

    if (student.status === 'in_test') {
      if (student.inFullscreen) {
        inFullCount++;
      } else {
        outFullCount++;
      }
    }

    // Fullscreen Status Badge
    let fullscreenBadge = '';
    if (student.status === 'submitted') {
      fullscreenBadge = `<span class="px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">Exam Submitted</span>`;
    } else if (student.inFullscreen) {
      fullscreenBadge = `<span class="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center w-fit space-x-1.5"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span><span>In Fullscreen</span></span>`;
    } else {
      const liveSeconds = student.liveAwaySeconds || 0;
      fullscreenBadge = `<span class="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 pulse-alert flex items-center w-fit space-x-1.5 font-bold"><i class="fa-solid fa-triangle-exclamation"></i><span>OUT: Away for ${liveSeconds}s</span></span>`;
    }

    // Status Badge
    let statusBadge = '';
    if (student.status === 'in_test') {
      statusBadge = `<span class="text-blue-400 font-semibold">In Exam</span>`;
    } else if (student.status === 'waiting') {
      statusBadge = `<span class="text-amber-400">Waiting</span>`;
    } else if (student.status === 'submitted') {
      statusBadge = `<span class="text-emerald-400 font-bold">Submitted</span>`;
    } else {
      statusBadge = `<span class="text-slate-500">Offline</span>`;
    }

    // Cumulative time away (including live if currently out)
    const totalAwaySecs = student.outDurationSeconds + (student.liveAwaySeconds || 0);

    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/40 transition-colors';
    tr.innerHTML = `
      <td class="py-3 px-3">
        <div class="font-bold text-white">${student.name}</div>
        <div class="text-[11px] font-mono text-slate-400">Roll: ${student.rollNo}</div>
      </td>
      <td class="py-3 px-3">${statusBadge}</td>
      <td class="py-3 px-3">${fullscreenBadge}</td>
      <td class="py-3 px-3 text-center font-mono font-bold ${totalAwaySecs > 0 ? 'text-rose-400' : 'text-slate-400'}">
        ${formatDuration(totalAwaySecs)}
      </td>
      <td class="py-3 px-3 text-center">
        <span class="px-2 py-0.5 rounded-full font-mono text-[11px] font-bold ${student.answeredCount > 0 ? 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20' : 'bg-slate-800 text-slate-500'}">
          ${student.answeredCount || 0} / ${currentExamState?.totalQuestions || 10}
        </span>
      </td>
      <td class="py-3 px-3 text-center">
        <span class="px-2 py-0.5 rounded-full font-bold text-xs ${student.violations.length > 0 ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-slate-800 text-slate-500'}">
          ${student.violations.length}
        </span>
      </td>
      <td class="py-3 px-3 text-right space-x-1.5">
        <button onclick="viewStudentAnswers('${student.socketId}', '${student.rollNo}')" class="px-2 py-1 rounded bg-indigo-900/40 hover:bg-indigo-800 text-indigo-300 hover:text-white text-[11px] border border-indigo-800/50 transition-colors cursor-pointer" title="Review answers submitted by student">
          <i class="fa-solid fa-file-pen mr-1"></i> Answers
        </button>
        <button onclick="inspectStudent('${student.socketId}')" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-[11px] border border-slate-700 transition-colors" title="Audit integrity logs">
          <i class="fa-solid fa-shield-halved mr-1"></i> Audit
        </button>
        ${student.status === 'in_test' ? `
          <button onclick="forceSubmitStudent('${student.socketId}', '${student.name}')" class="px-2 py-1 rounded bg-rose-900/40 hover:bg-rose-800 text-rose-300 hover:text-white text-[11px] border border-rose-800/50 transition-colors" title="Force submit exam">
            <i class="fa-solid fa-ban mr-1"></i> Terminate
          </button>
        ` : ''}
      </td>
    `;
    studentRosterBody.appendChild(tr);
  });

  kpiInFullscreen.textContent = inFullCount;
  kpiOutFullscreen.textContent = outFullCount;
  kpiTotalFlags.textContent = totalViolations;
}

// Add Item to Live Security Activity Feed
function addFeedNotification(notif) {
  if (emptyFeedPlaceholder) emptyFeedPlaceholder.remove();

  const timestamp = notif.timestamp || new Date().toLocaleTimeString();
  let iconClass = 'fa-solid fa-info text-blue-400';
  let borderClass = 'border-slate-800';

  if (notif.type === 'danger') {
    iconClass = 'fa-solid fa-triangle-exclamation text-rose-400';
    borderClass = 'border-rose-900/50 bg-rose-950/20';
  } else if (notif.type === 'warning') {
    iconClass = 'fa-solid fa-clock-rotate-left text-amber-400';
    borderClass = 'border-amber-900/50 bg-amber-950/20';
  } else if (notif.type === 'success') {
    iconClass = 'fa-solid fa-circle-check text-emerald-400';
    borderClass = 'border-emerald-900/50 bg-emerald-950/20';
  }

  const card = document.createElement('div');
  card.className = `p-3 rounded-xl border ${borderClass} text-xs space-y-1 transition-all animate-fadeIn`;
  card.innerHTML = `
    <div class="flex items-center justify-between">
      <div class="flex items-center space-x-1.5 font-bold text-white">
        <i class="${iconClass}"></i>
        <span>${notif.title || 'Security Event'}</span>
      </div>
      <span class="text-[10px] font-mono text-slate-500">${timestamp}</span>
    </div>
    <p class="text-slate-300 text-[11px] leading-relaxed">${notif.message}</p>
  `;

  activityFeed.prepend(card);

  // Keep feed max 50 items
  if (activityFeed.children.length > 50) {
    activityFeed.removeChild(activityFeed.lastChild);
  }
}

// Open Student Audit Modal
window.inspectStudent = function(socketId) {
  const student = studentsList.find(s => s.socketId === socketId);
  if (!student) return;

  modalStudentName.textContent = student.name;
  modalStudentRoll.textContent = `Roll No: ${student.rollNo} • Status: ${student.status}`;
  
  const totalAway = student.outDurationSeconds + (student.liveAwaySeconds || 0);
  modalTotalAway.textContent = formatDuration(totalAway);
  modalTotalFlags.textContent = student.violations.length;

  if (student.violations.length === 0) {
    modalViolationsList.innerHTML = `<p class="text-slate-500 text-xs py-4 text-center">No violations recorded for this student.</p>`;
  } else {
    modalViolationsList.innerHTML = student.violations.map(v => `
      <div class="p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/60 flex items-center justify-between text-xs">
        <div>
          <span class="font-semibold text-rose-400">[${v.type}]</span>
          <span class="text-slate-200 ml-1.5">${v.details}</span>
        </div>
        <span class="text-[10px] font-mono text-slate-400">${v.time}</span>
      </div>
    `).reverse().join('');
  }

  violationModal.classList.remove('hidden');
};

// Close Modal
closeModalBtn.addEventListener('click', () => {
  violationModal.classList.add('hidden');
});

// Force Submit Student
window.forceSubmitStudent = async function(socketId, name) {
  if (confirm(`Are you sure you want to force-submit and terminate ${name}'s exam?`)) {
    try {
      await fetch('/api/teacher/student/force-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentSocketId: socketId, reason: 'Examiner forced submission due to integrity concerns' })
      });
    } catch (err) {
      alert('Failed to force submit: ' + err.message);
    }
  }
};

// Helper: Escape HTML to display student answers safely
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Open Student Submitted Answers Review Modal (Synchronous & Instantaneous)
window.viewStudentAnswers = function(socketId, rollNo) {
  try {
    // 1. Instant lookup in active student list (by socketId or rollNo)
    let student = null;
    if (socketId) {
      student = studentsList.find(s => s.socketId === socketId);
    }
    if (!student && rollNo) {
      student = studentsList.find(s => s.rollNo === rollNo);
    }

    if (!student) {
      alert('Student record not found in the active session roster.');
      return;
    }

    answersModalStudentName.textContent = `${student.name}'s Answer Sheet`;
    answersModalStudentMeta.textContent = `Roll No: ${student.rollNo} • Status: ${(student.status || 'in_test').toUpperCase()} ${student.submittedAt ? '• Submitted: ' + student.submittedAt : ''}`;
    
    const totalQ = currentExamState?.totalQuestions || student.totalQuestions || 10;
    const answersObj = student.answers || {};
    const answeredCount = Object.values(answersObj).filter(a => a && a.trim().length > 0).length;

    answersModalCount.textContent = `${answeredCount} / ${totalQ} answered`;
    answersModalAway.textContent = formatDuration(student.outDurationSeconds || 0);
    answersModalFlags.textContent = (student.violations || []).length;

    let html = '';

    for (let i = 1; i <= totalQ; i++) {
      const ans = answersObj[i];
      const isAnswered = ans && ans.trim().length > 0;

      html += `
        <div class="p-3.5 rounded-xl border ${isAnswered ? 'border-slate-700 bg-slate-800/70' : 'border-slate-800 bg-slate-900/60'}">
          <div class="flex items-center justify-between mb-2">
            <span class="font-bold text-white flex items-center space-x-2">
              <span class="w-6 h-6 rounded-md bg-indigo-600/30 text-indigo-400 flex items-center justify-center text-xs font-mono font-bold">Q${i}</span>
              <span class="text-xs">Question ${i}</span>
            </span>
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${isAnswered ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-800 text-slate-500 border border-slate-700'}">
              ${isAnswered ? 'Answered ✓' : 'Not Answered'}
            </span>
          </div>
          <div class="p-3 rounded-lg bg-slate-950 border border-slate-800/80 font-mono text-xs text-slate-200 whitespace-pre-wrap leading-relaxed select-text min-h-[44px]">
            ${isAnswered ? escapeHtml(ans) : '<span class="text-slate-600 italic">No answer provided by candidate.</span>'}
          </div>
        </div>
      `;
    }

    answersModalList.innerHTML = html;
    answersModal.classList.remove('hidden');
  } catch (err) {
    console.error('Error rendering answers modal:', err);
    alert('Error loading answers: ' + err.message);
  }
};

// Close Answers Modal
if (closeAnswersModalBtn) {
  closeAnswersModalBtn.addEventListener('click', () => {
    answersModal.classList.add('hidden');
  });
}

// Close Modal on Dark Backdrop Click
if (answersModal) {
  answersModal.addEventListener('click', (e) => {
    if (e.target === answersModal) {
      answersModal.classList.add('hidden');
    }
  });
}

// Close Modal on Esc Key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (answersModal) answersModal.classList.add('hidden');
    if (violationModal) violationModal.classList.add('hidden');
  }
});

// Refresh & Clear All Sessions (Vanish All Student Records)
const refreshClearInactiveBtn = document.getElementById('refresh-clear-inactive-btn');
const refreshIcon = document.getElementById('refresh-icon');

if (refreshClearInactiveBtn) {
  refreshClearInactiveBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all student sessions from the dashboard? All current sessions will vanish and only new candidate logins will be shown.')) {
      return;
    }

    if (refreshIcon) refreshIcon.classList.add('fa-spin');

    // Immediately vanish local list for instant UI feedback!
    studentsList = [];
    renderStudentsRoster();

    try {
      // 1. Emit via socket for instant zero-latency purge across all teacher screens
      if (socket) {
        socket.emit('teacher:clear_inactive');
      }

      // 2. Call backend API to wipe all sessions
      await fetch('/api/teacher/students/clear-inactive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      // Refresh exam state and KPI
      fetchExamState();
    } catch (err) {
      console.error('Failed to clear sessions:', err);
    } finally {
      setTimeout(() => {
        if (refreshIcon) refreshIcon.classList.remove('fa-spin');
      }, 500);
    }
  });
}


