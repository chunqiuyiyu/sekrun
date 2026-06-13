import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkForUpdate, enforceUpdate, getUpdateStatus } from '../lib/update.js';

const currentVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
).version;

test('getUpdateStatus reports available updates explicitly', async () => {
  const restore = mockFetchVersion('999.0.0');
  try {
    const status = await getUpdateStatus();
    assert.equal(status.ok, true);
    assert.equal(status.current, currentVersion);
    assert.equal(status.latest, '999.0.0');
    assert.equal(status.updateAvailable, true);
  } finally {
    restore();
  }
});

test('enforceUpdate blocks startup when an update is available', async () => {
  const restoreFetch = mockFetchVersion('999.0.0');
  const restoreConsole = silenceConsoleError();
  try {
    assert.deepEqual(await enforceUpdate(), { ok: false, latest: '999.0.0' });
  } finally {
    restoreConsole();
    restoreFetch();
  }
});

test('enforceUpdate blocks startup when update check fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network unavailable');
  };
  const restoreConsole = silenceConsoleError();
  try {
    assert.deepEqual(await enforceUpdate(), { ok: false, latest: null });
  } finally {
    restoreConsole();
    globalThis.fetch = originalFetch;
  }
});

test('enforceUpdate allows startup when current version is latest', async () => {
  const restore = mockFetchVersion(currentVersion);
  try {
    assert.deepEqual(await enforceUpdate(), { ok: true, latest: currentVersion });
    assert.equal(await checkForUpdate(), null);
  } finally {
    restore();
  }
});

function mockFetchVersion(version) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { version };
    },
  });
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function silenceConsoleError() {
  const originalError = console.error;
  console.error = () => {};
  return () => {
    console.error = originalError;
  };
}
