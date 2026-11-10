import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { diagnostic, providerFailure, providerResult, sortDiagnostics } from './diagnostics.mjs';
import { inside, nativeText, jsonLines } from './diagnostics-native.mjs';

function executable(name, root) {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const extension of extensions) {
      const file = path.resolve(root, directory, name + extension.toLowerCase());
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return file;
    }
  }
  throw new Error(`Installed ${name} executable is missing from PATH`);
}
/** @id CODE-DIAGRUST-001 @implements REQ-DIAGRUST-001 REQ-DIAGRUST-002 REQ-DIAGRUST-003 REQ-DIAGRUST-004 REQ-DIAGRUST-005 */
export async function diagnoseRust(root, scratch, budget) {
  const source = 'cargo-check', output = providerResult(source);
  try {
    if (!scratch || inside(root, fs.realpathSync(scratch))) throw new Error('Private external Rust scratch is required');
    const manifest = path.join(root, 'Cargo.toml');
    if (!fs.statSync(manifest).isFile()) throw new Error('Root Cargo.toml is required');
    if (!fs.existsSync(path.join(root, 'Cargo.lock')) || !fs.statSync(path.join(root, 'Cargo.lock')).isFile()) throw new Error('Existing root Cargo.lock is required');
    const home = fs.realpathSync(process.env.CARGO_HOME ? path.resolve(root, process.env.CARGO_HOME) : path.join(os.homedir(), '.cargo'));
    if (!fs.statSync(home).isDirectory() || inside(root, home)) throw new Error('Cargo home must be an existing external directory outside the project');
    const cargo = executable('cargo', root), rustc = executable('rustc', root);
    const env = { ...process.env, CARGO_HOME: home, RUSTC: rustc, RUSTUP_AUTO_INSTALL: '0', CARGO_TERM_COLOR: 'never' };
    output.configPath = manifest;
    async function run(command, args) {
      return budget.run(command, args, { cwd: root, env });
    }
    function successful(result, stage) {
      if (result.failure || result.signal || result.code !== 0) throw new Error(result.failure ?? `${stage} failed (exit ${result.code}): ${nativeText(result.stderr)}`);
      return nativeText(result.stdout);
    }
    const cargoVersion = successful(await run(cargo, ['-V']), 'Installed cargo toolchain probe');
    const rustVersion = successful(await run(rustc, ['-vV']), 'Installed rustc toolchain probe');
    if (!/^cargo 1\.99\.\d+ /m.test(cargoVersion) || !/^release: 1\.99\.\d+$/m.test(rustVersion)) throw new Error('Unsupported cargo/rustc version; installed 1.99.x is required');
    output.version = `${cargoVersion.trim()}; ${rustVersion.split('\n')[0]}`;
    const policy = ['--offline', '--locked', '--manifest-path', manifest, '--config', 'cache.auto-clean-frequency="never"'];
    const metadata = JSON.parse(successful(await run(cargo, ['metadata', ...policy, '--no-deps', '--format-version=1']), 'Cargo metadata'));
    if (!Array.isArray(metadata.packages) || metadata.packages.length !== 1 || !Array.isArray(metadata.workspace_members)
      || metadata.workspace_members.length !== 1 || typeof metadata.workspace_root !== 'string'
      || fs.realpathSync(metadata.workspace_root) !== root) throw new Error('Only the selected root single-package workspace is supported');
    const selected = metadata.packages[0];
    if (typeof selected.id !== 'string' || metadata.workspace_members[0] !== selected.id
      || fs.realpathSync(selected.manifest_path) !== manifest || !Array.isArray(selected.targets)) throw new Error('Invalid selected-package metadata');
    const roots = new Set(selected.targets.map(target => {
      if (typeof target.src_path !== 'string') throw new Error('Invalid Cargo target source root');
      return fs.realpathSync(target.src_path);
    }));
    if (!roots.size) throw new Error('Cargo metadata has no supported target roots');
    const checked = new Set();
    const result = await run(cargo, ['check', ...policy, '--all-targets', '--target-dir', scratch,
      '--config', `build.build-dir=${JSON.stringify(path.join(scratch, 'intermediates'))}`, '--message-format=json', '--color=never', '--quiet']);
    const parsed = jsonLines(result.stdout);
    let finished = null, foreignError = false, selectedError = false, protocolError = null;
    for (const value of parsed.records) {
      if (!value || typeof value.reason !== 'string') { protocolError = 'Invalid Cargo message schema'; break; }
      if (finished !== null) { protocolError = 'Unexpected Cargo record after build-finished'; break; }
      if (value.reason === 'build-finished') {
        if (finished !== null || typeof value.success !== 'boolean') { protocolError = 'Invalid or duplicate Cargo finished report'; break; }
        finished = value.success;
      } else if (value.reason === 'compiler-message' || value.reason === 'compiler-artifact') {
        if (typeof value.package_id !== 'string' || typeof value.target?.src_path !== 'string') { protocolError = 'Invalid Cargo target record'; break; }
        const target = fs.realpathSync(value.target.src_path);
        const owned = value.package_id === selected.id && roots.has(target);
        if (value.package_id === selected.id && !owned) { protocolError = 'Cargo reported an unexpected selected-package target'; break; }
        if (owned) checked.add(target);
        if (value.reason === 'compiler-message') {
          const messages = [value.message];
          for (let index = 0; index < messages.length; index++) {
            const message = messages[index];
            const severities = { error: 'error', warning: 'warning', note: 'info', help: 'hint', 'failure-note': 'info' };
            if (!message || !Object.hasOwn(severities, message.level) || typeof message.message !== 'string' || !Array.isArray(message.spans)
              || (message.children !== undefined && !Array.isArray(message.children))
              || (message.code !== null && message.code !== undefined && typeof message.code?.code !== 'string')) { protocolError = 'Invalid rustc diagnostic schema'; break; }
            const severity = severities[message.level];
            if (severity === 'error') { if (owned) selectedError = true; else foreignError = true; }
            const primary = message.spans.find(span => span?.is_primary === true);
            let file = null, line = null, column = null;
            if (primary) {
              if (typeof primary.file_name !== 'string' || !Number.isInteger(primary.byte_start) || primary.byte_start < 0) { protocolError = 'Invalid rustc primary span'; break; }
              file = path.resolve(root, primary.file_name);
              const bytes = fs.readFileSync(file);
              if (primary.byte_start > bytes.length) { protocolError = 'rustc byte offset is outside source'; break; }
              const before = nativeText(bytes.subarray(0, primary.byte_start));
              const lines = before.split('\n');
              line = lines.length;
              column = lines.at(-1).length + 1;
            }
            output.diagnostics.push(diagnostic(source, root, { file, line, column, code: message.code?.code ?? 'rustc', severity, message: message.message }));
            for (const child of message.children ?? []) messages.push(child);
          }
          if (protocolError) break;
        }
      } else if (value.reason !== 'build-script-executed') { protocolError = `Unexpected Cargo record: ${value.reason}`; break; }
    }
    protocolError ??= parsed.error;
    const stderr = stripVTControlCharacters(nativeText(result.stderr));
    const operationalError = stderr.split('\n').some(line => /^error(?:\[[^\]]+\])?:/.test(line)
      && !/^error: could not compile .+ due to \d+ previous errors?(?:; \d+ warnings? emitted)?\r?$/.test(line));
    if (stderr.trim()) output.diagnostics.push(diagnostic(source, root, { code: 'native-stderr', severity: 'info', message: stderr }));
    if (result.failure || result.signal || protocolError || foreignError || operationalError || !checked.size || checked.size > roots.size
      || !((result.code === 0 && finished === true && !selectedError) || (result.code === 101 && finished === false && selectedError))) {
      throw new Error(result.failure ?? protocolError ?? `Cargo build did not finish a supported compiler outcome (exit ${result.code}, finished ${finished}, foreign errors ${foreignError}): ${stderr}`);
    }
    output.status = 'complete';
    output.reason = null;
    output.files = { included: roots.size, checked: checked.size, ignored: 0 };
    output.diagnostics = sortDiagnostics(output.diagnostics);
    return output;
  } catch (error) {
    return providerFailure(source, `Rust diagnosis failed: ${error.message}`, { ...output, diagnostics: sortDiagnostics(output.diagnostics) });
  }
}
