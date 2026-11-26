const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubScheduleStore, encryptSchedule, decryptSchedule } = require('../lib/schedule-store');
const secret = 'a-dedicated-stable-secret-at-least-24-characters';
const exam = { sessionId: 'exam-test', status: 'scheduled', title: 'Private exam', pdfUrl: '/uploads/question.pdf', durationMinutes: 60, totalQuestions: 3, scheduledStartTime: 1894670400000 };
const paper = Buffer.from('%PDF-1.4\nPrivate question paper\n%%EOF');

test('schedule encryption hides metadata and paper, rejects wrong keys and modified ciphertext', () => {
  const encrypted = encryptSchedule(exam, paper, secret);
  assert.equal(encrypted.includes(Buffer.from('Private')), false);
  assert.deepEqual(decryptSchedule(encrypted, secret), { examState: exam, paper });
  assert.throws(() => decryptSchedule(encrypted, 'another-secret'));
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptSchedule(tampered, secret));
  assert.throws(() => createGitHubScheduleStore({ token: 'fake', repo: 'owner/repo', secret, branch: 'main' }));
});

test('GitHub stores only encrypted data on a separate branch and restores large papers using raw media', async () => {
  let file = null, branch = false, version = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    const route = url.replace('https://api.github.com/repos/owner/repo', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, method: options.method, accept: options.headers.Accept, body });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (!route) return json({ default_branch: 'main' });
    if (route === '/git/ref/heads/main') return json({ object: { sha: 'base-main-sha' } });
    if (route === '/git/ref/heads/proctorlock-exams') return branch ? json({ object: { sha: 'data-branch-sha' } }) : json({}, 404);
    if (route === '/git/refs') { assert.equal(body.ref, 'refs/heads/proctorlock-exams'); branch = true; return json({}); }
    if (options.method === 'PUT') {
      assert.equal(body.branch, 'proctorlock-exams');
      if (version) assert.equal(body.sha, 'version-' + version);
      file = Buffer.from(body.content, 'base64'); version++;
      return json({ content: { sha: 'version-' + version } });
    }
    if (!file) return json({}, 404);
    if (options.headers.Accept === 'application/vnd.github.raw+json') return new Response(file);
    assert.equal(options.headers.Accept, 'application/vnd.github.object+json');
    return json({ sha: 'version-' + version, encoding: 'none', size: file.length });
  };
  const settings = { token: 'fake-token-not-a-real-credential', repo: 'owner/repo', secret, fetchImpl };
  const store = createGitHubScheduleStore(settings);
  assert.equal(await store.load(), null);
  const largePaper = Buffer.concat([paper, Buffer.alloc(2 * 1024 * 1024, 65)]);
  await store.save(exam, largePaper); await store.save({ ...exam, title: 'Rescheduled' }, largePaper);
  const restored = await createGitHubScheduleStore(settings).load();
  assert.equal(restored.examState.title, 'Rescheduled'); assert.deepEqual(restored.paper, largePaper);
  assert.equal(file.includes(Buffer.from('Rescheduled')), false);
  assert.equal(calls.filter(c => c.method === 'PUT').length, 2);
});

test('GitHub authentication failure never masquerades as an empty schedule', async () => {
  const store = createGitHubScheduleStore({ token: 'fake', repo: 'owner/repo', secret,
    fetchImpl: async () => new Response('{}', { status: 403 }) });
  await assert.rejects(store.load(), /HTTP 403/);
});
