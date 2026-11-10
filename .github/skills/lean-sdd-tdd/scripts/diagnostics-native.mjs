import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

/** @id CODE-DIAGCLI-003 @implements REQ-DIAGCLI-004 */
export function nativeBudget({ timeoutMs = 60000, outputBytes = 8388608, clock = () => performance.now() } = {}) {
  const started = clock();
  let bytes = 0, failure = null;
  return {
    async run(command, args, { cwd, env = process.env, input } = {}) {
      const remaining = timeoutMs - (clock() - started);
      if (remaining <= 0) failure ??= `Native provider timed out after ${timeoutMs} ms`;
      if (failure) return { code: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), failure };
      return new Promise(resolve => {
        const stdout = [], stderr = [];
        const child = spawn(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        const abort = reason => {
          failure ??= reason;
          child.kill('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdin.destroy();
        };
        const timer = setTimeout(() => abort(`Native provider timed out after ${timeoutMs} ms`), remaining);
        const capture = (chunk, output) => {
          const available = Math.max(0, outputBytes - bytes);
          bytes += chunk.length;
          if (available) output.push(chunk.subarray(0, available));
          if (bytes > outputBytes) abort(`Native provider output exceeds ${outputBytes} bytes`);
        };
        child.stdout.on('data', chunk => capture(chunk, stdout));
        child.stderr.on('data', chunk => capture(chunk, stderr));
        child.stdin.on('error', error => { failure ??= `Native input failed: ${error.message}`; });
        child.on('error', error => { failure ??= `Native spawn failed: ${error.message}`; });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (clock() - started >= timeoutMs) failure ??= `Native provider timed out after ${timeoutMs} ms`;
          resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), failure });
        });
        child.stdin.end(input);
      });
    },
  };
}
export function nativeText(buffer) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}
export function jsonLines(buffer) {
  const records = [];
  let start = 0;
  try {
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start);
      const end = newline === -1 ? buffer.length : newline;
      const line = nativeText(buffer.subarray(start, end));
      if (line.trim()) records.push(JSON.parse(line));
      start = end + 1;
    }
    return { records, error: null };
  } catch (error) {
    return { records, error: `Invalid native JSONL: ${error.message}` };
  }
}
export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export function sourceInputs(root, extensions, excluded = ['.git', '.venv']) {
  const files = [], symlinkDirectories = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(directory, entry.name);
      if (excluded.includes(entry.name)) continue;
      const stat = entry.isSymbolicLink() ? fs.statSync(file) : entry;
      if (stat.isDirectory()) {
        if (entry.isSymbolicLink()) symlinkDirectories.push(path.relative(root, file).split(path.sep).join('/'));
        else walk(file);
      } else if (stat.isFile() && extensions.test(entry.name)) files.push(file);
    }
  }
  walk(root);
  return { files, symlinkDirectories };
}
