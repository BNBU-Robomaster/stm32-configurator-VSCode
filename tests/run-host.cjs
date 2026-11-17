// Integration test: an isolated VS Code instance, real CMake Tools and a fake OpenOCD.
// No probe is opened and no MCU is programmed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { runTests } = require('@vscode/test-electron');
const { writeConfiguration } = require('../out/flash/configuration');
const project = path.resolve(__dirname, '..');
async function main() {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stm32-host-'));
 const workspace = path.join(root, 'workspace [test] $dollar with spaces');
 const extensions = path.join(root, 'extensions');
 fs.mkdirSync(workspace); fs.mkdirSync(extensions);
 let developmentPath = project;
 if (process.env.STM32_TEST_VSIX) {
  const unpacked = path.join(root, 'packaged-extension');
  cp.execFileSync('unzip', ['-q', path.resolve(process.env.STM32_TEST_VSIX), '-d', unpacked]);
  developmentPath = path.join(unpacked, 'extension');
 }
 const installed = process.env.STM32_TEST_EXTENSIONS || path.join(os.homedir(), '.vscode/extensions');
 const required = ['marus25.cortex-debug', 'ms-vscode.cmake-tools', 'mcu-debug.debug-tracker-vscode', 'mcu-debug.memory-view', 'mcu-debug.rtos-views', 'mcu-debug.peripheral-viewer'];
 for (const id of required) {
  const directory = fs.readdirSync(installed).filter(f => f.startsWith(id + '-')).sort().at(-1);
  if (!directory) throw Error(`Install the test dependency ${id} in ${installed}`);
  fs.symlinkSync(path.join(installed, directory), path.join(extensions, directory), 'dir');
 }
 const cmake = process.env.STM32_TEST_CMAKE || 'cmake';
 fs.mkdirSync(path.join(workspace, '.vscode'));
 fs.writeFileSync(path.join(workspace, '.vscode/settings.json'), JSON.stringify({ 'cmake.useCMakePresets': 'always', 'cmake.configureOnOpen': false, 'cmake.cmakePath': cmake, 'cmake.showOptionsMovedNotification': false, 'cmake.loggingLevel': 'warning', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false }));
 fs.writeFileSync(path.join(workspace, 'CMakePresets.json'), JSON.stringify({ version: 3, configurePresets: ['Debug', 'Release'].map(name => ({ name, generator: 'Unix Makefiles', binaryDir: '${sourceDir}/build/${presetName}' })), buildPresets: ['Debug', 'Release'].map(name => ({ name, configurePreset: name })) }));
 fs.writeFileSync(path.join(workspace, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.20)\nproject(FlashTest NONE)\nadd_custom_target(firmware ALL COMMAND "\${CMAKE_COMMAND}" "-DINPUT=\${CMAKE_SOURCE_DIR}/source.txt" "-DOUTPUT=\${CMAKE_BINARY_DIR}/LED.elf" "-P" "\${CMAKE_SOURCE_DIR}/build.cmake" VERBATIM)\n`);
 fs.writeFileSync(path.join(workspace, 'build.cmake'), `file(READ "\${INPUT}" content)\nif(content MATCHES "FAIL_BUILD")\n message(FATAL_ERROR "deliberate build failure")\nendif()\nfile(WRITE "\${OUTPUT}" "\${content}")\n`);
 fs.writeFileSync(path.join(workspace, 'source.txt'), 'initial firmware');
 fs.writeFileSync(path.join(workspace, 'daplink.cfg'), '# test fixture only');
 const openocd = path.join(root, 'fake-openocd');
 fs.writeFileSync(openocd, `#!/usr/bin/env node\nconst fs = require('node:fs'); const path = require('node:path');\nconst command = process.argv.at(-1);\nconst match = /^program "([^"\\n]+)" verify reset exit$/.exec(command);\nif (!match) throw Error('Incorrect program command: ' + command);\nconst firmware = fs.readFileSync(match[1], 'utf8');\nfs.appendFileSync('flash.log', JSON.stringify({ firmware, argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');\nif (firmware.includes('FAIL_VERIFY')) process.exit(2);\nconsole.log('** Programming Finished **'); console.log('** Verified OK **'); console.log('** Resetting Target **');\n`);
 fs.chmodSync(openocd, 0o755);
 for (const preset of ['Debug', 'Release']) {
  cp.execFileSync(cmake, ['--preset', preset], { cwd: workspace, stdio: 'pipe' });
  const executable = '${workspaceFolder}/build/' + preset + '/LED.elf';
  writeConfiguration(workspace, { name: preset, type: 'cortex-debug', request: 'launch', servertype: 'openocd', cwd: '${workspaceFolder}', executable, device: 'STM32F103C8', gdbPath: process.env.STM32_TEST_GDB || 'arm-none-eabi-gdb', serverpath: openocd, configFiles: ['${workspaceFolder}/daplink.cfg'] }, { name: preset, executable, buildPreset: preset, openocdPath: openocd, configFiles: ['${workspaceFolder}/daplink.cfg'], launchCommands: [] });
 }
 console.log('Host test fixtures:', root);
 try {
  await runTests({
   vscodeExecutablePath: process.env.STM32_TEST_VSCODE,
   extensionDevelopmentPath: developmentPath,
   extensionTestsPath: path.join(__dirname, 'host-suite.cjs'),
   extensionTestsEnv: { STM32_TEST_WORKSPACE: workspace },
   launchArgs: [workspace, '--new-window', '--user-data-dir', path.join(root, 'user-data'), '--extensions-dir', extensions, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates']
  });
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
