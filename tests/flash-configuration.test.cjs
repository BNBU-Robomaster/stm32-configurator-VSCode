const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeProfile, makeTasks, prepareConfiguration, writeConfiguration, readJsonc, loadProfiles, listBuildPresets, tclWord, assertFirmwareInBuildDirectory } = require('../out/flash/configuration');
let root;
const options = (overrides = {}) => ({ executable: '${workspaceFolder}/build/Debug/LED.elf', buildPreset: 'Debug', openocdPath: '/tools with spaces/openocd', configFiles: ['${workspaceFolder}/daplink.cfg'], launchCommands: [], ...overrides });
const debug = { name: 'LED', type: 'cortex-debug', request: 'launch', servertype: 'openocd', executable: '${workspaceFolder}/build/Debug/LED.elf' };
const presets = { version: 3, configurePresets: [{ name: 'base', hidden: true, binaryDir: '${sourceDir}/build/${presetName}' }, { name: 'Debug', inherits: 'base' }, { name: 'Release', inherits: 'base' }], buildPresets: [{ name: 'Debug', configurePreset: 'Debug' }, { name: 'Release', configurePreset: 'Release' }] };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'stm32-flash-')); fs.writeFileSync(path.join(root, 'CMakePresets.json'), JSON.stringify(presets)); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('generated task builds correct preset before OpenOCD, verifies, runs and exits', () => {
 const p = makeProfile(options()); const [build, flash] = makeTasks(p, options());
 assert.equal(build.preset, 'Debug'); assert.equal(build.type, 'cmake');
 assert.equal(flash.dependsOn, build.label); assert.equal(flash.type, 'process');
 assert.equal(flash.command, '/tools with spaces/openocd');
 assert.deepEqual(flash.args.slice(0, 4), ['-s', '${workspaceFolder}', '-f', '${workspaceFolder}/daplink.cfg']);
 assert.match(flash.args.at(-1), /^program .* verify reset exit$/);
 assert.equal(flash.args.at(-1), 'program "./build/Debug/LED.elf" verify reset exit');
 assert.equal(flash.args.some(x => x.includes('interface/')), false);
});

test('preserves unrelated JSONC configs, comments, inputs and tasks', () => {
 const l = '{ // keep my comment\n "version":"0.2.0", "configurations":[{"name":"other","type":"node"},], "inputs":[{"id":"x"}]}';
 const t = '{"version":"2.0.0","tasks":[{"label":"user task","command":"echo"}],"inputs":[{"id":"y"}]}';
 const result = prepareConfiguration(l, t, '{"version":1,"profiles":[]}', debug, options());
 assert.match(result.launch, /keep my comment/);
 assert.deepEqual(readJsonc(result.launch).configurations[0], { name: 'other', type: 'node' });
 assert.equal(readJsonc(result.tasks).tasks[0].label, 'user task');
 assert.equal(readJsonc(result.tasks).inputs[0].id, 'y');
});

test('regeneration updates owned entries instead of adding duplicates', () => {
 writeConfiguration(root, debug, options({ name: 'LED' }));
 writeConfiguration(root, debug, options({ name: 'LED', openocdPath: '/new/openocd' }));
 assert.equal(loadProfiles(root).length, 1);
 const tasks = readJsonc(fs.readFileSync(path.join(root, '.vscode/tasks.json'), 'utf8')).tasks;
 assert.equal(tasks.length, 2); assert.equal(tasks[1].command, '/new/openocd');
 assert.equal(readJsonc(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8')).configurations.length, 1);
});

test('regeneration repairs legacy gcc matcher without changing unrelated user tasks', () => {
 writeConfiguration(root, debug, options({ name: 'LED' }));
 const taskFile = path.join(root, '.vscode/tasks.json');
 const old = readJsonc(fs.readFileSync(taskFile, 'utf8'));
 old.tasks[0].problemMatcher = ['$gcc'];
 old.tasks.push({ label: 'user task', type: 'shell', command: 'gcc', problemMatcher: ['$gcc'] });
 fs.writeFileSync(taskFile, JSON.stringify(old));
 writeConfiguration(root, debug, options({ name: 'LED' }));
 const updated = readJsonc(fs.readFileSync(taskFile, 'utf8')).tasks;
 assert.equal(updated.length, 3);
 assert.deepEqual(updated[0].problemMatcher, []);
 assert.deepEqual(updated[2], old.tasks[2]);
});

test('two ELFs and two presets have independent profiles and dependencies', () => {
 writeConfiguration(root, debug, options());
 writeConfiguration(root, { ...debug, executable: '${workspaceFolder}/build/Release/LED.elf' }, options({ executable: '${workspaceFolder}/build/Release/LED.elf', buildPreset: 'Release' }));
 const profiles = loadProfiles(root); assert.equal(profiles.length, 2); assert.notEqual(profiles[0].flashTask, profiles[1].flashTask);
});

test('disabling automatic flash removes only owned tasks and mapping', () => {
 writeConfiguration(root, debug, options({ name: 'LED' }));
 writeConfiguration(root, { ...debug, name: 'Other' }, options({ name: 'Other' }));
 writeConfiguration(root, debug);
 assert.deepEqual(loadProfiles(root).map(p => p.name), ['Other']);
 const tasks = readJsonc(fs.readFileSync(path.join(root, '.vscode/tasks.json'), 'utf8')).tasks;
 assert.equal(tasks.length, 2); assert.ok(tasks.every(t => t.label.includes('Other')));
 const launch = readJsonc(fs.readFileSync(path.join(root, '.vscode/launch.json'), 'utf8'));
 assert.equal(launch.configurations.length, 2);
 assert.equal(launch.configurations.find(c => c.name === 'LED').preLaunchTask, undefined);
});

test('rejects stale Debug ELF with Release preset before any files are written', () => {
 assert.throws(() => writeConfiguration(root, debug, options({ buildPreset: 'Release' })), /构建输出目录/);
 assert.equal(fs.existsSync(path.join(root, '.vscode')), false);
});

test('invalid user JSON is left byte-for-byte unchanged', () => {
 fs.mkdirSync(path.join(root, '.vscode')); const file = path.join(root, '.vscode/tasks.json');
 fs.writeFileSync(file, '{ broken');
 assert.throws(() => writeConfiguration(root, debug, options()), /格式有误/);
 assert.equal(fs.readFileSync(file, 'utf8'), '{ broken'); assert.equal(fs.existsSync(path.join(root, '.vscode/launch.json')), false);
});

test('does not replace unrelated launch configuration sharing a name', () => {
 assert.throws(() => prepareConfiguration('{"configurations":[{"name":"LED","type":"node"}]}', '{"tasks":[]}', '{"profiles":[]}', debug, options({ name: 'LED' })), /已被其他配置/);
});

test('path words escape Tcl substitutions, and process args avoid shell evaluation', () => {
 const word = tclWord('/project [x]/a$HOME";evil.elf');
 assert.equal(word, '"/project \\[x\\]/a\\$HOME\\";evil.elf"');
 assert.throws(() => tclWord('a\nb.elf'), /换行/);
 assert.throws(() => makeProfile(options({ executable: 'firmware.bin' })), /BIN/);
});

test('discovers included presets and detects inheritance cycles', () => {
 fs.writeFileSync(path.join(root, 'included.json'), JSON.stringify(presets));
 fs.writeFileSync(path.join(root, 'CMakePresets.json'), '{"include":["included.json"],"buildPresets":[{"name":"hidden","hidden":true}]}');
 assert.deepEqual(listBuildPresets(root), ['Debug', 'Release']);
 assert.doesNotThrow(() => assertFirmwareInBuildDirectory(root, 'Debug', '${workspaceFolder}/build/Debug/LED.elf'));
 fs.writeFileSync(path.join(root, 'CMakeUserPresets.json'), '{"buildPresets":[{"name":"cycle","inherits":"cycle"}]}');
 assert.throws(() => assertFirmwareInBuildDirectory(root, 'cycle', 'a.elf'), /循环/);
});
