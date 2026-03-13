import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseListeningPort(output) {
  const match = output.match(/http:\/\/0\.0\.0\.0:(\d+)/);
  return match ? Number(match[1]) : null;
}

async function startServer() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'randomisarr-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let combinedOutput = '';

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for server startup.\n${combinedOutput}`));
    }, 10000);

    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off('data', onOutput);
      child.stderr.off('data', onOutput);
      child.off('exit', onExit);
    }

    function onOutput(chunk) {
      combinedOutput += chunk;
      const parsedPort = parseListeningPort(combinedOutput);

      if (parsedPort !== null) {
        cleanup();
        resolve(parsedPort);
      }
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`Server exited early with code ${code}.\n${combinedOutput}`));
    }

    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('exit', onExit);
  });

  return {
    child,
    dataDir,
    baseUrl: `http://127.0.0.1:${port}`
  };
}

async function stopServer(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  await once(child, 'exit');
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers || {});

  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    redirect: 'manual'
  });
  const text = await response.text();

  return {
    response,
    body: text ? JSON.parse(text) : null
  };
}

function readSessionCookie(response) {
  const setCookieHeader = response.headers.get('set-cookie');
  return setCookieHeader ? setCookieHeader.split(';', 1)[0] : '';
}

test('smoke flow covers setup, auth, settings, and empty-library errors', async (t) => {
  const server = await startServer();

  t.after(async () => {
    await stopServer(server.child);
    await rm(server.dataDir, { recursive: true, force: true });
  });

  const health = await requestJson(server.baseUrl, '/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.authConfigured, false);

  const authStatusBeforeSetup = await requestJson(server.baseUrl, '/api/auth/status');
  assert.equal(authStatusBeforeSetup.response.status, 200);
  assert.equal(authStatusBeforeSetup.body.adminConfigured, false);
  assert.equal(authStatusBeforeSetup.body.authenticated, false);

  const setup = await requestJson(server.baseUrl, '/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify({
      username: 'tester',
      password: 'password123',
      selectionCount: '5'
    })
  });
  assert.equal(setup.response.status, 201);
  assert.equal(setup.body.ok, true);

  const sessionCookie = readSessionCookie(setup.response);
  assert.match(sessionCookie, /^randomisarr_session=/);

  const authStatusAfterSetup = await requestJson(server.baseUrl, '/api/auth/status', {
    headers: {
      Cookie: sessionCookie
    }
  });
  assert.equal(authStatusAfterSetup.response.status, 200);
  assert.equal(authStatusAfterSetup.body.adminConfigured, true);
  assert.equal(authStatusAfterSetup.body.authenticated, true);
  assert.equal(authStatusAfterSetup.body.username, 'tester');

  const noLibrarySpin = await requestJson(server.baseUrl, '/api/spin', {
    headers: {
      Cookie: sessionCookie
    }
  });
  assert.equal(noLibrarySpin.response.status, 400);
  assert.match(noLibrarySpin.body.error, /No library data could be loaded/);

  const initialSettingsSave = await requestJson(server.baseUrl, '/api/settings', {
    method: 'PUT',
    headers: {
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      username: 'tester',
      radarrUrl: '',
      radarrApiKey: '',
      sonarrUrl: '',
      sonarrApiKey: '',
      embyUrl: 'https://emby.example.test',
      embyApiKey: 'emby-secret',
      embyUserId: 'tester-user',
      jellyfinUrl: '',
      jellyfinApiKey: '',
      jellyfinUserId: '',
      plexUrl: '',
      plexToken: '',
      tmdbAccessToken: 'tmdb-secret',
      selectionCount: '5',
      watchMode: 'everything',
      watchSource: 'auto',
      franchiseMode: 'off'
    })
  });
  assert.equal(initialSettingsSave.response.status, 200);
  assert.equal(initialSettingsSave.body.ok, true);

  const savedSettingsAfterFirstWrite = JSON.parse(
    await readFile(path.join(server.dataDir, 'settings.json'), 'utf8')
  );
  assert.equal(savedSettingsAfterFirstWrite.providers.emby.apiKey, 'emby-secret');
  assert.equal(savedSettingsAfterFirstWrite.tmdb.accessToken, 'tmdb-secret');

  const redactedSettings = await requestJson(server.baseUrl, '/api/settings', {
    headers: {
      Cookie: sessionCookie
    }
  });
  assert.equal(redactedSettings.response.status, 200);
  assert.equal(redactedSettings.body.settings.providers.emby.apiKey, '');
  assert.equal(redactedSettings.body.settings.providers.emby.apiKeyConfigured, true);
  assert.equal(redactedSettings.body.settings.tmdb.accessToken, '');
  assert.equal(redactedSettings.body.settings.tmdb.accessTokenConfigured, true);

  const settingsSaveWithoutSecrets = await requestJson(server.baseUrl, '/api/settings', {
    method: 'PUT',
    headers: {
      Cookie: sessionCookie
    },
    body: JSON.stringify({
      username: 'tester',
      radarrUrl: '',
      radarrApiKey: '',
      sonarrUrl: '',
      sonarrApiKey: '',
      embyUrl: 'https://emby.example.test',
      embyApiKey: '',
      embyUserId: 'tester-user',
      jellyfinUrl: '',
      jellyfinApiKey: '',
      jellyfinUserId: '',
      plexUrl: '',
      plexToken: '',
      tmdbAccessToken: '',
      selectionCount: '3',
      watchMode: 'everything',
      watchSource: 'auto',
      franchiseMode: 'off'
    })
  });
  assert.equal(settingsSaveWithoutSecrets.response.status, 200);
  assert.equal(settingsSaveWithoutSecrets.body.ok, true);

  const savedSettingsAfterSecondWrite = JSON.parse(
    await readFile(path.join(server.dataDir, 'settings.json'), 'utf8')
  );
  assert.equal(savedSettingsAfterSecondWrite.providers.emby.apiKey, 'emby-secret');
  assert.equal(savedSettingsAfterSecondWrite.tmdb.accessToken, 'tmdb-secret');

  const logout = await requestJson(server.baseUrl, '/api/auth/logout', {
    method: 'POST',
    headers: {
      Cookie: sessionCookie
    }
  });
  assert.equal(logout.response.status, 200);
  assert.equal(logout.body.ok, true);
});
