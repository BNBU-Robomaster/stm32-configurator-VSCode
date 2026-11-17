# STM32 Flash Configurator

A fork of [STM32 Debug Configurator by 左岚](https://github.com/zuoliangyu/stm32-configurator-by-zuolan), licensed under MIT.

- **F5** builds the selected firmware and starts Cortex-Debug.
- **Ctrl+F5 / Run Without Debugging** saves files, builds the chosen CMake preset, programs and verifies the firmware, resets the MCU to run, and exits OpenOCD. No GDB session is created.

Install the VSIX using **Extensions → … → Install from VSIX**, with Cortex-Debug and CMake Tools installed. Open **STM32: Generate Debug and Flash Configuration**, choose your ELF, OpenOCD and ARM toolchain, enable **Ctrl+F5: save, build, flash and exit**, select the matching build preset, and generate the configuration. Select that configuration in VS Code's Run and Debug dropdown before using Ctrl+F5.

To use a project `daplink.cfg`, enable **Use a project OpenOCD cfg** and browse to it. The cfg must provide the complete probe/target/transport/speed configuration. To use multiple ELFs, generate a separate named configuration for each ELF and its build preset. Reusing a managed name updates that profile; unrelated configurations and JSONC comments are preserved.

The extension generates `.vscode/launch.json`, `.vscode/tasks.json`, and `.vscode/stm32-flash.json`. Native `noDebug` launches for these managed profiles execute the build/flash task and cancel debugger creation. Other debug configurations are unchanged. A failed build prevents flashing stale firmware. Errors and cancellation never report success.

Automatic flashing requires a configured CMake project with build presets and OpenOCD. ELF/AXF/HEX/S19 files are supported; raw BIN files require an address and are not supported by this workflow. Common CMake preset output-directory macros and ordinary include files are supported. Dynamic output directories that cannot be checked are rejected.

Development requires Node.js 22+: `npm ci`, `npm test`, `npm run package`. `npm run test:host` exercises an isolated VS Code instance with real CMake Tools and fake OpenOCD, without hardware. The host-test launcher currently supports macOS/Linux; set `STM32_TEST_VSCODE` to a local VS Code executable to avoid downloading it. Hardware validation is still required.

This fork is maintained at [BNBU-Robomaster/stm32-configurator-VSCode](https://github.com/BNBU-Robomaster/stm32-configurator-VSCode), has a separate extension ID, `sarzn.stm32-flash-configurator`, and is distributed as a VSIX. Commit messages follow Conventional Commits. Marketplace publishing requires a publisher account you own. CI packages VSIX artifacts; version tags create GitHub Releases without publishing to Marketplace.

See [the Chinese guide](README.md), [CHANGELOG](CHANGELOG.md) and [LICENSE](LICENSE).
