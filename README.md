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

## Scheduled exams on sleeping Render services (no database)

The teacher can set **Scheduled Start** in the configuration form and save the PDF. The field uses the teacher's device timezone and is sent as an absolute UTC timestamp. Leaving it blank keeps manual start available. Changing the future time reschedules the exam; clearing it cancels automatic start. **Start Now Instead** overrides the schedule explicitly.

The original start/end window is always preserved. For example, an exam scheduled 10–11 AM opens with 40 minutes remaining when a student wakes Render at 10:20 AM. A first wake at or after 11 AM shows an ended exam. Before 10 AM, candidates enter the waiting room. The server checks timestamps at startup, on API requests, on candidate connections and while running; it does not rely on executing a timer while Render is asleep.

Free Render erases uploaded files on sleep. To preserve both the schedule and its question paper without a database, the app can save an **AES-256-GCM encrypted bundle** in the existing GitHub repository on a separate `proctorlock-exams` branch. A new instance restores that bundle and PDF before accepting students. The teacher does not need to return or keep a browser open. Only assessment configuration and the PDF go to this branch; student identities, answers and audit logs are excluded. The existing history/browser-backup limitations below still apply to candidate records.

One-time setup in Render's **Environment** settings:

1. Create a fine-grained GitHub token limited to `MonishVinay/exam_gen`, with repository **Contents: Read and write**. Store it as `EXAM_STORAGE_TOKEN` in Render, never in source control or browser code.
2. Render supplies the repository slug automatically. To override it, set `EXAM_STORAGE_REPO=MonishVinay/exam_gen`.
3. Encryption uses the existing stable `SESSION_SECRET`. Optionally set a separate `EXAM_STORAGE_KEY` of at least 24 random characters. Keep this key unchanged while saved exams must remain recoverable; changing it makes the existing encrypted bundle unreadable.
4. Keep Render deploying from `main`. The app creates and updates only the separate data branch. Saving an exam waits for GitHub confirmation before reporting success. An expired token, unavailable repository or write conflict reports failure rather than claiming an exam is safely scheduled.

No database, paid disk, always-running cron or keep-alive service is required with this setup. GitHub access and the stable encryption key are required on each cold start. GitHub rate/storage limits still apply; this storage is intended for occasional exam configuration changes, not answer-by-answer writes. Git retains older encrypted file versions, so deleting an exam from history does not purge those versions. Only one current/upcoming exam is supported, matching the existing app's single-exam model.

On Render, scheduling is rejected until this external storage is configured, so a local-only save is never presented as sleep-safe. Existing manual exams remain available. The console displays storage readiness after sign-in. Locally, file-backed schedules can be tested without GitHub but depend on the files remaining available.

References: [Render free-tier persistence](https://render.com/docs/free), [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents), [GitHub token setup](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

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
| `EXAM_STORAGE_TOKEN` | Unset | GitHub token for encrypted schedule/PDF storage; required for scheduling on Render free tier |
| `EXAM_STORAGE_REPO` | Render's repository slug | Repository used for encrypted assessment bundles |
| `EXAM_STORAGE_KEY` | `SESSION_SECRET` | Stable encryption key, at least 24 characters |
| `EXAM_STORAGE_BRANCH` | `proctorlock-exams` | Separate data branch; must not be the deployment/default branch |

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

Scheduling tests simulate a fresh empty disk, student-only wake before/during/after the original exam window, cancellation, early conclusion, validation, remote storage failure, encryption integrity and GitHub branch isolation. GitHub API calls are mocked for automated tests; enabling the production token and verifying a real Render cold start are separate deployment steps.
