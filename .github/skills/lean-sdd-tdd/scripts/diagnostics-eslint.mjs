import fs from 'node:fs';
import path from 'node:path';
import { diagnostic, providerFailure, providerResult, sortDiagnostics } from './diagnostics.mjs';
import { loadLocal, selectTypeScript } from './diagnostics-typescript.mjs';
import { sourceInputs } from './diagnostics-native.mjs';

/** @id CODE-DIAGESL-001 @implements REQ-DIAGESL-001 REQ-DIAGESL-002 REQ-DIAGESL-003 REQ-DIAGESL-004 */
/** @id CODE-DIAGJS-001 @implements REQ-DIAGJS-001 REQ-DIAGJS-002 REQ-DIAGJS-003 */
export async function diagnoseESLint(root, { profile = 'typescript' } = {}) {
  let output = providerResult('eslint');
  try {
    const { api: { ESLint }, version } = loadLocal(root, 'eslint', /^9\.\d+\.\d+$/);
    output.version = version;
    const configs = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'].map(name => path.join(root, name)).filter(file => fs.existsSync(file));
    if (configs.length !== 1) return providerFailure('eslint', 'Exactly one root ESLint flat config is required', output);
    output.configPath = configs[0];
    let inputs;
    if (profile === 'javascript') inputs = sourceInputs(root, /\.(?:js|jsx|mjs|cjs)$/i, ['.git', 'node_modules', '.venv']).files;
    else {
      const { config, errors } = selectTypeScript(root);
      if (!config || errors.length) return providerFailure('eslint', 'Invalid TypeScript config for ESLint input selection', output);
      inputs = config.fileNames.filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) && !/\.d\.(?:[cm]?ts)$/i.test(file));
    }
    if (!inputs.length) return providerFailure('eslint', 'ESLint has no eligible input files', output);
    const eslint = new ESLint({ cwd: root, overrideConfigFile: output.configPath, fix: false, cache: false, errorOnUnmatchedPattern: true });
    let ignored = 0;
    const targets = [];
    for (const file of inputs) {
      if (await eslint.isPathIgnored(file)) ignored++;
      else targets.push(file);
    }
    if (!targets.length) return providerFailure('eslint', 'All ESLint input files are ignored or unconfigured', output);
    for (const file of targets) {
      const results = await eslint.lintFiles([file]);
      if (results.length !== 1 || path.resolve(results[0].filePath) !== path.resolve(file)) throw new Error(`Unexpected ESLint results for ${file}`);
      for (const value of results[0].messages) output.diagnostics.push(diagnostic('eslint', root, {
        file: results[0].filePath, line: value.line ?? null, column: value.column ?? null,
        code: value.ruleId ?? (value.fatal ? 'ESLINT_PARSE' : 'ESLINT_CONFIG'),
        severity: value.severity === 2 ? 'error' : 'warning', message: value.message,
      }));
    }
    output.status = 'complete';
    output.reason = null;
    output.files = { included: inputs.length, checked: targets.length, ignored };
    output.diagnostics = sortDiagnostics(output.diagnostics);
    return output;
  } catch (error) {
    return providerFailure('eslint', `ESLint diagnosis failed: ${error.message}`, output);
  }
}
