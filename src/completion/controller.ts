import * as vscode from 'vscode';
import * as path from 'path';
import { listBuildPresets } from '../flash/configuration';
import { hasCompilationDatabase, prepareCompletion, writeCompletion } from './configuration';

export const COMPLETION_COMMAND = 'stm32-flash-configurator.configureCompletion';
export interface CompletionResult { message: string; warning: boolean }

export class CompletionController {
    private running = false;

    constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push(vscode.commands.registerCommand(COMPLETION_COMMAND, async (folder?: vscode.WorkspaceFolder, preset?: string) => {
            try {
                const selectedFolder = folder ?? ((vscode.workspace.workspaceFolders?.length === 1)
                    ? vscode.workspace.workspaceFolders[0] : await vscode.window.showWorkspaceFolderPick());
                if (!selectedFolder) { return; }
                const presets = listBuildPresets(selectedFolder.uri.fsPath);
                const selectedPreset = preset ?? await vscode.window.showQuickPick(presets, { placeHolder: '选择用于代码补全的 CMake 构建预设' });
                if (!selectedPreset) {
                    if (!presets.length) { void vscode.window.showInformationMessage('当前工程未找到 CMake 构建预设。'); }
                    return;
                }
                const result = await this.configure(selectedFolder, selectedPreset);
                this.notify(result);
                return result;
            } catch (error) {
                void vscode.window.showErrorMessage(`代码补全配置未完成：${error instanceof Error ? error.message : error}`);
                return { warning: true, message: String(error) };
            }
        }));
    }

    notify(result: CompletionResult): void {
        if (result.warning) { void vscode.window.showWarningMessage(result.message); }
        else { void vscode.window.showInformationMessage(result.message); }
    }

    async configure(folder: vscode.WorkspaceFolder, preset: string): Promise<CompletionResult> {
        if (!vscode.workspace.isTrusted) { throw new Error('请先信任此工作区。'); }
        if (this.running) { throw new Error('已有代码补全配置正在进行。'); }
        this.running = true;
        try {
            if (!(await vscode.workspace.saveAll(false))) { throw new Error('文件未能保存。'); }
            const plan = prepareCompletion(folder.uri.fsPath, preset);
            if (plan.preserved) {
                return { warning: true, message: '已保留 .clangd 中自定义的编译信息目录；未切换到所选预设。' };
            }
            if (!hasCompilationDatabase(plan.binaryDir)) {
                const cmake = vscode.extensions.getExtension('ms-vscode.cmake-tools');
                if (!cmake) { throw new Error('请在当前 VS Code 配置文件中启用 CMake Tools，以生成编译信息。'); }
                const exports = await cmake.activate();
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `STM32：准备 ${preset} 代码补全` }, async () => {
                    // CMake Tools' preset command operates on its active project. Select and
                    // verify that project before changing a preset in a multi-folder workspace.
                    await vscode.commands.executeCommand('cmake.selectActiveFolder', [folder.name]);
                    const api = exports.getApi(1);
                    if (path.resolve(await api.getActiveFolderPath()) !== path.resolve(folder.uri.fsPath)) {
                        throw new Error('CMake 活动工程与所选文件夹不一致，请在 CMake 视图选择该工程。');
                    }
                    await vscode.commands.executeCommand('cmake.setConfigurePreset', plan.configurePreset, folder);
                    const code = await vscode.commands.executeCommand('cmake.configure', folder.uri.fsPath);
                    if (code !== 0) { throw new Error('CMake 配置失败或已取消，请查看 CMake 输出。'); }
                });
                if (!hasCompilationDatabase(plan.binaryDir)) {
                    throw new Error('CMake 未生成 compile_commands.json。请使用 Ninja/Makefiles，并启用 CMAKE_EXPORT_COMPILE_COMMANDS。');
                }
            }
            writeCompletion(plan);
            const providers = [
                ['stmicroelectronics.stm32cube-ide-clangd', 'stm32cube-ide-clangd.restart'],
                ['llvm-vs-code-extensions.vscode-clangd', 'clangd.restart']
            ];
            const provider = providers.find(([id]) => vscode.extensions.getExtension(id));
            if (!provider) {
                return { warning: true, message: '已生成 .clangd；请在当前 VS Code 配置文件中启用 STM32Cube clangd 或 clangd 扩展，打开 C/C++ 文件后即可使用补全。' };
            }
            if (vscode.extensions.getExtension(provider[0])?.isActive) {
                try { await vscode.commands.executeCommand(provider[1]); }
                catch {
                    return { warning: true, message: '补全路径已配置；请运行 clangd 的 Restart language server 或重新加载窗口。' };
                }
            }
            return { warning: false, message: `代码补全已配置：${preset}。打开 C/C++ 文件，等待索引完成后即可使用函数补全与跳转。` };
        } finally { this.running = false; }
    }
}
