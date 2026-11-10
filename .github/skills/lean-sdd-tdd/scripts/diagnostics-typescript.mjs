import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { diagnostic, providerFailure, providerResult, sortDiagnostics } from './diagnostics.mjs';

/** @id CODE-DIAGTS-001 @implements REQ-DIAGTS-001 REQ-DIAGTS-002 REQ-DIAGTS-003 REQ-DIAGTS-004 */
export function loadLocal(root, name, versionPattern) {
  const directory = fs.realpathSync(path.join(root, 'node_modules', name));
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.name !== name || !versionPattern.test(metadata.version)) throw new Error(`Unsupported ${name} version ${metadata.version}; local supported version required`);
  const require = createRequire(path.join(root, 'package.json'));
  const entry = fs.realpathSync(require.resolve(name));
  const relative = path.relative(directory, entry);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(`Refused non-local ${name} entry`);
  return { api: require(entry), version: metadata.version };
}
export function normalizeTypeScriptDiagnostic(ts, value, root) {
  const position = value.file && value.start !== undefined ? value.file.getLineAndCharacterOfPosition(value.start) : null;
  return diagnostic('typescript', root, {
    file: value.file?.fileName ?? null, line: position ? position.line + 1 : null, column: position ? position.character + 1 : null,
    code: value.code, severity: ['warning', 'error', 'hint', 'info'][value.category],
    message: ts.flattenDiagnosticMessageText(value.messageText, '\n'),
  });
}
export function selectTypeScript(root) {
  const { api: ts, version } = loadLocal(root, 'typescript', /^5\.9\.\d+$/);
  const configPath = path.join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return { ts, version, configPath, errors: [read.error], config: null };
  const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath);
  const errors = config.errors;
  if (config.projectReferences?.length) throw new Error('TypeScript project references are unsupported');
  return { ts, version, configPath, config, errors };
}
export async function diagnoseTypeScript(root) {
  let output = providerResult('typescript');
  try {
    const { ts, version, configPath, config, errors } = selectTypeScript(root);
    output.version = version;
    output.configPath = configPath;
    output.diagnostics = errors.map(d => normalizeTypeScriptDiagnostic(ts, d, root));
    if (errors.length || !config) return providerFailure('typescript', 'Invalid TypeScript config', output);
    if (!config.fileNames.length) return providerFailure('typescript', 'TypeScript config selected no input files', output);
    const program = ts.createProgram({ rootNames: config.fileNames, options: { ...config.options, noEmit: true } });
    output.diagnostics = sortDiagnostics(ts.getPreEmitDiagnostics(program).map(d => normalizeTypeScriptDiagnostic(ts, d, root)));
    output.status = 'complete';
    output.reason = null;
    output.files = { included: config.fileNames.length, checked: program.getSourceFiles().length, ignored: 0 };
    return output;
  } catch (error) {
    return providerFailure('typescript', `TypeScript diagnosis failed: ${error.message}`, output);
  }
}
