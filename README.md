# 🛡️ ProctorLock - Online Assessment & Proctoring System

A modern, lightweight proctoring platform designed for online tests and exams (inspired by HackerRank/Mettl). Built for 1-click deployment on **Render**, **Railway**, or any Node.js environment.

---

## 🌟 Key Features

### 👨‍🏫 Teacher / Examiner Console (`/teacher.html`)
- **Password-Protected Authentication:** Secure access controlled via `TEACHER_PASSWORD`.
- **Question Paper Upload:** Upload PDF question papers (rendered cleanly via Mozilla PDF.js without browser print/download popups).
- **Exam Configuration:** Set Exam Title, Course Code, Custom Exam Code, Duration (mins), and **Total Number of Questions** (e.g. 10, 25, 50).
- **Exam Lifecycle Control:** "Start Exam" (opens exam for students & initiates countdown) and "Conclude Exam".
- **Real-Time Student Proctoring Monitor:**
  - Live indicator: Whether the student is **Currently In Fullscreen** or **OUT of Fullscreen**.
  - **Live Outside Fullscreen Stopwatch:** Tracks and displays exact seconds the student has spent outside fullscreen.
  - **Total Cumulative Away Time:** Permanent audit of duration away formatted as `MM:SS`.
  - **Live Answering Progress:** Real-time counter of answered questions (e.g. `8 / 10 Answered`).
  - **Candidate Answer Review:** Click "Answers" to view student's typed responses for each question (numeric, formulas, text).
  - **CSV Export:** 1-click download of all student responses and proctoring stats in Excel-ready CSV format.
  - **Real-Time Security Violation Feed:** Instant alerts for:
    - Exiting Fullscreen Mode
    - Tab Switching / Window Minimize (`visibilitychange`)
    - Window Focus Loss / Multi-monitor / App switching (`window.blur`)
    - Attempted Copy / Cut / Paste / Right-Click
    - Attempted Screenshot (`PrintScreen`, Snipping Tool `Win+Shift+S`)
  - **Examiner Actions:** Full audit log inspection and "Force Submit" option for cheating violations.

### 🎓 Student Interface (`/student.html`)
- **Simple Join Portal:** Enter Name, Roll No / ID, and Exam Code.
- **Waiting Room:** Automatically pauses until the examiner officially starts the test.
- **Proctoring Agreement:** Explains mandatory fullscreen and anti-cheat policies.
- **Side-by-Side Exam Environment:**
  - **Left Pane (PDF Question Paper):** Mozilla PDF.js canvas viewer with page navigation and zoom.
  - **Top Sticky Bar:** High-visibility countdown timer + answered counter + submit button.
  - **Right Pane (Candidate Answer Sheet):**
    - Dynamically generates response boxes for Question 1 through Question N.
    - Quick-jump navigation chips (`[Q1]`, `[Q2]`...) with visual answered badges.
    - Allows typing any type of answer: **numbers, text, formulas, or alphabets**.
    - Auto-saves drafts as you type.
- **Instant Fullscreen Exit Trap:**
  - If <kbd>Esc</kbd> or exit is pressed: PDF is immediately obscured behind a high-alert modal.
  - A live timer begins ticking: *"Duration Outside Fullscreen: 00:08"*.
  - Teacher is notified in 0 milliseconds via WebSockets.
  - Button to re-enter fullscreen and resume.
- **Answer Submission:** On submission or countdown expiry, all typed answers are transmitted to the teacher in real-time.

---

## 🚀 Running Locally

1. **Install dependencies:**
   ```bash
   cd proctor-exam-platform
   npm install
   ```

2. **Start the server:**
   ```bash
   npm start
   ```

3. **Open in browser:**
   - **Main Portal:** [http://localhost:3000](http://localhost:3000)
   - **Teacher Console:** [http://localhost:3000/teacher.html](http://localhost:3000/teacher.html) *(Default password: `teacher123`)*
   - **Student Portal:** [http://localhost:3000/student.html](http://localhost:3000/student.html)

---

## ☁️ Deploying on Render (Free Tier)

1. **Push this folder to a GitHub repository.**
2. Go to [Render.com Dashboard](https://dashboard.render.com/) and click **New +** > **Web Service**.
3. Connect your GitHub repository.
4. Set the following build and start settings:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
5. Under **Environment Variables**, add:
   - `TEACHER_PASSWORD`: `YourSecurePasswordHere` (e.g. `MyExamSecret2026`)
   - `SESSION_SECRET`: `AnyRandomString`
6. Click **Create Web Service**. Render will build and deploy your app in ~1 minute!

*(Alternatively, you can use Render's Blueprint feature with the included `render.yaml` file).*
