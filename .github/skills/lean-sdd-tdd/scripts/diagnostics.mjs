import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { stripVTControlCharacters, TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

/** @id CODE-DIAGCLI-001 @implements REQ-DIAGCLI-001 REQ-DIAGCLI-002 REQ-DIAGCLI-003 REQ-DIAGCLI-004 REQ-DIAGCLI-005 */
const PROVIDERS = ['typescript', 'eslint'];
const TIMEOUT_MS = 60000;
const OUTPUT_BYTES = 8388608;
const eslint = { source: 'eslint', timeoutMs: TIMEOUT_MS };
export const PROFILES = {
  typescript: [{ source: 'typescript', timeoutMs: TIMEOUT_MS }, eslint],
  javascript: [eslint],
  python: [{ source: 'ruff', timeoutMs: TIMEOUT_MS }, { source: 'mypy', timeoutMs: TIMEOUT_MS }],
  rust: [{ source: 'cargo-check', timeoutMs: 180000 }],
};
const WORKER = fileURLToPath(new URL('./diagnostics-worker.mjs', import.meta.url));
const unknownFiles = () => ({ included: null, checked: null, ignored: null });
export function providerResult(source) {
  return { source, status: 'incomplete', version: null, configPath: null, reason: 'Diagnosis has not completed', files: unknownFiles(), diagnostics: [] };
}
export function providerFailure(source, error, partial = {}) {
  return {
    ...providerResult(source), ...partial, source, status: 'incomplete',
    reason: stripVTControlCharacters(error instanceof Error ? error.message : String(error)),
    files: unknownFiles(),
  };
}
export function diagnostic(source, root, { file = null, line = null, column = null, code, severity, message }) {
  let name = null;
  if (file !== null) {
    const absolute = fs.realpathSync(file);
    const relative = path.relative(root, absolute);
    name = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) ? relative : absolute;
    name = name.split(path.sep).join('/');
  }
  return { source, file: name, line: file === null ? null : line, column: file === null ? null : column, code: String(code), severity, message: stripVTControlCharacters(message) };
}
export function sortDiagnostics(values) {
  const fields = ['file', 'line', 'column', 'code', 'message'];
  return values.sort((a, b) => {
    for (const key of fields) {
      if (a[key] === b[key]) continue;
      if (a[key] === null) return -1;
      if (b[key] === null) return 1;
      return a[key] < b[key] ? -1 : 1;
    }
    return 0;
  });
}
export function aggregate(providers, required = PROVIDERS) {
  const invalid = !required.length || providers.length !== required.length
    || new Set(providers.map(p => p.source)).size !== required.length
    || required.some(source => !providers.some(p => p.source === source));
  const unfinished = providers.filter(p => p.status !== 'complete');
  if (invalid || unfinished.length) return {
    status: 'INCOMPLETE', exitCode: 2,
    reason: invalid ? 'Required diagnostic providers are missing or invalid' : unfinished.map(p => `${p.source}: ${p.reason || 'incomplete'}`).join('; '),
  };
  const failed = providers.some(p => p.diagnostics.some(d => d.severity === 'error'));
  return { status: failed ? 'FAIL' : 'PASS', exitCode: failed ? 1 : 0, reason: null };
}
function validProvider(value, source) {
  const nullableString = v => v === null || typeof v === 'string';
  const positive = v => v === null || (Number.isInteger(v) && v > 0);
  if (!value || value.source !== source || !['complete', 'incomplete'].includes(value.status)
    || !nullableString(value.version) || !nullableString(value.configPath) || !Array.isArray(value.diagnostics) || !value.files) return false;
  if (value.status === 'complete' ? value.reason !== null : typeof value.reason !== 'string' || !value.reason.trim()) return false;
  for (const field of ['included', 'checked', 'ignored']) {
    const n = value.files[field];
    if (value.status === 'complete' ? !Number.isInteger(n) || n < 0 : n !== null) return false;
  }
  return value.diagnostics.every(d => d && d.source === source && nullableString(d.file)
    && positive(d.line) && positive(d.column) && (d.file !== null || (d.line === null && d.column === null))
    && typeof d.code === 'string' && typeof d.message === 'string' && ['error', 'warning', 'info', 'hint'].includes(d.severity));
}
export async function runProvider(source, root, {
  worker = WORKER,
  timeoutMs = Object.values(PROFILES).flat().find(p => p.source === source)?.timeoutMs ?? TIMEOUT_MS,
  outputBytes = OUTPUT_BYTES, profile = 'typescript', env = process.env,
  clock = Date.now,
  removeScratch = directory => fs.promises.rm(directory, { recursive: true, force: true }),
} = {}) {
  let scratch = null;
  if (source === 'cargo-check') {
    try {
      const temporaryRoot = fs.realpathSync(os.tmpdir());
      const relative = path.relative(root, temporaryRoot);
      if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Rust scratch must be outside the project');
      scratch = await fs.promises.mkdtemp(path.join(temporaryRoot, 'musubix6-diagnostics-rust-'));
    } catch (error) {
      return providerFailure(source, `Cannot allocate private Rust scratch: ${error.message}`);
    }
  }
  const deadline = clock() + timeoutMs;
  const result = await new Promise(resolve => {
    const chunks = [];
    let bytes = 0, failure = null, timer;
    const child = spawn(process.execPath, [worker, source, root, profile, scratch ?? '', JSON.stringify({ deadline, outputBytes })], {
      cwd: root, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (killed.error || killed.status !== 0) {
          failure += `; worker cleanup failed: ${killed.error?.message ?? killed.stderr}`;
          child.kill('SIGKILL');
        }
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) {
          if (error.code !== 'ESRCH') {
            failure = `${failure ?? 'Worker cleanup failed'}; ${error.message}`;
            child.kill('SIGKILL');
          }
        }
      }
    };
    const capture = (data, stdout) => {
      bytes += data.length;
      if (bytes > outputBytes) {
        if (!failure) { failure = `Provider output exceeds ${outputBytes} bytes`; terminate(); }
      } else if (stdout) chunks.push(data);
    };
    child.stdout.on('data', data => capture(data, true));
    child.stderr.on('data', data => capture(data, false));
    child.on('error', error => { failure = `Provider spawn failed: ${error.message}`; });
    timer = setTimeout(() => { failure = `Provider timed out after ${timeoutMs} ms`; terminate(); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (clock() >= deadline) failure ??= `Provider timed out after ${timeoutMs} ms`;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 0);
          failure = `${failure ?? 'Worker left running descendants'}; terminating owned process group`;
          terminate();
        } catch (error) {
          if (error.code !== 'ESRCH') failure = `${failure ?? 'Worker cleanup failed'}; ${error.message}`;
        }
      }
      if (!failure && (signal || code !== 0)) failure = signal ? `Provider terminated by signal ${signal}` : `Provider exited with status ${code}`;
      let value;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!validProvider(value, source)) throw new Error('Invalid provider output schema');
      } catch (error) {
        resolve(providerFailure(source, failure ?? `Invalid provider JSON output: ${error.message}`));
        return;
      }
      const sorted = { ...value, diagnostics: sortDiagnostics(value.diagnostics) };
      if (failure) resolve(providerFailure(source,
        sorted.status === 'incomplete' ? `${sorted.reason}; ${failure}` : failure, sorted));
      else resolve(sorted);
    });
  });
  if (scratch) {
    try { await removeScratch(scratch); }
    catch (error) { return providerFailure(source, `${result.reason ? result.reason + '; ' : ''}Rust scratch cleanup failed (${scratch}): ${error.message}`, result); }
  }
  return result;
}
function parseInput(argv, cwd) {
  let directory = cwd;
  let profile = 'typescript';
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!['diagnostics', '--root', '--json', '--profile'].includes(arg) || seen.has(arg)) throw new Error(`Invalid or repeated diagnostics argument: ${arg}`);
    seen.add(arg);
    if (arg === '--root') {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error('--root requires a nonempty directory');
      directory = path.resolve(cwd, value);
    }
    if (arg === '--profile') {
      const value = argv[++i];
      if (!Object.hasOwn(PROFILES, value)) throw new Error('--profile requires typescript, javascript, python or rust');
      profile = value;
    }
  }
  const root = fs.realpathSync(directory);
  if (!fs.statSync(root).isDirectory()) throw new Error('--root must be a directory');
  return { root, profile };
}
export async function runDiagnostics(argv, { cwd = process.cwd(), write = text => new Promise((resolve, reject) => process.stdout.write(text, error => error ? reject(error) : resolve())) } = {}) {
  if (argv.length === 2 && argv[0] === 'diagnostics' && argv[1] === '--help') {
    await write('Usage: sdd.mjs diagnostics [--root DIR] [--json] [--profile typescript|javascript|python|rust]\n');
    return 0;
  }
  const data = { schemaVersion: 1, profile: 'typescript', root: null, reason: null, startedAt: new Date().toISOString(), completedAt: null, status: 'INCOMPLETE', exitCode: 2, snapshot: true, providers: [] };
  const profiles = argv.flatMap((arg, i) => arg === '--profile' ? [argv[i + 1]] : []);
  if (profiles.length === 1 && Object.hasOwn(PROFILES, profiles[0])) data.profile = profiles[0];
  try { Object.assign(data, parseInput(argv, cwd)); }
  catch (error) { data.reason = `Invalid diagnostics input: ${error.message}`; }
  if (data.root !== null) {
    for (const { source, timeoutMs } of PROFILES[data.profile]) data.providers.push(await runProvider(source, data.root, { profile: data.profile, timeoutMs }));
    Object.assign(data, aggregate(data.providers, PROFILES[data.profile].map(p => p.source)));
  }
  data.completedAt = new Date().toISOString();
  if (argv.includes('--json')) await write(JSON.stringify(data) + '\n');
  else {
    await write(`${data.status} (exit ${data.exitCode}) — diagnostic snapshot, not TDD, approval or gate evidence\n`);
    if (data.reason) await write(data.reason + '\n');
    for (const provider of data.providers) {
      await write(`${provider.source}: ${provider.status}${provider.reason ? ` — ${provider.reason}` : ''}\n`);
      for (const d of provider.diagnostics) await write(`  ${d.file ?? '<project>'}${d.line === null ? '' : `:${d.line}:${d.column}`} ${d.severity} ${d.code}: ${d.message}\n`);
      await write(`  files: included=${provider.files.included ?? 'unknown'} checked=${provider.files.checked ?? 'unknown'} ignored=${provider.files.ignored ?? 'unknown'} (provider-specific counts)\n`);
    }
  }
  return data.exitCode;
}
