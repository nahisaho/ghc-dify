import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function scenario(number) {
  const driver = `${root}tests/validate.py`;
  assert.ok(existsSync(driver), 'Behavioral validation driver has not been implemented');
  const child = spawnSync('python', [driver, number], {
    encoding: 'utf8',
    timeout: 570_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  // The driver must redact credentials before emitting either output stream.
  assert.equal(child.error, undefined, 'Validation could not finish');
  assert.equal(child.status, 0, `Behavioral scenario ${number} failed: ${child.stdout}${child.stderr}`);
  const result = JSON.parse(child.stdout);
  assert.equal(result.scenario, number);
  assert.equal(result.verdict, 'PASS');
  assert.ok(result.assertions > 0, 'No behavioral assertions executed');
}

/** @id TEST-DIFYIMG-001 @verifies REQ-DIFYIMG-001 */
test('TEST-DIFYIMG-001 native role readiness, failure propagation, workflows/plugins/RAG', () => {
  scenario('001');
});

/** @id TEST-DIFYIMG-002 @verifies REQ-DIFYIMG-002 */
test('TEST-DIFYIMG-002 fresh/recreated data, private keys, corruption and interrupted bootstrap', () => {
  scenario('002');
});

/** @id TEST-DIFYIMG-003 @verifies REQ-DIFYIMG-003 */
test('TEST-DIFYIMG-003 SSH/job isolation, interrupted home recovery and contained job errors', () => {
  // Real broker/chroot regressions precede the unchanged credential/capability
  // controls: all interrupted commits and malformed jobs must preserve reuse.
  scenario('003');
});

/** @id TEST-DIFYIMG-004 @verifies REQ-DIFYIMG-004 */
test('TEST-DIFYIMG-004 native MCP fixed workflow, unpublished/disabled/invalid/rotated credentials', () => {
  scenario('004');
});

/** @id TEST-DIFYIMG-005 @verifies REQ-DIFYIMG-005 */
test('TEST-DIFYIMG-005 real SSH login PTY, non-login PATH, cap0 dev and nvm/npm/Copilot without seeded authentication', () => {
  scenario('005');
});

/** @id TEST-DIFYIMG-006 @verifies REQ-DIFYIMG-006 */
test('TEST-DIFYIMG-006 guarded dual-filesystem work, owned labels, loopback and no-match refusal', () => {
  scenario('006');
});
