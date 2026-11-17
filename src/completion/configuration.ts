import * as fs from 'fs';
import * as path from 'path';
import { isScalar, parseAllDocuments } from 'yaml';
import { resolveBuildPreset } from '../flash/configuration';

const owner = 'stm32-flash-configurator: compilation database';

export interface CompletionPlan {
    file: string;
    original: string | undefined;
    text: string;
    preserved: boolean;
    binaryDir: string;
    configurePreset: string;
}

/** Change only our scalar; append a separate YAML fragment to unrelated user settings. */
export function prepareCompletion(root: string, buildPreset: string): CompletionPlan {
    const resolved = resolveBuildPreset(root, buildPreset);
    const file = path.join(root, '.clangd');
    if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) {
        throw new Error('.clangd 不是普通文件，已保留原内容。');
    }
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    const text = original ?? '';
    const documents = parseAllDocuments(text);
    const values = documents.map(doc => {
        if (doc.errors.length) { throw new Error('.clangd YAML 格式有误，原文件未被修改。'); }
        const value = doc.toJS({ maxAliasCount: 100 });
        if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
            throw new Error('.clangd 配置必须是 YAML 映射，原文件未被修改。');
        }
        return value;
    });
    const plan = { file, original, text, preserved: false, ...resolved };
    const configured = documents.flatMap((doc, i) => {
        const flags = values[i]?.CompileFlags;
        return flags && Object.prototype.hasOwnProperty.call(flags, 'CompilationDatabase')
            ? [{ doc, node: doc.getIn(['CompileFlags', 'CompilationDatabase'], true) }] : [];
    });
    const managed = configured.length === 1 && !configured[0].doc.has('If') &&
        isScalar(configured[0].node) && configured[0].node.comment?.trim() === owner;
    if (configured.length && !managed) { return { ...plan, preserved: true }; }

    // Relative to .clangd, so a project can be moved or shared without this machine's path.
    const directory = (path.relative(root, resolved.binaryDir) || '.').replace(/\\/g, '/');
    const quoted = JSON.stringify(directory);
    if (managed && isScalar(configured[0].node) && configured[0].node.range) {
        const [start, end] = configured[0].node.range;
        return { ...plan, text: text.slice(0, start) + quoted + text.slice(end) };
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const prefix = text && !text.endsWith('\n') ? text + eol : text;
    return { ...plan, text: prefix + [
        '---', '# Code completion directory managed by STM32 Flash Configurator.',
        'CompileFlags:', `  CompilationDatabase: ${quoted} # ${owner}`, ''
    ].join(eol) };
}

export function writeCompletion(plan: CompletionPlan): void {
    if (plan.preserved || plan.text === plan.original) { return; }
    const current = fs.existsSync(plan.file) ? fs.readFileSync(plan.file, 'utf8') : undefined;
    if (current !== plan.original) { throw new Error('.clangd 已被其他操作修改，请重新配置补全。'); }
    fs.writeFileSync(plan.file, plan.text, { flag: plan.original === undefined ? 'wx' : 'w' });
}

export function hasCompilationDatabase(binaryDir: string): boolean {
    const file = path.join(binaryDir, 'compile_commands.json');
    if (!fs.existsSync(file)) { return false; }
    const commands = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(commands) || !commands.some(c => c && typeof c.file === 'string' &&
        (typeof c.command === 'string' || Array.isArray(c.arguments)))) {
        throw new Error('compile_commands.json 没有有效的编译记录，请重新配置 CMake 工程。');
    }
    return true;
}
