import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { diagnostic, providerFailure, providerResult, sortDiagnostics } from './diagnostics.mjs';
import { nativeText, sourceInputs, jsonLines } from './diagnostics-native.mjs';

const BRIDGE = fileURLToPath(new URL('./diagnostics-python.py', import.meta.url));
/** @id CODE-DIAGPY-001 @implements REQ-DIAGPY-001 REQ-DIAGPY-002 REQ-DIAGPY-003 REQ-DIAGPY-004 REQ-DIAGPY-005 */
export async function diagnosePython(root, source, budget) {
  const output = providerResult(source);
  try {
    const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!fs.statSync(python).isFile()) throw new Error('Root .venv Python is missing');
    const { files, symlinkDirectories } = sourceInputs(root, /\.pyi?$/);
    if (files.some(file => /[\r\n]/.test(file))) throw new Error('Python input path contains CR/LF (newline)');
    async function call(action, input) {
      const result = await budget.run(python, ['-B', '-I', '-S', BRIDGE, root, source, action], {
        cwd: root, input: input === undefined ? undefined : JSON.stringify(input),
      });
      try {
        const stderr = nativeText(result.stderr);
        if (stderr.trim()) output.diagnostics.push(diagnostic(source, root, { code: 'native-stderr', severity: 'info', message: stderr }));
      } catch (error) { result.failure ??= `Invalid native stderr UTF-8: ${error.message}`; }
      return result;
    }
    function json(result) {
      if (result.failure || result.signal) throw new Error(result.failure ?? `Python terminated by ${result.signal}`);
      if (!result.stdout.length && result.code !== 0) throw new Error(`Python bridge exited with ${result.code}: ${nativeText(result.stderr)}`);
      const value = JSON.parse(nativeText(result.stdout));
      if (result.code !== 0 || value?.error) throw new Error(value?.error ?? `Python bridge exited with ${result.code}`);
      return value;
    }
    const probe = json(await call('probe'));
    if (typeof probe.version !== 'string' || (probe.configPath !== null && typeof probe.configPath !== 'string')) throw new Error('Invalid Python probe schema');
    output.version = probe.version;
    output.configPath = probe.configPath;
    if (!files.length) throw new Error('No eligible Python input files');
    let args, selected, selectionError = null;
    if (source === 'ruff') {
      args = ['check', ...(probe.configPath ? ['--config', probe.configPath] : ['--isolated']),
        '--config', 'include = ["*.py", "*.pyi"]', '--force-exclude', '--no-cache', '--no-fix', '--output-format', 'json', ...files];
      const selection = await call('tool', { args: [...args, '--show-files'] });
      if (selection.failure || selection.signal || selection.code !== 0) throw new Error(selection.failure ?? `Ruff input selection failed: ${nativeText(selection.stderr)}`);
      selected = nativeText(selection.stdout).split(/\r?\n/).filter(Boolean).map(file => path.resolve(root, file));
    } else {
      const value = json(await call('mypy-select', {
        args: ['--config-file', probe.configPath ?? os.devNull, '--python-executable', python, '--no-incremental', '--cache-dir', os.devNull],
        symlinkDirectories,
      }));
      if (!Array.isArray(value.args) || !value.args.every(v => typeof v === 'string')
        || (value.paths !== null && (!Array.isArray(value.paths) || !value.paths.every(v => typeof v === 'string')))
        || (value.selectionError !== null && typeof value.selectionError !== 'string')) throw new Error('Invalid mypy input-selection schema');
      args = [...value.args, '--output=json'];
      selected = value.paths?.map(file => path.resolve(root, file)) ?? null;
      selectionError = value.selectionError;
    }
    const candidates = new Set(files.map(file => path.resolve(file)));
    if (selected && (new Set(selected).size !== selected.length || selected.some(file => !candidates.has(file)))) throw new Error('Native Python selection contains unexpected input paths');
    if (selected && !selected.length) throw new Error('All Python input files are excluded or unselected');
    const checked = await call('tool', { args });
    const records = [];
    let parseError = null;
    if (source === 'ruff') {
      try {
        const values = JSON.parse(nativeText(checked.stdout));
        if (!Array.isArray(values)) throw new Error('Expected Ruff JSON array');
        records.push(...values);
      } catch (error) { parseError = error.message; }
    } else {
      const parsed = jsonLines(checked.stdout);
      records.push(...parsed.records);
      parseError = parsed.error;
    }
    if (checked.code === 1 && records.length === 0) parseError ??= `${source} exited 1 with empty diagnostics`;
    const pending = [];
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) { parseError = 'Invalid Python diagnostic record'; break; }
      const file = source === 'ruff' ? record.filename : record.file;
      const line = source === 'ruff' ? record.location?.row : record.line;
      const column = source === 'ruff' ? record.location?.column : record.column;
      const severities = source === 'ruff' ? { error: 'error', warning: 'warning', info: 'info', hint: 'hint' } : { error: 'error', note: 'info' };
      if ((file !== null && typeof file !== 'string') || !Number.isInteger(line) || !Number.isInteger(column)
        || (typeof record.code !== 'string' && !(source === 'mypy' && record.code === null))
        || typeof record.message !== 'string' || !Object.hasOwn(severities, record.severity)
        || (source === 'mypy' && record.hint !== undefined && record.hint !== null && typeof record.hint !== 'string')
        || (source === 'ruff' && (line < 1 || column < 1))) {
        parseError = 'Invalid Python diagnostic schema'; break;
      }
      pending.push({ file: file === null ? null : path.resolve(root, file), line: file === null || line <= 0 ? null : line,
        column, code: record.code ?? 'mypy', severity: severities[record.severity],
        message: record.message + (source === 'mypy' && record.hint ? '\n' + record.hint : '') });
    }
    const located = pending.filter(record => record.file !== null && record.line !== null);
    const locationsUnavailable = checked.failure !== null;
    const lines = located.length && !locationsUnavailable ? json(await call('locations', located.map(record => [record.file, record.line]))) : [];
    if (!locationsUnavailable && (!Array.isArray(lines) || lines.length !== located.length || !lines.every(line => typeof line === 'string'))) throw new Error('Invalid source-location bridge schema');
    let index = 0;
    const warned = new Set();
    for (const record of pending) {
      let column = null;
      if (record.file !== null && record.line !== null && !locationsUnavailable) {
        const text = lines[index++];
        if (source === 'ruff') {
          const characters = Array.from(text);
          if (record.column > characters.length + 1) throw new Error('Ruff column is outside source');
          column = characters.slice(0, record.column - 1).join('').length + 1;
        } else if (/[^\x00-\x7f]/.test(text)) {
          const key = `${fs.realpathSync(record.file)}:${record.line}`;
          if (!warned.has(key)) {
            warned.add(key);
            output.diagnostics.push(diagnostic(source, root, { ...record, column: null, code: 'location-unavailable', severity: 'info',
              message: 'mypy 2.4.0 does not provide a reliable column on this non-ASCII source line' }));
          }
        } else if (record.column >= 0) {
          if (record.column > text.length) throw new Error('mypy column is outside source');
          column = record.column + 1;
        }
      }
      output.diagnostics.push(diagnostic(source, root, { ...record, column }));
    }
    if (checked.failure || checked.signal || ![0, 1].includes(checked.code) || parseError || selectionError || !selected) {
      throw new Error(checked.failure ?? parseError ?? selectionError ?? `${source} did not complete (exit ${checked.code}, signal ${checked.signal ?? 'none'})`);
    }
    output.status = 'complete';
    output.reason = null;
    output.files = { included: files.length, checked: selected.length, ignored: files.length - selected.length };
    output.diagnostics = sortDiagnostics(output.diagnostics);
    return output;
  } catch (error) {
    return providerFailure(source, `Python ${source} diagnosis failed: ${error.message}`, { ...output, diagnostics: sortDiagnostics(output.diagnostics) });
  }
}
