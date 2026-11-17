# STM32 Flash Configurator

为 STM32 + OpenOCD 提供图形化配置。在 VS Code 中选择一条配置后：

- **F5**：先编译，再启动 Cortex-Debug 断点调试。
- **Ctrl+F5 / 运行 → 以非调试模式运行**：保存文件 → 编译最新固件 → 烧录 → 校验 → 复位运行 → 退出 OpenOCD。

Ctrl+F5 完成后会显示“烧录成功”通知，不创建 GDB 调试会话。任务终端保留结果，单片机继续运行。也可以点击配置器中的 **编译并烧录** 按钮。

这是基于 [左岚的 STM32 Debug Configurator 1.0.3](https://github.com/zuoliangyu/stm32-configurator-by-zuolan) 的独立分支，保留 MIT 许可证和原作者署名。扩展 ID 为 `sarzn.stm32-flash-configurator`。当前通过 VSIX 安装，尚未发布至 Marketplace。

[English](README_en.md) · [变更记录](CHANGELOG.md) · [许可证](LICENSE)

## 安装

1. 在 VS Code 中安装 **CMake Tools** 和 **Cortex-Debug**。
2. 打开扩展面板右上角的 `…`，选择 **从 VSIX 安装…**，选择本项目生成的 `.vsix`。
3. 如提示重新加载窗口，点击重新加载。
4. 命令面板执行 **STM32: Generate Debug and Flash Configuration**，打开 **STM32 Flash Configurator** 页面。安装了原版时，可在扩展页面确认发布者和扩展 ID；两个版本的命令 ID 不同。

需要已安装的 CMake、OpenOCD、ARM GCC/GDB 工具链，以及可以正常编译的 CMake 工程。项目应包含 `CMakePresets.json` 或 `CMakeUserPresets.json` 中的 **buildPresets**，并先完成对应预设的 CMake 配置。

## 在界面中配置

1. 在 **可执行文件** 中选择需要烧录的 ELF。
2. 填写可选的 **配置名称**，例如 `LED Debug`、`电机测试`。不填时会使用 ELF 文件名和构建预设命名。
3. **GDB 服务器** 选择 **OpenOCD**，选择本机 OpenOCD 程序及 ARM 工具链。
4. 如需使用自己的 `daplink.cfg`，勾选 **使用项目中的 OpenOCD 配置文件**，点击 **浏览** 选择文件。这个文件应完整配置下载器、目标芯片、传输方式及速度；插件会单独加载它。
5. 在 **自动编译与烧录** 中勾选 **Ctrl+F5：自动保存、编译、烧录并退出**。
6. 选择与 ELF 对应的 **CMake 构建预设**。例如 `build/Debug/xxx.elf` 对应 `Debug`。
7. 点击 **生成配置**。
8. 到 VS Code **运行和调试** 顶部下拉框选择刚才的配置，然后按 Ctrl+F5。macOS 如功能键被系统占用，可直接使用菜单 **运行 → 以非调试模式运行**。

无需手动编辑 `launch.json`、`tasks.json` 或快捷键。扩展只接管它生成的自动烧录配置；其他运行配置仍由原调试扩展处理。

### 多个 ELF / 多个下载器

重复上述步骤，换一个配置名称、ELF 和对应构建预设后生成即可。同一份 OpenOCD 程序和 `daplink.cfg` 可以被多条配置使用；不同配置也可以指定不同下载器配置文件。每次在“运行和调试”的下拉框中选定配置后再按快捷键。

使用同一个配置名称重新生成，会更新本扩展已有的配置；同名的用户配置会报错，不会被覆盖。修改 ELF 后应通过界面重新生成，确保调试入口和烧录任务一致。

### 如何判断完成

- 成功：通知显示 **烧录成功**，任务终端显示校验与复位结果，OpenOCD 正常退出。
- 编译失败：显示错误，停止后续烧录，不会继续下载旧固件。
- 烧录或校验失败：显示失败和退出码，可查看任务终端。
- 已有调试会话：先停止调试释放下载器，再执行烧录。
- 取消：使用进度通知的“取消”，会终止此次任务。取消或失败不代表固件已经完整写入。

## 实现与生成文件

配置器保留现有 JSONC 注释、无关任务和调试配置，生成：

| 文件 | 用途 |
| --- | --- |
| `.vscode/launch.json` | Cortex-Debug 配置，F5 的编译前置任务 |
| `.vscode/tasks.json` | 对应预设的 CMake 构建任务、依赖该构建的 OpenOCD 烧录任务 |
| `.vscode/stm32-flash.json` | 将选中的调试配置映射到该 ELF 的烧录任务 |

扩展在 VS Code 的调试配置解析阶段识别 `noDebug`。Ctrl+F5 时执行生成的任务，完成后取消调试器创建。OpenOCD 使用 `program … verify reset exit`，无需启动 GDB。

适用范围：自动烧录当前支持 **OpenOCD + CMake 构建预设**，支持 ELF/AXF/HEX/S19；裸 BIN 没有内置地址，因此不自动生成烧录流程。预设输出目录支持常见的 `sourceDir`、`presetName`、`sourceParentDir`、`sourceDirName` 宏和普通文件 include；无法确认动态环境变量输出目录时会报错，避免编译目录与固件不一致。

## 开发与验证

需要 Node.js 22 或更新版本：

```sh
npm ci
npm test
npm run package
```

输出 `stm32-flash-configurator-1.1.0.vsix`。运行时依赖 `jsonc-parser` 随 VSIX 打包；Cortex-Debug 是扩展依赖，CMake Tools 用于构建。

- `npm test`：类型检查、Lint、配置生成/合并、GUI 消息、Ctrl+F5 流程和失败/取消测试。
- `npm run test:host`：独立 VS Code 窗口中的集成测试，需要本机已安装上述扩展、CMake 和 Make；使用模拟 OpenOCD，不连接硬件。可设置 `STM32_TEST_VSCODE` 指向本机 VS Code 可执行文件，否则测试工具下载 VS Code。测试脚本目前适用于 macOS/Linux。
- `npm run test:legacy`：上游设备、目标、工具链、固件扫描回归测试。

集成测试验证真实 CMake Tools 构建、未保存文件、多个 ELF、编译失败、校验失败，以及全程不创建调试会话。实板烧录与各种探针组合仍需要硬件验证。

## 仓库与发布

本分支维护在 [BNBU-Robomaster/stm32-configurator-VSCode](https://github.com/BNBU-Robomaster/stm32-configurator-VSCode)，保留上游 Git 历史及许可证。提交信息采用 Conventional Commits，例如 `feat(flash): add automatic build and flash`。`publisher: sarzn` 是当前本地 VSIX 使用的标识；发布到 Marketplace 前需使用自己拥有的 publisher。

GitHub Actions 在 push / pull request 时测试并构建 VSIX；推送版本标签时创建附带 VSIX 的 GitHub Release。工作流不会自动发布 Marketplace。不要提交本机工具安装目录、令牌、固件工程或生成的 `.vsix`；VSIX 作为 Release 附件发布。

## 许可证与来源

MIT，原作者 **左岚**。本分支新增自动编译烧录流程、原生 Ctrl+F5 分流、自定义 cfg 浏览、多配置生成和相关测试。保留原项目的设备识别、工具链检测及调试配置界面。
