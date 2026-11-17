const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const loader = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? {} : loader.call(this, id, ...args); };
const { StateManager } = require('../out/services/stateManager');
Module._load = loader;
test('GUI flash choices survive reopening, and each workspace folder has its own state', async () => {
 const storage = new Map();
 const context = { workspaceState: { get: key => storage.get(key), update: async (key, value) => storage.set(key, value) } };
 const state = { configurationName: 'LED', flashEnabled: false, buildPreset: 'Release', useProjectCfg: true, projectCfg: '${workspaceFolder}/daplink.cfg' };
 await new StateManager(context, 'folderA').saveState(state);
 assert.deepEqual(await new StateManager(context, 'folderA').loadState(), state);
 assert.deepEqual(await new StateManager(context, 'folderB').loadState(), {});
});
