const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
let api;
const loader = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? api : loader.call(this, id, ...args); };
// Keep one mutable mock object because the module captures it on import.
api = { __esModule: true };
const { CompletionController } = require('../out/completion/controller');
Module._load = loader;
let root, folder, calls, extensions, controller;
function database() {
 const dir = path.join(root, 'build/Debug'); fs.mkdirSync(dir, { recursive: true });
 fs.writeFileSync(path.join(dir, 'compile_commands.json'), JSON.stringify([{ file: 'main.c', command: 'cc -c main.c' }]));
}
beforeEach(() => {
 root = fs.mkdtempSync(path.join(os.tmpdir(), 'stm32-completion-controller-'));
 folder = { name: 'chosen project', uri: { fsPath: root } }; calls = [];
 fs.writeFileSync(path.join(root, 'CMakePresets.json'), JSON.stringify({ version: 3,
  configurePresets: [{ name: 'Debug', binaryDir: '${sourceDir}/build/Debug' }],
  buildPresets: [{ name: 'build-debug', configurePreset: 'Debug' }] }));
 extensions = new Map([
  ['ms-vscode.cmake-tools', { activate: async () => ({ getApi: () => ({ getActiveFolderPath: async () => root }) }) }],
  ['stmicroelectronics.stm32cube-ide-clangd', { isActive: true }]
 ]);
 Object.assign(api, {
  workspace: { isTrusted: true, saveAll: async () => { calls.push(['save']); return true; } },
  window: { withProgress: async (_opts, work) => work() }, ProgressLocation: { Notification: 15 },
  extensions: { getExtension: id => extensions.get(id) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async (...args) => {
   calls.push(args); if (args[0] === 'cmake.configure') { database(); return 0; }
  } }
 });
 controller = new CompletionController({ subscriptions: [] });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('fresh project saves, selects the correct folder/preset, configures CMake and restarts active clangd', async () => {
 const result = await controller.configure(folder, 'build-debug');
 assert.equal(result.warning, false);
 assert.deepEqual(calls.map(c => c[0]), ['save', 'cmake.selectActiveFolder', 'cmake.setConfigurePreset', 'cmake.configure', 'stm32cube-ide-clangd.restart']);
 assert.deepEqual(calls[1][1], [folder.name]);
 assert.equal(calls[2][1], 'Debug');
 assert.equal(calls[3][1], root);
 assert.match(fs.readFileSync(path.join(root, '.clangd'), 'utf8'), /build\/Debug/);
});

test('existing database needs no CMake extension and inactive clangd waits for a source file', async () => {
 database(); extensions.delete('ms-vscode.cmake-tools');
 extensions.get('stmicroelectronics.stm32cube-ide-clangd').isActive = false;
 assert.equal((await controller.configure(folder, 'build-debug')).warning, false);
 assert.deepEqual(calls, [['save']]);
});

test('a different active CMake folder is detected before changing its preset', async () => {
 extensions.set('ms-vscode.cmake-tools', { activate: async () => ({ getApi: () => ({ getActiveFolderPath: async () => path.join(root, 'other') }) }) });
 await assert.rejects(controller.configure(folder, 'build-debug'), /不一致/);
 assert.deepEqual(calls.map(c => c[0]), ['save', 'cmake.selectActiveFolder']);
 assert.equal(fs.existsSync(path.join(root, '.clangd')), false);
});

test('failed CMake configuration never claims success or writes .clangd; retry remains possible', async () => {
 const original = api.commands.executeCommand;
 api.commands.executeCommand = async () => 1;
 await assert.rejects(controller.configure(folder, 'build-debug'), /CMake 配置失败/);
 assert.equal(fs.existsSync(path.join(root, '.clangd')), false);
 api.commands.executeCommand = original;
 assert.equal((await controller.configure(folder, 'build-debug')).warning, false);
});

test('custom database is preserved without CMake changes; missing clangd is reported honestly', async () => {
 fs.writeFileSync(path.join(root, '.clangd'), 'CompileFlags: {CompilationDatabase: custom}\n');
 assert.equal((await controller.configure(folder, 'build-debug')).warning, true);
 assert.deepEqual(calls, [['save']]);
 fs.rmSync(path.join(root, '.clangd'));
 database(); extensions.clear();
 const result = await controller.configure(folder, 'build-debug');
 assert.equal(result.warning, true);
 assert.match(result.message, /启用.*clangd/);
 assert.equal(fs.existsSync(path.join(root, '.clangd')), true);
});

test('untrusted workspaces and unsaved changes prevent CMake execution', async () => {
 api.workspace.isTrusted = false;
 await assert.rejects(controller.configure(folder, 'build-debug'), /信任/);
 assert.deepEqual(calls, []);
 api.workspace.isTrusted = true;
 api.workspace.saveAll = async () => false;
 await assert.rejects(controller.configure(folder, 'build-debug'), /保存/);
 assert.deepEqual(calls, []);
});
