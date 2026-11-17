import * as vscode from 'vscode';
import * as path from 'path';
import { FlashProfile, loadProfiles, assertFirmwareInBuildDirectory } from './configuration';

export const FLASH_COMMAND = 'stm32-flash-configurator.flash';

/** Native Ctrl+F5 supplies noDebug before providers run; F5 passes through to Cortex-Debug. */
export class FlashController implements vscode.DebugConfigurationProvider {
    private running = false;
    private readonly sessions = new Set<string>();

    constructor(private readonly context: vscode.ExtensionContext) {
        if (vscode.debug.activeDebugSession) { this.sessions.add(vscode.debug.activeDebugSession.id); }
        context.subscriptions.push(
            vscode.debug.onDidStartDebugSession(s => this.sessions.add(s.id)),
            vscode.debug.onDidTerminateDebugSession(s => this.sessions.delete(s.id)),
            vscode.debug.registerDebugConfigurationProvider('cortex-debug', this),
            vscode.commands.registerCommand(FLASH_COMMAND, () => this.pickAndRun())
        );
    }

    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration,
        token: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration | undefined> {
        if (!folder || config.type !== 'cortex-debug' || config.request !== 'launch' || !config.noDebug) { return config; }
        try {
            const profile = loadProfiles(folder.uri.fsPath).find(p => p.name === config.name);
            if (!profile) { return config; }
            // A renamed/repointed debug entry must not silently flash the old ELF.
            const expand = (p: string) => path.resolve(folder.uri.fsPath, p.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath));
            if (expand(profile.executable) !== expand(config.executable)) {
                throw new Error('ELF 与自动烧录配置不一致，请在配置器中重新生成。');
            }
            await this.run(folder, profile, token);
        } catch (error) {
            void vscode.window.showErrorMessage(`STM32 烧录未完成：${error instanceof Error ? error.message : error}`);
        }
        // undefined aborts debugger creation silently. No GDB server/session is launched.
        return undefined;
    }

    private async pickAndRun(): Promise<void> {
        try {
            const choices = (vscode.workspace.workspaceFolders ?? []).flatMap(folder =>
                loadProfiles(folder.uri.fsPath).map(profile => ({ label: profile.name, description: folder.name, folder, profile }))
            );
            if (!choices.length) {
                void vscode.window.showInformationMessage('请先在 STM32 配置器中启用“Ctrl+F5 编译并烧录”并生成配置。');
                return;
            }
            const choice = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { placeHolder: '选择要编译并烧录的固件' });
            if (choice) { await this.run(choice.folder, choice.profile); }
        } catch (error) {
            void vscode.window.showErrorMessage(`STM32 烧录未完成：${error instanceof Error ? error.message : error}`);
        }
    }

    async run(folder: vscode.WorkspaceFolder, profile: FlashProfile, outerToken?: vscode.CancellationToken): Promise<void> {
        if (!vscode.workspace.isTrusted) { throw new Error('请先信任此工作区。'); }
        if (this.running) { throw new Error('已有编译／烧录任务正在运行。'); }
        if (this.sessions.size || vscode.debug.activeDebugSession) { throw new Error('请先结束当前调试会话，以释放下载器。'); }
        this.running = true;
        try {
            if (!(await vscode.workspace.saveAll(false))) { throw new Error('文件未能保存，已停止烧录。'); }
            assertFirmwareInBuildDirectory(folder.uri.fsPath, profile.buildPreset, profile.executable);
            if (!vscode.extensions.getExtension('ms-vscode.cmake-tools')) { throw new Error('请安装 CMake Tools 扩展以自动编译。'); }
            const tasks = await vscode.tasks.fetchTasks();
            const task = tasks.find(t => t.name === profile.flashTask &&
                typeof t.scope === 'object' && t.scope.uri.toString() === folder.uri.toString());
            if (!task) { throw new Error('找不到生成的烧录任务，请重新生成配置。'); }
            if (vscode.tasks.taskExecutions.some(e => e.task.name === profile.flashTask || e.task.name === profile.buildTask)) {
                throw new Error('该配置的任务已经在运行。');
            }
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `STM32：${profile.name}`, cancellable: true }, async (progress, token) => {
                progress.report({ message: '正在编译、烧录和校验…' });
                await executeTaskAndWait(task, token, outerToken, profile.buildTask);
            });
            void vscode.window.showInformationMessage(`烧录成功：${profile.name}。校验完成，单片机已运行，OpenOCD 已退出。`);
        } finally { this.running = false; }
    }
}

/** Observe both events: a failed dependency ends the parent without starting its process. */
export async function executeTaskAndWait(
    task: vscode.Task, token: vscode.CancellationToken, outerToken?: vscode.CancellationToken, buildTask?: string
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let execution: vscode.TaskExecution | undefined;
        let settled = false;
        const codes = new Map<vscode.TaskExecution, number | undefined>();
        const ended = new Set<vscode.TaskExecution>();
        const subscriptions: vscode.Disposable[] = [];
        const finish = (error?: Error) => {
            if (settled) { return; }
            settled = true;
            subscriptions.forEach(d => d.dispose());
            if (error) { reject(error); } else { resolve(); }
        };
        const check = () => {
            if (!execution || !ended.has(execution)) { return; }
            const code = codes.get(execution);
            finish(code === 0 ? undefined : new Error(code === undefined ? '编译失败或任务被取消，未完成烧录。请查看任务终端。' : `任务退出码 ${code}，请查看任务终端。`));
        };
        const cancel = () => {
            execution?.terminate();
            // Dependencies can have their own executions; terminate only this task's generated build dependency.
            for (const active of vscode.tasks.taskExecutions) {
                if (active.task.name === buildTask && typeof active.task.scope === 'object' &&
                    typeof task.scope === 'object' && active.task.scope.uri.toString() === task.scope.uri.toString()) { active.terminate(); }
            }
            finish(new Error('已取消。'));
        };
        subscriptions.push(vscode.tasks.onDidEndTaskProcess(e => { codes.set(e.execution, e.exitCode); }),
            vscode.tasks.onDidEndTask(e => { ended.add(e.execution); check(); }), token.onCancellationRequested(cancel));
        if (outerToken) { subscriptions.push(outerToken.onCancellationRequested(cancel)); }
        if (token.isCancellationRequested || outerToken?.isCancellationRequested) { cancel(); return; }
        vscode.tasks.executeTask(task).then(e => {
            execution = e;
            if (settled) { e.terminate(); } else { check(); }
        }, error => finish(error));
    });
}
