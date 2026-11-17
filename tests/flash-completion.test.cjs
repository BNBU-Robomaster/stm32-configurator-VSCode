const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAllDocuments } = require('yaml');
const { prepareCompletion, writeCompletion, hasCompilationDatabase } = require('../out/completion/configuration');
let root;
beforeEach(() => {
 root = fs.mkdtempSync(path.join(os.tmpdir(), 'stm32-completion-'));
 fs.writeFileSync(path.join(root, 'CMakePresets.json'), JSON.stringify({ version: 3,
  configurePresets: [{ name: 'base', hidden: true, binaryDir: '${sourceDir}/build/${presetName}' },
   { name: 'Debug', inherits: 'base' }, { name: 'Release', inherits: 'base' }],
  buildPresets: [{ name: 'dev', configurePreset: 'Debug' }, { name: 'release', configurePreset: 'Release' }] }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const read = () => fs.readFileSync(path.join(root, '.clangd'), 'utf8');

test('new project uses inherited configure-preset directory without requiring an ELF', () => {
 const plan = prepareCompletion(root, 'dev');
 assert.equal(plan.binaryDir, path.join(root, 'build/Debug'));
 assert.equal(plan.configurePreset, 'Debug');
 writeCompletion(plan);
 assert.equal(parseAllDocuments(read())[0].toJS().CompileFlags.CompilationDatabase, 'build/Debug');
 assert.ok(!read().includes(root), 'Configuration must remain portable');
 writeCompletion(prepareCompletion(root, 'dev'));
 assert.equal(read(), plan.text, 'Repeated generation must be idempotent');
});

test('switching presets changes only the managed scalar and preserves CRLF user fragments', () => {
 const user = '# my settings\r\nDiagnostics:\r\n  Suppress: [unused-includes]\r\n---\r\nIf:\r\n  PathMatch: Core/.*\r\nCompileFlags:\r\n  Add: [-DMY_MACRO]\r\n';
 fs.writeFileSync(path.join(root, '.clangd'), user);
 writeCompletion(prepareCompletion(root, 'dev'));
 const before = read();
 assert.ok(before.startsWith(user));
 writeCompletion(prepareCompletion(root, 'release'));
 assert.equal(read(), before.replace('"build/Debug"', '"build/Release"'));
 assert.equal(parseAllDocuments(read()).length, 3);
});

test('custom or conditional compilation databases remain byte-for-byte unchanged', () => {
 for (const original of [
  'CompileFlags:\n  CompilationDatabase: custom-build\n',
  'If:\n  PathMatch: Core/.*\nCompileFlags:\n  CompilationDatabase: None # user-owned\n',
  'CompileFlags: {CompilationDatabase: build}\n---\nCompileFlags: {CompilationDatabase: other}\n'
 ]) {
  fs.writeFileSync(path.join(root, '.clangd'), original);
  const plan = prepareCompletion(root, 'dev');
  assert.equal(plan.preserved, true);
  writeCompletion(plan);
  assert.equal(read(), original);
 }
});

test('invalid YAML and concurrent edits cannot overwrite user configuration', () => {
 fs.writeFileSync(path.join(root, '.clangd'), 'CompileFlags: [');
 assert.throws(() => prepareCompletion(root, 'dev'), /YAML/);
 assert.equal(read(), 'CompileFlags: [');
 fs.rmSync(path.join(root, '.clangd'));
 const plan = prepareCompletion(root, 'dev');
 fs.writeFileSync(path.join(root, '.clangd'), '# edited concurrently\n');
 assert.throws(() => writeCompletion(plan), /其他操作修改/);
 assert.equal(read(), '# edited concurrently\n');
});

test('missing, empty and valid compilation databases have distinct outcomes', () => {
 assert.equal(hasCompilationDatabase(root), false);
 const file = path.join(root, 'compile_commands.json');
 fs.writeFileSync(file, '[]');
 assert.throws(() => hasCompilationDatabase(root), /编译记录/);
 fs.writeFileSync(file, JSON.stringify([{ file: 'Core/Src/main.c', arguments: ['arm-none-eabi-gcc', '-c', 'Core/Src/main.c'] }]));
 assert.equal(hasCompilationDatabase(root), true);
});
