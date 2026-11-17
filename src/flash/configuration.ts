import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';

export interface FlashProfile {
    id: string;
    name: string;
    executable: string;
    buildPreset: string;
    buildTask: string;
    flashTask: string;
}

export interface FlashOptions {
    name?: string;
    executable: string;
    buildPreset: string;
    openocdPath: string;
    configFiles: string[];
    launchCommands: string[];
}

export function readJsonc(text: string, filename: string): any {
    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${filename} 格式有误，原文件未被覆盖。`);
    }
    return value;
}

export function editJsonc(text: string, location: (string | number)[], value: unknown): string {
    return applyEdits(text, modify(text, location, value, {
        formattingOptions: { insertSpaces: true, tabSize: 4, eol: text.includes('\r\n') ? '\r\n' : '\n' }
    }));
}

/** One Tcl word, without command or variable substitution (including spaces, $, [] and quotes). */
export function tclWord(value: string): string {
    if (/[\r\n\0]/.test(value)) { throw new Error('路径不能包含换行或空字符。'); }
    return '"' + value.replace(/\\/g, '/').replace(/["$\[\]]/g, '\\$&') + '"';
}

export function makeProfile(options: FlashOptions): FlashProfile {
    if (!/\.(elf|axf|hex|s19)$/i.test(options.executable.trim())) {
        throw new Error('自动烧录请选择 ELF、AXF、HEX 或 S19；裸 BIN 缺少烧录地址。');
    }
    if (!options.buildPreset.trim()) { throw new Error('请选择一个 CMake 构建预设。'); }
    if (!options.openocdPath.trim() || !options.configFiles.length || options.configFiles.some(f => !f.trim())) {
        throw new Error('请填写 OpenOCD 路径并选择配置文件。');
    }
    const executable = options.executable.trim().replace(/\\/g, '/');
    // Named profiles can share one ELF, e.g. two probes; unnamed profiles are stable per ELF/preset.
    const identity = options.name?.trim() || `${executable}\n${options.buildPreset}`;
    const id = createHash('sha256').update(identity).digest('hex').slice(0, 12);
    const name = options.name?.trim() || `${path.posix.basename(executable)} [${options.buildPreset}]`;
    return {
        id, name, executable, buildPreset: options.buildPreset,
        buildTask: `STM32 Build: ${name} (${id})`,
        flashTask: `STM32 Flash: ${name} (${id})`
    };
}

export function makeTasks(profile: FlashProfile, options: FlashOptions): any[] {
    const args = ['-s', '${workspaceFolder}'];
    for (const file of options.configFiles) { args.push('-f', file); }
    for (const command of options.launchCommands) { args.push('-c', command); }
    // The process cwd is the workspace. Keep its path out of Tcl, where $, [] and
    // quotes in a workspace's name would otherwise be interpreted after VS Code substitution.
    const firmware = profile.executable.replace(/^\$\{workspaceFolder\}\//, './');
    args.push('-c', `program ${tclWord(firmware)} verify reset exit`);
    return [
        {
            label: profile.buildTask, type: 'cmake', command: 'build',
            // CMake Tools parses build diagnostics itself. $gcc is contributed by
            // the optional C/C++ extension and is invalid when it is not installed/enabled.
            preset: profile.buildPreset, targets: ['all'], problemMatcher: [],
            options: { cwd: '${workspaceFolder}' }
        },
        {
            label: profile.flashTask, type: 'process', command: options.openocdPath,
            args, options: { cwd: '${workspaceFolder}' },
            dependsOn: profile.buildTask, dependsOrder: 'sequence', problemMatcher: [],
            presentation: { reveal: 'always', panel: 'dedicated', clear: true },
            runOptions: { instanceLimit: 1 }
        }
    ];
}

function arrayField(document: any, key: string, filename: string): any[] {
    const list = document[key] ?? [];
    if (!Array.isArray(list)) { throw new Error(`${filename}: ${key} 必须是数组。`); }
    return list;
}

function upsert(text: string, key: string, index: number, value: unknown): string {
    return editJsonc(text, [key, index < 0 ? -1 : index], value);
}

/** Prepare all edits before writing anything. Only entries owned by this profile may be replaced. */
export function prepareConfiguration(
    launchText: string, tasksText: string, profilesText: string,
    debugConfiguration: any, options: FlashOptions
): { launch: string; tasks: string; profiles: string; profile: FlashProfile } {
    const launch = readJsonc(launchText, 'launch.json');
    const tasks = readJsonc(tasksText, 'tasks.json');
    const profiles = readJsonc(profilesText, 'stm32-flash.json');
    const profile = makeProfile(options);
    const entries = arrayField(profiles, 'profiles', 'stm32-flash.json');
    const previousIndex = entries.findIndex(p => p.id === profile.id);
    const previous: FlashProfile | undefined = entries[previousIndex];
    const configs = arrayField(launch, 'configurations', 'launch.json');
    const launchIndex = previous ? configs.findIndex(c => c.name === previous.name && c.type === 'cortex-debug') : -1;
    if (configs.some((c, i) => c.name === profile.name && i !== launchIndex)) {
        throw new Error(`名称“${profile.name}”已被其他配置使用，请换一个配置名称。`);
    }
    const newDebug = { ...debugConfiguration, name: profile.name, preLaunchTask: profile.buildTask };
    if (!launch.configurations) { launchText = editJsonc(launchText, ['configurations'], []); }
    launchText = upsert(launchText, 'configurations', launchIndex, newDebug);
    if (!tasks.tasks) { tasksText = editJsonc(tasksText, ['tasks'], []); }
    const taskList = arrayField(tasks, 'tasks', 'tasks.json');
    const ownedLabels = previous ? [previous.buildTask, previous.flashTask] : [];
    for (const task of makeTasks(profile, options)) {
        const index = taskList.findIndex(t => t.label === task.label);
        if (index >= 0 && !ownedLabels.includes(task.label)) {
            throw new Error(`任务“${task.label}”已存在，未覆盖用户任务。`);
        }
        tasksText = upsert(tasksText, 'tasks', index, task);
        if (index < 0) { taskList.push(task); } else { taskList[index] = task; }
    }
    if (!profiles.profiles) { profilesText = editJsonc(profilesText, ['profiles'], []); }
    profilesText = upsert(profilesText, 'profiles', previousIndex, profile);
    return { launch: launchText, tasks: tasksText, profiles: profilesText, profile };
}

export function loadProfiles(root: string): FlashProfile[] {
    const file = path.join(root, '.vscode', 'stm32-flash.json');
    if (!fs.existsSync(file)) { return []; }
    const data = readJsonc(fs.readFileSync(file, 'utf8'), file);
    const profiles = arrayField(data, 'profiles', file);
    for (const p of profiles) {
        if (!p || ['id', 'name', 'executable', 'buildPreset', 'buildTask', 'flashTask'].some(k => typeof p[k] !== 'string' || !p[k])) {
            throw new Error('stm32-flash.json 中的配置不完整，请在配置器中重新生成。');
        }
    }
    return profiles;
}

export function writeConfiguration(root: string, debug: any, options?: FlashOptions): string {
    const directory = path.join(root, '.vscode');
    const files = ['launch.json', 'tasks.json', 'stm32-flash.json'].map(f => path.join(directory, f));
    const originals = files.map(f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined);
    let texts: string[];
    let name = debug.name;
    if (options) {
        assertFirmwareInBuildDirectory(root, options.buildPreset, options.executable);
        const result = prepareConfiguration(
            originals[0] ?? '{"version":"0.2.0","configurations":[]}',
            originals[1] ?? '{"version":"2.0.0","tasks":[]}',
            originals[2] ?? '{"version":1,"profiles":[]}', debug, options
        );
        texts = [result.launch, result.tasks, result.profiles];
        name = result.profile.name;
    } else {
        let text = originals[0] ?? '{"version":"0.2.0","configurations":[]}';
        const data = readJsonc(text, 'launch.json');
        const configs = arrayField(data, 'configurations', 'launch.json');
        let metadata = originals[2] ?? '{"version":1,"profiles":[]}';
        const profiles = arrayField(readJsonc(metadata, 'stm32-flash.json'), 'profiles', 'stm32-flash.json');
        const ownedIndex = profiles.findIndex(p => p.name === name);
        const configIndex = configs.findIndex(c => c.name === name);
        if (configIndex >= 0 && (ownedIndex < 0 || configs[configIndex].type !== 'cortex-debug')) {
            throw new Error(`配置名称“${name}”已存在，请选择不同名称。`);
        }
        if (!data.configurations) { text = editJsonc(text, ['configurations'], []); }
        texts = [upsert(text, 'configurations', configIndex, debug)];
        if (ownedIndex >= 0) {
            // Turning the GUI option off removes only this profile's generated task entries.
            let tasksText = originals[1] ?? '{"version":"2.0.0","tasks":[]}';
            const tasks = arrayField(readJsonc(tasksText, 'tasks.json'), 'tasks', 'tasks.json');
            const owned = profiles[ownedIndex];
            for (let i = tasks.length - 1; i >= 0; i--) {
                if ([owned.buildTask, owned.flashTask].includes(tasks[i].label)) {
                    tasksText = editJsonc(tasksText, ['tasks', i], undefined);
                }
            }
            metadata = editJsonc(metadata, ['profiles', ownedIndex], undefined);
            texts.push(tasksText, metadata);
        }
    }
    fs.mkdirSync(directory, { recursive: true });
    const written: number[] = [];
    try {
        texts.forEach((text, i) => { fs.writeFileSync(files[i], text); written.push(i); });
    } catch (error) {
        for (const i of written.reverse()) {
            if (originals[i] === undefined) { fs.unlinkSync(files[i]); }
            else { fs.writeFileSync(files[i], originals[i]!); }
        }
        throw error;
    }
    return name;
}

/** Includes and user presets are read for display; CMake Tools remains responsible for evaluating them. */
function presetDefinitions(root: string): { builds: Map<string, any>; configurations: Map<string, any> } {
    const seen = new Set<string>();
    const builds = new Map<string, any>();
    const configurations = new Map<string, any>();
    function visit(file: string): void {
        file = path.resolve(file);
        if (seen.has(file) || !fs.existsSync(file)) { return; }
        if (seen.size > 50) { throw new Error('CMake preset include 层数过多。'); }
        seen.add(file);
        const value = readJsonc(fs.readFileSync(file, 'utf8'), file);
        for (const include of value.include ?? []) {
            if (typeof include !== 'string' || /\$/.test(include)) { continue; }
            visit(path.resolve(path.dirname(file), include));
        }
        for (const preset of value.buildPresets ?? []) {
            if (typeof preset.name === 'string') { builds.set(preset.name, preset); }
        }
        for (const preset of value.configurePresets ?? []) {
            if (typeof preset.name === 'string') { configurations.set(preset.name, preset); }
        }
    }
    visit(path.join(root, 'CMakePresets.json'));
    visit(path.join(root, 'CMakeUserPresets.json'));
    return { builds, configurations };
}

export function listBuildPresets(root: string): string[] {
    return [...presetDefinitions(root).builds].filter(([, preset]) => !preset.hidden).map(([name]) => name);
}

export function assertFirmwareInBuildDirectory(root: string, buildName: string, executable: string): void {
    const { builds, configurations } = presetDefinitions(root);
    function inherit(map: Map<string, any>, name: string, chain: string[] = []): any {
        if (chain.includes(name)) { throw new Error('CMake 预设继承存在循环。'); }
        const entry = map.get(name);
        if (!entry) { throw new Error(`找不到 CMake 预设：${name}`); }
        const parents = typeof entry.inherits === 'string' ? [entry.inherits] : entry.inherits ?? [];
        let result = {};
        for (const parent of [...parents].reverse()) { result = { ...result, ...inherit(map, parent, [...chain, name]) }; }
        return { ...result, ...entry };
    }
    const build = inherit(builds, buildName);
    const configuration = inherit(configurations, build.configurePreset);
    const expand = (value: string) => value
        .replace(/\$\{sourceDir\}|\$\{workspaceFolder\}/g, root)
        .replace(/\$\{sourceParentDir\}/g, path.dirname(root))
        .replace(/\$\{sourceDirName\}/g, path.basename(root))
        .replace(/\$\{presetName\}/g, build.configurePreset);
    if (typeof configuration.binaryDir !== 'string') { throw new Error('构建预设需要明确的 binaryDir，以确认编译会更新所选 ELF。'); }
    const directory = expand(configuration.binaryDir);
    const firmware = expand(executable);
    if (/\$\{|\$(?:p?env)\{/.test(directory + firmware)) {
        throw new Error('无法确认含动态变量的构建输出目录，请使用 sourceDir/presetName 指定输出目录。');
    }
    const relative = path.relative(path.resolve(root, directory), path.resolve(root, firmware));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`所选固件不在 ${buildName} 的构建输出目录中：${directory}。请让构建预设与 ELF 匹配。`);
    }
}
