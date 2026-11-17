const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async function() {
 const root = process.env.STM32_TEST_WORKSPACE;
 const folder = vscode.workspace.workspaceFolders.find(f => f.uri.fsPath === root);
 assert.ok(folder);
 await vscode.extensions.getExtension('ms-vscode.cmake-tools').activate();
 await vscode.extensions.getExtension('sarzn.stm32-flash-configurator').activate();
 const completion = await vscode.commands.executeCommand('stm32-flash-configurator.configureCompletion', folder, 'Release');
 assert.ok(completion, 'The completion command must return a result');
 assert.match(completion.message, /已生成 .clangd/, 'Without clangd installed, tell the user what remains');
 assert.ok(fs.existsSync(path.join(root, 'build/Release/compile_commands.json')));
 assert.match(fs.readFileSync(path.join(root, '.clangd'), 'utf8'), /CompilationDatabase: "build\/Release"/);
 assert.equal(fs.existsSync(path.join(root, 'build/Release/LED.elf')), false);
 console.log('PASS: new project configures real CMake Tools and generates completion without an ELF');
 await vscode.commands.executeCommand('stm32-flash-configurator.configureCompletion', folder, 'Debug');
 assert.match(fs.readFileSync(path.join(root, '.clangd'), 'utf8'), /CompilationDatabase: "build\/Debug"/);
 console.log('PASS: existing compilation database switches the managed clangd preset');
 await vscode.commands.executeCommand('cmake.setConfigurePreset', 'Debug', folder);
 const started = [];
 const listener = vscode.debug.onDidStartDebugSession(s => started.push(s));
 const readLog = () => fs.existsSync(path.join(root, 'flash.log')) ? fs.readFileSync(path.join(root, 'flash.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
 const edit = async text => {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'source.txt')));
  await vscode.window.showTextDocument(doc);
  const change = new vscode.WorkspaceEdit();
  change.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  await vscode.workspace.applyEdit(change);
  assert.equal(doc.isDirty, true);
  return doc;
 };
 const run = async name => {
  const tasks = [];
  const done = vscode.tasks.onDidEndTaskProcess(e => tasks.push({ name: e.execution.task.name, code: e.exitCode }));
  try {
   let timer;
   const result = await Promise.race([
    vscode.debug.startDebugging(folder, name, { noDebug: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Ctrl+F5 did not finish within 45 seconds: ' + JSON.stringify(tasks))), 45000); })
   ]).finally(() => clearTimeout(timer));
   assert.equal(result, false, 'The debugger launch should be cancelled after flashing');
   assert.equal(started.length, 0, 'No debug adapter/session should start');
   assert.equal(vscode.debug.activeDebugSession, undefined);
   return tasks;
  } finally { done.dispose(); }
 };
 try {
  const doc = await edit('latest unsaved firmware');
  const success = await run('Debug');
  assert.equal(readLog().at(-1).firmware, 'latest unsaved firmware');
  assert.equal(fs.readFileSync(doc.uri.fsPath, 'utf8'), 'latest unsaved firmware');
  assert.ok(success.some(t => t.name.startsWith('STM32 Build:') && t.code === 0));
  assert.ok(success.some(t => t.name.startsWith('STM32 Flash:') && t.code === 0));
  console.log('PASS: native noDebug saves, CMake builds, OpenOCD task exits, no debugger starts');
  await edit('release firmware');
  await run('Release');
  assert.equal(readLog().at(-1).firmware, 'release firmware');
  assert.match(readLog().at(-1).argv.at(-1), /build\/Release\/LED\.elf/);
  console.log('PASS: selecting another launch profile builds and flashes its own ELF');
  const before = readLog().length;
  await edit('FAIL_BUILD');
  await run('Debug');
  assert.equal(readLog().length, before, 'Failed build must not flash a stale ELF');
  console.log('PASS: failed CMake build prevents flashing');
  await edit('FAIL_VERIFY');
  const failed = await run('Debug');
  assert.ok(failed.some(t => t.name.startsWith('STM32 Flash:') && t.code === 2));
  console.log('PASS: verification error exits without a debug session');
 } finally { listener.dispose(); }
};
