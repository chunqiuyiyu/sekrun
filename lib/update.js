import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const NPM_REGISTRY = 'https://registry.npmjs.org/sekrun';
const TIMEOUT_MS = 3000;

/**
 * @returns {string}
 */
function getCurrentVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  return pkg.version;
}

/**
 * Fetch the latest published version from the npm registry.
 * @returns {Promise<{ok: boolean, latest: string|null, error?: string}>}
 */
async function fetchLatestVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(NPM_REGISTRY + '/latest', { signal: controller.signal });
    if (!res.ok) return { ok: false, latest: null, error: `HTTP ${res.status}` };
    const body = await res.json();
    return body.version
      ? { ok: true, latest: body.version }
      : { ok: false, latest: null, error: 'missing version in registry response' };
  } catch (error) {
    return { ok: false, latest: null, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compare two semver strings. Returns:
 *   1 if a > b
 *  -1 if a < b
 *   0 if equal
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * Check for an available update. Returns the latest version string
 * if an update is available, or null if already up-to-date or check failed.
 * @returns {Promise<string|null>}
 */
export async function checkForUpdate() {
  const current = getCurrentVersion();
  const { ok, latest } = await fetchLatestVersion();
  if (!ok || !latest) return null;
  return compareVersions(latest, current) > 0 ? latest : null;
}

/**
 * Return explicit update status for startup enforcement.
 * Unlike checkForUpdate(), this does not collapse "check failed" and
 * "already up-to-date" into the same null result.
 *
 * @returns {Promise<{ok: boolean, current: string, latest: string|null, updateAvailable: boolean, error?: string}>}
 */
export async function getUpdateStatus() {
  const current = getCurrentVersion();
  const result = await fetchLatestVersion();
  if (!result.ok || !result.latest) {
    return {
      ok: false,
      current,
      latest: null,
      updateAvailable: false,
      error: result.error || 'unable to fetch latest version',
    };
  }

  return {
    ok: true,
    current,
    latest: result.latest,
    updateAvailable: compareVersions(result.latest, current) > 0,
  };
}

/**
 * Enforce that the current version is the latest.
 * Blocks startup if the version check fails or an update is available.
 *
 * @returns {Promise<{ok: boolean, latest: string|null}>}
 */
export async function enforceUpdate() {
  const status = await getUpdateStatus();

  if (!status.ok) {
    console.error('\nUpdate check failed.');
    console.error(`Current version: ${status.current}`);
    console.error(`Reason: ${status.error}`);
    console.error('Connect to the network and run sekrun again, or run sekrun --update.');
    return { ok: false, latest: null };
  }

  if (status.updateAvailable) {
    console.error('\nsekrun is outdated.');
    console.error(`Current version: ${status.current}`);
    console.error(`Latest version: ${status.latest}`);
    console.error('Run sekrun --update, then try again.');
    return { ok: false, latest: status.latest };
  }

  return { ok: true, latest: status.latest };
}

/**
 * Execute update: run `npm install -g sekrun@latest`.
 * This function blocks until the install completes.
 * @returns {{ ok: boolean, stderr?: string }}
 */
export function runUpdate() {
  try {
    execSync('npm install -g sekrun@latest', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: err.stderr?.toString() || err.message };
  }
}
