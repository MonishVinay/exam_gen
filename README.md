# ProctorLock

PDF assessments with a live examiner console, candidate answer workspace, browser integrity signals and recoverable submissions. Node.js, Express 5, Socket.IO and vanilla JavaScript; the existing GitHub-to-Render deployment is retained.

## Run

Use Node.js 22.22.2 or a newer supported LTS version.

```sh
npm ci
npm start
```

Open `http://localhost:3000`, `/teacher.html` or `/student.html`. Set environment variables in your shell or hosting provider; `.env.example` documents the values (the server does not automatically load `.env`). The local development password defaults to `teacher123`. Set `TEACHER_PASSWORD` and `SESSION_SECRET` in Render before using the service for real assessments. Teacher sessions expire after one day and require signing in again after a server restart.

## Assessment flow

1. Sign in as examiner. Upload a PDF (up to 50 MB), set a title, subject, join code, duration of 1–3000 minutes and 1–200 questions.
2. Candidates enter their name, roll number and case-insensitive code. They wait until the examiner starts the assessment, then enter fullscreen through a user gesture.
3. The workspace renders every PDF page with zoom/reset controls and a collapsible answer sheet. Drafts save immediately on the candidate's device and sync to the server after 300 ms. Sync labels distinguish device storage from server acknowledgement.
4. The console shows connected candidates, fullscreen state, live time away, answer counts, flags, answer sheets and audit logs. Answer review reads the synchronized in-memory roster. The examiner may force submission or conclude the exam.
5. The server finalizes saved answers when the deadline passes, including disconnected candidates. Submission success appears only after server acknowledgement. A new assessment uses a new session identifier so previous drafts and candidates do not carry over.

Candidates resume using the same browser and normalized roll number. A per-session resume token prevents another browser from claiming an existing candidate's record. Keep browser storage available; reconnect from the original browser. An examiner can clear the roster after archiving, but clearing does not erase candidate registration or submission history for the same assessment.

## Integrity monitoring

During an assessment, observable fullscreen exits, focus loss, tab changes, clipboard actions, right-click, printing, developer-tools shortcuts and screenshot shortcuts can be logged. An overlay covers the workspace after fullscreen exits. PDF access requires an active candidate token or an authenticated teacher.

Browser controls are best-effort signals. A webpage cannot reliably prevent operating-system screenshots, recording, external cameras, modified clients or all developer tools. Flags are evidence for examiner review, not proof of misconduct. Browsers without fullscreen support cannot launch the workspace.

## History, recovery and backups

The server atomically writes a master history, redundant backup, individual session files and an active recovery snapshot. Candidates are merged by normalized roll number; archived nonblank answers and violation logs survive roster clearing and backup imports. Submission and force-submission archive immediately. Recovery reads all replicas and restores active candidates as disconnected until they rejoin.

The authenticated teacher console mirrors history in `localStorage` under `PROCTOR_PERMANENT_EXAM_HISTORY`. If the server history is empty, it can restore the browser mirror. The first empty socket update does not overwrite that mirror. Download JSON backups, restore them through the console, and export active or archived answer sheets as CSV.

**Render free-tier storage is ephemeral.** Server files and question-paper uploads can disappear on redeploy. The browser mirror depends on that browser still retaining data and having received the latest history. It does not back up uploaded PDFs or guarantee zero data loss. Use downloaded backups and persistent storage for important assessments.

Optional storage variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port, supplied automatically by Render |
| `TEACHER_PASSWORD` | `teacher123` | Examiner password |
| `SESSION_SECRET` | Random per process | Session-cookie signing secret; set a stable random value in production |
| `DATA_DIR` | `./data` | History and active snapshots |
| `UPLOADS_DIR` | `./uploads` | Uploaded question papers |
| `NODE_ENV` | Unset | Use `production` behind Render HTTPS for secure cookies |

For a separately configured Render persistent disk, point `DATA_DIR` and `UPLOADS_DIR` at subdirectories of its mount path. This project does not provision a paid disk automatically. File storage and session state support one service instance; do not scale replicas without a shared database/session store. Tailwind, Font Awesome and PDF.js currently load from CDNs, so client internet access is required.

## Deploy through the existing GitHub repository

The repository is `MonishVinay/exam_gen`. Push to its connected branch (`main`) to trigger the existing Render auto-deploy. The included `render.yaml` specifies `npm ci --omit=dev`, `node server.js`, Node 22 and `/api/health`. Existing dashboard-managed services may require those settings to be applied in Render separately; changing a YAML file alone does not reconfigure a service that is not Blueprint-managed.

The app listens on Render's `PORT` and `0.0.0.0`, uses proxy-aware secure cookies in production, and shuts down with a final snapshot. `/api/health` returns `{ "status": "ok", "app": "ProctorLock" }`.

## Checks

```sh
npm run check
npm test
npm audit
```

Tests cover REST/WebSocket authentication and logout, PDF/limit validation, waiting candidates, token-protected PDFs, reconnect and restart recovery, immutable submissions, archival before reset, repeated exam isolation, expiry recovery, backup merging, large backups, safe CSV export, corruption recovery and deletion. Client tests run in jsdom entirely in the terminal, with no desktop or browser input; they cover draft isolation, escaped answers/roster text, acknowledgement-based submission, sensor registration, browser-backup recovery and synchronous answer review.
