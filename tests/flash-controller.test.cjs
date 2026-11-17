const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { makeProfile } = require('../out/flash/configuration');
function emitter() { const listeners = new Set(); return { event: f => { listeners.add(f); return { dispose: () => listeners.delete(f) }; }, fire: e => [...listeners].forEach(f => f(e)), size: () => listeners.size }; }
let root, api, state, events, folder, profile, task;
const token = () => { const e = emitter(); return { isCancellationRequested: false, onCancellationRequested: e.event, cancel() { this.isCancellationRequested = true; e.fire(); } }; };
const loader = Module._load;
Module._load = function(id, ...args) { if (id === 'vscode') return new Proxy({}, { get: (_, key) => key === '__esModule' ? true : api[key] }); return loader.call(this, id, ...args); };
const { FlashController, executeTaskAndWait } = require('../out/flash/controller');
Module._load = loader;
beforeEach(() => {
 root = fs.mkdtempSync(path.join(os.tmpdir(), 'stm32-runtime-'));
 folder = { name: 'test', uri: { fsPath: root, toString: () => root } };
 profile = makeProfile({ executable: '${workspaceFolder}/build/Debug/LED.elf', buildPreset: 'Debug', openocdPath: 'openocd', configFiles: ['daplink.cfg'], launchCommands: [] });
 fs.mkdirSync(path.join(root, '.vscode')); fs.writeFileSync(path.join(root, '.vscode/stm32-flash.json'), JSON.stringify({ profiles: [profile] }));
 fs.writeFileSync(path.join(root, 'CMakePresets.json'), JSON.stringify({ configurePresets: [{ name: 'Debug', binaryDir: '${sourceDir}/build/${presetName}' }], buildPresets: [{ name: 'Debug', configurePreset: 'Debug' }] }));
 events = { process: emitter(), end: emitter(), debugStart: emitter(), debugEnd: emitter() };
 task = { name: profile.flashTask, scope: folder, definition: { type: 'process' } };
 state = { order: [], errors: [], success: [], saved: true, exitCode: 0, early: false, delay: 0, executions: [], terminated: 0 };
 api = {
  workspace: { workspaceFolders: [folder], isTrusted: true, saveAll: async () => { state.order.push('save'); return state.saved; } },
  extensions: { getExtension: () => ({}) },
  debug: { onDidStartDebugSession: events.debugStart.event, onDidTerminateDebugSession: events.debugEnd.event, registerDebugConfigurationProvider: () => ({ dispose() {} }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
  ProgressLocation: { Notification: 15 },
  window: { showErrorMessage: m => state.errors.push(m), showInformationMessage: m => state.success.push(m), withProgress: async (_, cb) => cb({ report() {} }, token()) },
  tasks: {
   fetchTasks: async () => [task], get taskExecutions() { return state.executions; },
   onDidEndTaskProcess: events.process.event, onDidEndTask: events.end.event,
   executeTask: async task => {
    state.order.push('execute'); const execution = { task, terminate() { state.terminated++; } };
    state.executions.push(execution);
    const done = () => { if (state.exitCode !== undefined) events.process.fire({ execution, exitCode: state.exitCode }); events.end.fire({ execution }); state.executions = []; };
    if (state.early) done(); else setTimeout(done, state.delay);
    return execution;
   }
  }
 };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function controller() { return new FlashController({ subscriptions: [] }); }
function config(overrides = {}) { return { type: 'cortex-debug', request: 'launch', name: profile.name, executable: profile.executable, noDebug: true, ...overrides }; }

test('Ctrl+F5 saves, executes generated task, reports success and suppresses debug session', async () => {
 const result = await controller().resolveDebugConfiguration(folder, config(), token());
 assert.equal(result, undefined); assert.deepEqual(state.order, ['save', 'execute']); assert.equal(state.success.length, 1); assert.equal(state.errors.length, 0);
});
test('F5 and unrelated launch profiles pass through untouched', async () => {
 const c = controller(); const debug = config({ noDebug: false });
 assert.equal(await c.resolveDebugConfiguration(folder, debug, token()), debug);
 const other = config({ name: 'other' }); assert.equal(await c.resolveDebugConfiguration(folder, other, token()), other);
 assert.deepEqual(state.order, []);
});
test('failed build dependency cannot be reported as success or launch debugger', async () => {
 state.exitCode = undefined;
 assert.equal(await controller().resolveDebugConfiguration(folder, config(), token()), undefined);
 assert.equal(state.success.length, 0); assert.match(state.errors[0], /编译失败/);
});
test('failed flash or verification reports failure', async () => {
 state.exitCode = 1; await controller().resolveDebugConfiguration(folder, config(), token());
 assert.equal(state.success.length, 0); assert.match(state.errors[0], /退出码 1/);
});
test('cannot flash if saving fails or the ELF entry was changed', async () => {
 state.saved = false; await controller().resolveDebugConfiguration(folder, config(), token());
 assert.deepEqual(state.order, ['save']);
 state.order = []; await controller().resolveDebugConfiguration(folder, config({ executable: 'another.elf' }), token());
 assert.deepEqual(state.order, []);
});
test('handles completion events emitted before executeTask returns', async () => {
 state.early = true; await executeTaskAndWait(task, token());
 assert.equal(events.end.size(), 0); assert.equal(events.process.size(), 0);
});
test('cancellation terminates task and disposes listeners', async () => {
 state.delay = 40; const t = token(); const pending = executeTaskAndWait(task, t);
 await Promise.resolve(); t.cancel(); await assert.rejects(pending, /已取消/);
 assert.equal(state.terminated, 1); assert.equal(events.end.size(), 0);
 await new Promise(r => setTimeout(r, 45));
});
test('rejects concurrent flash and active debug sessions', async () => {
 const c = controller(); state.delay = 25;
 const pending = c.run(folder, profile); await assert.rejects(c.run(folder, profile), /正在运行/); await pending;
 api.debug.activeDebugSession = { id: 'd' }; await assert.rejects(c.run(folder, profile), /调试会话/);
});
