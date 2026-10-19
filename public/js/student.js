// Student Portal & Proctoring Logic with PDF.js

// Configure PDF.js worker
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

let socket = null;
let currentStudent = null;
let currentExamState = null;
let pdfDoc = null;
let currentZoom = 1.2;
let examCountdownInterval = null;

// Fullscreen Away Time Tracking
let outOfFullscreenStartTime = null;
let awayTimerInterval = null;
let totalCumulativeAwaySeconds = 0;
let violationsCount = 0;
let isExamActive = false;

// Student Answers State
let studentAnswers = {};
let saveAnswerDebounceTimers = {};

// DOM Elements - Screens
const joinScreen = document.getElementById('join-screen');
const waitingScreen = document.getElementById('waiting-screen');
const permissionScreen = document.getElementById('permission-screen');
const examViewport = document.getElementById('exam-viewport');
const fullscreenAlertOverlay = document.getElementById('fullscreen-alert-overlay');
const submittedScreen = document.getElementById('submitted-screen');
const screenshotShield = document.getElementById('screenshot-shield');

// DOM Elements - Forms & Inputs
const joinForm = document.getElementById('student-join-form');
const nameInput = document.getElementById('student-name-input');
const rollInput = document.getElementById('student-roll-input');
const examCodeInput = document.getElementById('student-exam-code-input');
const joinErrorMsg = document.getElementById('join-error-msg');
const joinErrorText = document.getElementById('join-error-text');
const joinBtn = document.getElementById('join-btn');

// DOM Elements - Waiting Screen
const waitingExamTitle = document.getElementById('waiting-exam-title');
const waitingStudentName = document.getElementById('waiting-student-name');
const waitingStudentRoll = document.getElementById('waiting-student-roll');

// DOM Elements - Exam Viewport
const headerExamTitle = document.getElementById('header-exam-title');
const headerStudentInfo = document.getElementById('header-student-info');
const examCountdownDisplay = document.getElementById('exam-countdown-display');
const answeredProgressBadge = document.getElementById('answered-progress-badge');
const answerSheetTotalQs = document.getElementById('answer-sheet-total-qs');
const questionJumpChips = document.getElementById('question-jump-chips');
const answersInputsContainer = document.getElementById('answers-inputs-container');
const pdfScrollContainer = document.getElementById('pdf-scroll-container');
const pdfPagesWrapper = document.getElementById('pdf-pages-wrapper');
const pdfLoadingSpinner = document.getElementById('pdf-loading-spinner');
const zoomInBtn = document.getElementById('zoom-in-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');
const zoomLevelText = document.getElementById('zoom-level-text');
const studentSubmitBtn = document.getElementById('student-submit-btn');

// DOM Elements - Answer Sheet Minimize / Expand Controls
const toggleAnswersPaneBtn = document.getElementById('toggle-answers-pane-btn');
const toggleBtnText = document.getElementById('toggle-btn-text');
const toggleIcon = document.getElementById('toggle-icon');
const minimizeAnswersBtn = document.getElementById('minimize-answers-btn');
const answersPaneContainer = document.getElementById('answers-pane-container');
const floatingOpenAnswersBtn = document.getElementById('floating-open-answers-btn');
const floatingAnsweredCount = document.getElementById('floating-answered-count');
const pdfViewModeHint = document.getElementById('pdf-view-mode-hint');
let isAnswerPaneMinimized = false;

// DOM Elements - Alert Overlay
const awayTimerCounter = document.getElementById('away-timer-counter');
const resumeFullscreenBtn = document.getElementById('resume-fullscreen-btn');
const enterFullscreenBtn = document.getElementById('enter-exam-fullscreen-btn');

// DOM Elements - Submitted Confirmation
const finalAwayDuration = document.getElementById('final-away-duration');
const finalViolationsCount = document.getElementById('final-violations-count');
const finalAnswersCount = document.getElementById('final-answers-count');

// Helper: Format Seconds to MM:SS
function formatDuration(totalSeconds) {
  if (!totalSeconds || totalSeconds < 0) return '00:00';
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// ----------------------------------------------------
// 1. JOIN FORM & SOCKET INITIALIZATION
// ----------------------------------------------------
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinErrorMsg.classList.add('hidden');

  const name = nameInput.value.trim();
  const rollNo = rollInput.value.trim();
  const examCode = examCodeInput.value.trim().toUpperCase();

  if (!name || !rollNo || !examCode) return;

  joinBtn.disabled = true;
  joinBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Connecting...</span>';

  initStudentSocket(name, rollNo, examCode);
});

function initStudentSocket(name, rollNo, examCode) {
  socket = io();

  socket.on('connect', () => {
    socket.emit('student:join', { name, rollNo, examCode });
  });

  socket.on('student:join_error', (data) => {
    joinBtn.disabled = false;
    joinBtn.innerHTML = '<span>Connect to Exam</span> <i class="fa-solid fa-arrow-right"></i>';
    joinErrorText.textContent = data.message || 'Error connecting to exam room.';
    joinErrorMsg.classList.remove('hidden');
    socket.disconnect();
  });

  socket.on('student:joined_success', (data) => {
    currentStudent = data.student;
    currentExamState = data.examState;

    // Check exam status
    if (currentExamState.status === 'active') {
      showPermissionScreen();
    } else {
      showWaitingScreen();
    }
  });

  socket.on('exam:started', (state) => {
    currentExamState = state;
    if (isExamActive) return;
    showPermissionScreen();
  });

  socket.on('exam:ended', () => {
    if (isExamActive) {
      alert('The exam has been concluded by the examiner.');
      finalizeExamSubmission();
    }
  });

  socket.on('student:force_submitted', (data) => {
    alert(`Your exam was submitted by the examiner.\nReason: ${data.reason}`);
    finalizeExamSubmission();
  });
}

function showWaitingScreen() {
  joinScreen.classList.add('hidden');
  permissionScreen.classList.add('hidden');
  examViewport.classList.add('hidden');
  waitingScreen.classList.remove('hidden');

  waitingExamTitle.textContent = currentExamState.title || 'the assessment';
  waitingStudentName.textContent = currentStudent.name;
  waitingStudentRoll.textContent = currentStudent.rollNo;
}

function showPermissionScreen() {
  joinScreen.classList.add('hidden');
  waitingScreen.classList.add('hidden');
  examViewport.classList.add('hidden');
  permissionScreen.classList.remove('hidden');
}

// ----------------------------------------------------
// 2. ENTER FULLSCREEN & COMMENCE EXAM
// ----------------------------------------------------
enterFullscreenBtn.addEventListener('click', async () => {
  try {
    // Request Fullscreen on Document
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    } else if (document.documentElement.webkitRequestFullscreen) {
      await document.documentElement.webkitRequestFullscreen();
    }

    launchExamSession();
  } catch (err) {
    alert('Fullscreen permission is mandatory to take this exam. Please allow fullscreen in your browser.');
    console.error('Fullscreen request rejected:', err);
  }
});

function launchExamSession() {
  isExamActive = true;
  permissionScreen.classList.add('hidden');
  examViewport.classList.remove('hidden');

  headerExamTitle.textContent = currentExamState.title || 'Online Assessment';
  headerStudentInfo.textContent = `${currentStudent.name} (Roll: ${currentStudent.rollNo})`;

  // Notify server of fullscreen entered
  socket.emit('student:fullscreen_entered');

  // Start exam timer
  startExamTimer(currentExamState.endTime);

  // Load and render PDF
  loadExamPDF(currentExamState.pdfUrl);

  // Build Candidate Answer Response Sheet
  buildAnswerInterface(currentExamState.totalQuestions || 10);

  // Setup security traps
  setupProctoringSensors();
}

// ----------------------------------------------------
// 3. PDF.JS CANVAS RENDERING (PURE QUESTION PAPER DISPLAY)
// ----------------------------------------------------
async function loadExamPDF(url) {
  if (!url) {
    pdfLoadingSpinner.innerHTML = '<span class="text-rose-400">Error: No question paper was provided for this exam.</span>';
    return;
  }

  try {
    pdfLoadingSpinner.classList.remove('hidden');
    pdfPagesWrapper.innerHTML = '';

    const loadingTask = pdfjsLib.getDocument(url);
    pdfDoc = await loadingTask.promise;

    pdfLoadingSpinner.classList.add('hidden');
    renderAllPDFPages();
  } catch (err) {
    console.error('Error loading PDF:', err);
    pdfLoadingSpinner.innerHTML = `<span class="text-rose-400">Failed to render question paper: ${err.message}</span>`;
  }
}

async function renderAllPDFPages() {
  if (!pdfDoc) return;
  pdfPagesWrapper.innerHTML = '';

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentZoom });

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    const renderContext = {
      canvasContext: canvas.getContext('2d'),
      viewport: viewport
    };

    pdfPagesWrapper.appendChild(canvas);
    await page.render(renderContext).promise;
  }
}

// Zoom Controls
zoomInBtn.addEventListener('click', () => {
  if (currentZoom < 2.5) {
    currentZoom += 0.2;
    zoomLevelText.textContent = `${Math.round(currentZoom * 100 / 1.2)}%`;
    renderAllPDFPages();
  }
});

zoomOutBtn.addEventListener('click', () => {
  if (currentZoom > 0.6) {
    currentZoom -= 0.2;
    zoomLevelText.textContent = `${Math.round(currentZoom * 100 / 1.2)}%`;
    renderAllPDFPages();
  }
});

// ----------------------------------------------------
// 3.5. CANDIDATE ANSWER RESPONSE INTERFACE
// ----------------------------------------------------
function buildAnswerInterface(totalQuestions) {
  if (answerSheetTotalQs) {
    answerSheetTotalQs.textContent = `${totalQuestions} Questions`;
  }

  if (questionJumpChips) {
    questionJumpChips.innerHTML = '';
  }
  if (answersInputsContainer) {
    answersInputsContainer.innerHTML = '';
  }

  for (let i = 1; i <= totalQuestions; i++) {
    // 1. Navigation Chip
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.id = `chip-q-${i}`;
    chip.className = 'px-2.5 py-1 rounded-md text-[11px] font-mono font-bold bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white border border-slate-700 transition-all shrink-0 cursor-pointer';
    chip.textContent = `Q${i}`;
    chip.onclick = () => jumpToQuestion(i);
    if (questionJumpChips) questionJumpChips.appendChild(chip);

    // 2. Answer Input Card
    const card = document.createElement('div');
    card.id = `q-card-${i}`;
    card.className = 'p-3.5 rounded-xl border border-slate-800 bg-slate-900/60 focus-within:border-indigo-500/70 focus-within:bg-slate-900/90 transition-all';
    card.innerHTML = `
      <div class="flex items-center justify-between mb-2 select-none">
        <label for="answer-q-${i}" class="font-bold text-white text-xs flex items-center space-x-2 cursor-pointer">
          <span class="w-5 h-5 rounded-md bg-indigo-600/30 text-indigo-400 flex items-center justify-center text-[10px] font-mono font-bold">Q${i}</span>
          <span>Question ${i}</span>
        </label>
        <span id="save-status-${i}" class="text-[10px] font-medium text-slate-500">
          Pending
        </span>
      </div>
      <textarea
        id="answer-q-${i}"
        rows="3"
        placeholder="Type answer for Question ${i} (numeric or text)..."
        class="w-full p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-100 placeholder-slate-600 font-mono text-xs focus:outline-none focus:border-indigo-500 transition-all resize-y select-text"
      >${studentAnswers[i] || ''}</textarea>
    `;

    if (answersInputsContainer) answersInputsContainer.appendChild(card);

    // Wire up textarea input
    const textarea = card.querySelector(`#answer-q-${i}`);
    textarea.addEventListener('input', (e) => {
      handleAnswerInput(i, e.target.value);
    });
  }

  updateAnswerProgress(totalQuestions);
}

function handleAnswerInput(qNum, value) {
  studentAnswers[qNum] = value;
  const isAnswered = value && value.trim().length > 0;

  // Update chip styling
  const chip = document.getElementById(`chip-q-${qNum}`);
  if (chip) {
    if (isAnswered) {
      chip.className = 'px-2.5 py-1 rounded-md text-[11px] font-mono font-bold bg-emerald-600 text-white border border-emerald-500 shadow-sm shadow-emerald-500/20 transition-all shrink-0 cursor-pointer';
    } else {
      chip.className = 'px-2.5 py-1 rounded-md text-[11px] font-mono font-bold bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white border border-slate-700 transition-all shrink-0 cursor-pointer';
    }
  }

  // Update card save status
  const statusEl = document.getElementById(`save-status-${qNum}`);
  if (statusEl) {
    if (isAnswered) {
      statusEl.innerHTML = '<span class="text-emerald-400 font-semibold flex items-center space-x-1"><i class="fa-solid fa-check text-[9px]"></i><span>Saved</span></span>';
    } else {
      statusEl.className = 'text-[10px] font-medium text-slate-500';
      statusEl.textContent = 'Pending';
    }
  }

  const totalQuestions = currentExamState?.totalQuestions || 10;
  updateAnswerProgress(totalQuestions);

  // Auto-save draft over WebSockets (debounced 400ms)
  clearTimeout(saveAnswerDebounceTimers[qNum]);
  saveAnswerDebounceTimers[qNum] = setTimeout(() => {
    if (socket) {
      socket.emit('student:save_answer', {
        questionNumber: qNum,
        answer: value
      });
    }
  }, 400);
}

function updateAnswerProgress(totalQuestions) {
  const answeredCount = Object.values(studentAnswers).filter(a => a && a.trim().length > 0).length;
  if (answeredProgressBadge) {
    answeredProgressBadge.textContent = `${answeredCount} / ${totalQuestions} Answered`;
  }
  if (floatingAnsweredCount) {
    floatingAnsweredCount.textContent = `${answeredCount}/${totalQuestions}`;
  }
}

// Toggle & Minimize Candidate Answer Response Interface
function toggleAnswerPane() {
  isAnswerPaneMinimized = !isAnswerPaneMinimized;

  if (isAnswerPaneMinimized) {
    // MINIMIZE ANSWER SHEET
    if (answersPaneContainer) answersPaneContainer.classList.add('hidden');
    if (pdfScrollContainer) {
      pdfScrollContainer.classList.remove('md:w-3/5', 'border-r');
      pdfScrollContainer.classList.add('w-full');
    }
    if (floatingOpenAnswersBtn) floatingOpenAnswersBtn.classList.remove('hidden');

    if (toggleBtnText) toggleBtnText.textContent = 'Show Answers';
    if (toggleIcon) toggleIcon.className = 'fa-solid fa-pen-to-square';
    if (pdfViewModeHint) pdfViewModeHint.textContent = 'Expanded Full Screen View';
  } else {
    // EXPAND ANSWER SHEET
    if (answersPaneContainer) answersPaneContainer.classList.remove('hidden');
    if (pdfScrollContainer) {
      pdfScrollContainer.classList.add('md:w-3/5', 'border-r');
      pdfScrollContainer.classList.remove('w-full');
    }
    if (floatingOpenAnswersBtn) floatingOpenAnswersBtn.classList.add('hidden');

    if (toggleBtnText) toggleBtnText.textContent = 'Minimize Answers';
    if (toggleIcon) toggleIcon.className = 'fa-solid fa-table-columns';
    if (pdfViewModeHint) pdfViewModeHint.textContent = 'Scroll down to navigate pages';
  }

  // Refresh progress count
  const totalQuestions = currentExamState?.totalQuestions || 10;
  updateAnswerProgress(totalQuestions);
}

// Wire up minimize/expand listeners
if (toggleAnswersPaneBtn) toggleAnswersPaneBtn.addEventListener('click', toggleAnswerPane);
if (minimizeAnswersBtn) minimizeAnswersBtn.addEventListener('click', toggleAnswerPane);
if (floatingOpenAnswersBtn) floatingOpenAnswersBtn.addEventListener('click', toggleAnswerPane);

window.jumpToQuestion = function(qNum) {
  // If answers pane is currently minimized, reopen it first!
  if (isAnswerPaneMinimized) {
    toggleAnswerPane();
  }

  const card = document.getElementById(`q-card-${qNum}`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const ta = document.getElementById(`answer-q-${qNum}`);
    if (ta) ta.focus();
  }
};

// ----------------------------------------------------
// 4. EXAM COUNTDOWN TIMER
// ----------------------------------------------------
function startExamTimer(endTime) {
  clearInterval(examCountdownInterval);

  function tick() {
    const remainingMs = endTime - Date.now();
    if (remainingMs <= 0) {
      examCountdownDisplay.textContent = '00:00:00';
      clearInterval(examCountdownInterval);
      alert('Time is up! Your exam is now being auto-submitted.');
      finalizeExamSubmission();
      return;
    }

    const hours = Math.floor(remainingMs / (1000 * 60 * 60));
    const mins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
    const secs = Math.floor((remainingMs % (1000 * 60)) / 1000);

    examCountdownDisplay.textContent = 
      `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  tick();
  examCountdownInterval = setInterval(tick, 1000);
}

// ----------------------------------------------------
// 5. PROCTORING & SECURITY SENSORS (HACKERRANK-GRADE)
// ----------------------------------------------------
function setupProctoringSensors() {
  // A. Fullscreen Exit Detection
  document.addEventListener('fullscreenchange', handleFullscreenStateChange);
  document.addEventListener('webkitfullscreenchange', handleFullscreenStateChange);
  document.addEventListener('mozfullscreenchange', handleFullscreenStateChange);

  // B. Tab Visibility Change (Alt+Tab, Minimizing, Switching Tabs)
  document.addEventListener('visibilitychange', () => {
    if (!isExamActive) return;
    if (document.hidden) {
      flagViolation('tab_switch', 'Switched browser tabs or minimized the assessment window');
    }
  });

  // C. Window Blur (Opening another app / clicking second monitor)
  window.addEventListener('blur', () => {
    if (!isExamActive) return;
    flagViolation('window_blur', 'Exam window lost focus (clicked on another application or display)');
  });

  // D. Copy, Cut, Paste Interception
  document.addEventListener('copy', (e) => {
    if (!isExamActive) return;
    e.preventDefault();
    flagViolation('copy_attempt', 'Attempted to copy exam content');
  });

  document.addEventListener('cut', (e) => {
    if (!isExamActive) return;
    e.preventDefault();
    flagViolation('cut_attempt', 'Attempted to cut exam content');
  });

  document.addEventListener('paste', (e) => {
    if (!isExamActive) return;
    e.preventDefault();
    flagViolation('paste_attempt', 'Attempted to paste into exam environment');
  });

  // E. Right-Click Context Menu Disabled
  document.addEventListener('contextmenu', (e) => {
    if (!isExamActive) return;
    e.preventDefault();
    flagViolation('right_click', 'Attempted right-click context menu');
  });

  // F. Screenshot / PrintScreen Prevention & Detection
  window.addEventListener('keyup', (e) => {
    if (!isExamActive) return;
    if (e.key === 'PrintScreen') {
      shieldScreen();
      flagViolation('screenshot_attempt', 'Pressed PrintScreen key (screenshot blocked)');
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!isExamActive) return;

    // Detect PrintScreen
    if (e.key === 'PrintScreen') {
      shieldScreen();
      flagViolation('screenshot_attempt', 'Pressed PrintScreen key (screenshot blocked)');
    }

    // Detect Ctrl+P / Cmd+P (Print)
    if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      flagViolation('print_attempt', 'Attempted to print question paper (Ctrl+P)');
    }

    // Detect Snipping Tool (Win+Shift+S / Cmd+Shift+3 or 4)
    if (e.shiftKey && (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      shieldScreen();
      flagViolation('screenshot_attempt', 'Attempted snipping tool shortcut');
    }
  });
}

// Fullscreen State Change Handler
function handleFullscreenStateChange() {
  if (!isExamActive) return;

  const isFullscreenNow = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);

  if (!isFullscreenNow) {
    // STUDENT EXITED FULLSCREEN!
    onFullscreenExited();
  } else {
    // STUDENT RETURNED TO FULLSCREEN
    onFullscreenResumed();
  }
}

function onFullscreenExited() {
  outOfFullscreenStartTime = Date.now();
  fullscreenAlertOverlay.classList.remove('hidden');

  // Start live stopwatch counter on overlay
  awayTimerCounter.textContent = '00:00';
  clearInterval(awayTimerInterval);

  awayTimerInterval = setInterval(() => {
    const elapsedSecs = Math.floor((Date.now() - outOfFullscreenStartTime) / 1000);
    awayTimerCounter.textContent = formatDuration(elapsedSecs);
  }, 1000);

  // Notify server immediately
  socket.emit('student:fullscreen_exited');
}

function onFullscreenResumed() {
  fullscreenAlertOverlay.classList.add('hidden');
  clearInterval(awayTimerInterval);

  if (outOfFullscreenStartTime) {
    const awaySecs = Math.max(1, Math.round((Date.now() - outOfFullscreenStartTime) / 1000));
    totalCumulativeAwaySeconds += awaySecs;
    outOfFullscreenStartTime = null;
  }

  // Notify server that fullscreen is restored
  socket.emit('student:fullscreen_entered');
}

// Resume Fullscreen Button Click
resumeFullscreenBtn.addEventListener('click', async () => {
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    } else if (document.documentElement.webkitRequestFullscreen) {
      await document.documentElement.webkitRequestFullscreen();
    }
  } catch (err) {
    console.error('Failed to re-enter fullscreen:', err);
  }
});

// Flash Screen Shield (Blanks out screen briefly on screenshot attempt)
function shieldScreen() {
  screenshotShield.style.display = 'block';
  setTimeout(() => {
    screenshotShield.style.display = 'none';
  }, 600);
}

// Flag Violation Helper
function flagViolation(type, details) {
  violationsCount++;
  if (socket) {
    socket.emit('student:violation', { type, details });
  }
}

// ----------------------------------------------------
// 6. SUBMISSION FLOW
// ----------------------------------------------------
studentSubmitBtn.addEventListener('click', () => {
  if (confirm('Are you sure you want to finish and submit your assessment? This action cannot be undone.')) {
    finalizeExamSubmission();
  }
});

function finalizeExamSubmission() {
  isExamActive = false;
  clearInterval(examCountdownInterval);
  clearInterval(awayTimerInterval);

  // Send answers payload to examiner
  if (socket) {
    socket.emit('student:submit_exam', { answers: studentAnswers });
  }

  // Exit fullscreen cleanly
  if (document.fullscreenElement) {
    try {
      document.exitFullscreen();
    } catch (e) {}
  }

  // Show confirmation screen
  examViewport.classList.add('hidden');
  fullscreenAlertOverlay.classList.add('hidden');
  submittedScreen.classList.remove('hidden');

  const totalQ = currentExamState?.totalQuestions || 10;
  const answered = Object.values(studentAnswers).filter(a => a && a.trim().length > 0).length;
  if (finalAnswersCount) {
    finalAnswersCount.textContent = `${answered} / ${totalQ}`;
  }

  finalAwayDuration.textContent = formatDuration(totalCumulativeAwaySeconds);
  finalViolationsCount.textContent = violationsCount;
}
