const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');
const MAX_PAPER = 50 * 1024 * 1024;
const MAGIC = Buffer.from('PLOCK01\n');

// Store configuration and its PDF together; answers and candidate records never go to GitHub.
function encryptSchedule(examState, paper, secret) {
  if (!Buffer.isBuffer(paper) || paper.length > MAX_PAPER) throw new Error('Invalid question paper');
  const header = Buffer.from(JSON.stringify({ version: 1, examState }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const iv = randomBytes(12), key = createHash('sha256').update(secret).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([length, header, paper])), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

function decryptSchedule(buffer, secret) {
  if (buffer.length < 44 || !buffer.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid encrypted schedule');
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(8, 20));
  decipher.setAAD(MAGIC); decipher.setAuthTag(buffer.subarray(20, 36));
  const plain = Buffer.concat([decipher.update(buffer.subarray(36)), decipher.final()]);
  const length = plain.readUInt32BE(0);
  if (length > 100000 || length + 4 > plain.length) throw new Error('Invalid schedule metadata');
  const { version, examState } = JSON.parse(plain.subarray(4, 4 + length).toString('utf8'));
  const paper = plain.subarray(4 + length);
  if (version !== 1 || !examState || !/^[a-zA-Z0-9_-]+$/.test(examState.sessionId) ||
      !['created', 'scheduled', 'active', 'ended'].includes(examState.status) ||
      !/^\/uploads\/[a-zA-Z0-9_-]+\.pdf$/.test(examState.pdfUrl) ||
      !Number.isInteger(examState.durationMinutes) || examState.durationMinutes < 1 || examState.durationMinutes > 3000 ||
      !Number.isInteger(examState.totalQuestions) || examState.totalQuestions < 1 || examState.totalQuestions > 200 ||
      (examState.status === 'scheduled' && !Number.isFinite(examState.scheduledStartTime)) ||
      (examState.status === 'active' && (!Number.isFinite(examState.startTime) || !Number.isFinite(examState.endTime))) ||
      paper.length > MAX_PAPER || paper.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid saved assessment');
  return { examState, paper };
}

function createGitHubScheduleStore({ token, repo, secret, branch = 'proctorlock-exams', fetchImpl = fetch }) {
  if (!token) throw new Error('EXAM_STORAGE_TOKEN is missing. This is the only GitHub token required.');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo || '')) {
    throw new Error('The repository was not detected. Set EXAM_STORAGE_REPO to owner/repository (for this app: MonishVinay/exam_gen). This is a repository name, not another token.');
  }
  if (!secret || secret.length < 24) {
    throw new Error('A stable SESSION_SECRET of at least 24 characters is required for encryption. EXAM_STORAGE_KEY is an optional override, not another GitHub token.');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(branch) || ['main', 'master'].includes(branch)) {
    throw new Error('Schedule storage must use a separate data branch, such as proctorlock-exams.');
  }
  const root = `https://api.github.com/repos/${repo}`;
  const filename = 'proctorlock/scheduled-exam.bin';
  let sha = null, branchReady = false;
  async function request(route, { allow404 = false, raw = false, method = 'GET', body } = {}) {
    const response = await fetchImpl(root + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: {
        Authorization: `Bearer ${token}`, 'User-Agent': 'ProctorLock-Schedule-Storage',
        Accept: raw ? 'application/vnd.github.raw+json' : route.startsWith('/contents/') ? 'application/vnd.github.object+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub schedule storage unavailable (HTTP ${response.status}). Check the repository token and try again.`);
    return raw ? response : response.json();
  }
  async function ensureBranch() {
    if (branchReady) return;
    const ref = await request(`/git/ref/heads/${branch}`, { allow404: true });
    if (!ref) {
      const repository = await request('');
      if (repository.default_branch === branch) throw new Error('Schedule storage must use a separate branch from the app.');
      const base = await request(`/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
      await request('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: base.object.sha } });
    }
    branchReady = true;
  }
  return {
    provider: 'github',
    async load() {
      // Check the repository first so a bad token/private repo never looks like an empty store.
      const repository = await request('');
      if (repository.default_branch === branch) throw new Error('Schedule storage must use a separate branch from the app.');
      const metadata = await request(`/contents/${filename}?ref=${branch}`, { allow404: true });
      if (!metadata) return null;
      sha = metadata.sha;
      const response = await request(`/contents/${filename}?ref=${branch}`, { raw: true });
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_PAPER + 100000) throw new Error('Saved schedule exceeds the storage limit');
      const encrypted = Buffer.from(await response.arrayBuffer());
      if (encrypted.length > MAX_PAPER + 100000) throw new Error('Saved schedule exceeds the storage limit');
      try { return decryptSchedule(encrypted, secret); }
      catch { throw new Error('Unable to decrypt the saved exam. Keep EXAM_STORAGE_KEY unchanged across deployments.'); }
    },
    async save(examState, paper) {
      await ensureBranch();
      // Refresh the expected file version; GitHub rejects concurrent updates rather than silently overwriting.
      const metadata = await request(`/contents/${filename}?ref=${branch}`, { allow404: true });
      sha = metadata?.sha;
      const encrypted = encryptSchedule(examState, paper, secret);
      const result = await request(`/contents/${filename}`, { method: 'PUT', body: {
        message: 'Save encrypted ProctorLock assessment', branch,
        content: encrypted.toString('base64'), ...(sha ? { sha } : {})
      } });
      sha = result.content.sha;
    }
  };
}

module.exports = { createGitHubScheduleStore, encryptSchedule, decryptSchedule };
