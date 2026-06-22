import * as fs from 'fs';
import * as path from 'path';
import { spawnSync, spawn, SpawnOptions } from 'child_process';

const EXCLUDED_DIRS = new Set(['mtb_shared']);

// File written by mtb2cmake's --generated-dir option; lives in the CWD.
const GENERATED_DIR_FILE = 'dirname';

// ─── Fancy split-screen UI ────────────────────────────────────────────────────

const LINES_PER_APP = 4; // name line + 3 step command lines

type AppStatus = 'pending' | 'processing' | 'good' | 'bad';
type StepStatus = 'pending' | 'running' | 'ok' | 'fail';

interface StepInfo { cmd: string; status: StepStatus; }
interface AppEntry  { name: string; status: AppStatus; steps: [StepInfo, StepInfo, StepInfo]; }

class FancyUI {
    private readonly entries: AppEntry[] = [];
    private viewStart = 0;
    private readonly topContentRows: number; // rows available for app entries (below header)
    private readonly maxVisible: number;     // max fully visible app blocks
    private readonly separatorRow: number;
    private readonly scrollTop: number;
    private readonly scrollBottom: number;
    private readonly totalCols: number;

    constructor() {
        const rows = process.stdout.rows    ?? 24;
        const cols = process.stdout.columns ?? 80;
        this.totalCols      = cols;
        // Top section: at least one full app block + header + separator headroom
        const topRows       = Math.max(LINES_PER_APP + 2, Math.floor(rows / 3));
        this.topContentRows = topRows - 1;  // row 1 is the header
        this.maxVisible     = Math.max(1, Math.floor(this.topContentRows / LINES_PER_APP));
        this.separatorRow   = topRows + 1;
        this.scrollTop      = topRows + 2;
        this.scrollBottom   = rows;
    }

    init(apps: Array<{ name: string; mtb2cmakeCmd: string }>): void {
        for (const app of apps) {
            this.entries.push({
                name:   app.name,
                status: 'pending',
                steps: [
                    { cmd: app.mtb2cmakeCmd,                  status: 'pending' },
                    { cmd: 'cmake --preset=llvm-debug',       status: 'pending' },
                    { cmd: 'cmake --build build/llvm-debug',  status: 'pending' },
                ],
            });
        }
        process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
        process.stdout.write(`\x1b[${this.scrollTop};${this.scrollBottom}r`);
        this.renderTop();
        this.renderSeparator();
        process.stdout.write(`\x1b[${this.scrollBottom};1H`);
    }

    private renderTop(): void {
        process.stdout.write('\x1b[s');

        // Header
        process.stdout.write('\x1b[1;1H\x1b[K');
        const done = this.entries.filter(a => a.status === 'good' || a.status === 'bad').length;
        process.stdout.write(`\x1b[1mApplications (${done}/${this.entries.length}):\x1b[0m`);

        // Blank all content rows first
        for (let r = 0; r < this.topContentRows; r++) {
            process.stdout.write(`\x1b[${r + 2};1H\x1b[K`);
        }

        const visible = this.entries.slice(this.viewStart, this.viewStart + this.maxVisible);

        const treeChars = ['\u251C\u2500', '\u251C\u2500', '\u2514\u2500']; // ├─ ├─ └─

        for (let i = 0; i < visible.length; i++) {
            const entry   = visible[i];
            const baseRow = 2 + i * LINES_PER_APP;

            // ── Name line ──
            const badge = this.nameBadge(entry.status);
            const maxNameLen = this.totalCols - badge.plain.length - 2;
            const dispName   = entry.name.length > maxNameLen
                ? entry.name.slice(0, maxNameLen - 1) + '\u2026'
                : entry.name;
            process.stdout.write(`\x1b[${baseRow};1H  ${dispName}${badge.ansi}`);

            // ── Step lines ──
            for (let s = 0; s < 3; s++) {
                const step      = entry.steps[s];
                const tree      = treeChars[s];
                const prefixLen = 5; // "  ├─ "
                const maxCmdLen = this.totalCols - prefixLen;
                const cmd       = step.cmd.length > maxCmdLen
                    ? step.cmd.slice(0, maxCmdLen - 1) + '\u2026'
                    : step.cmd;
                const color     = this.stepColor(step.status);
                process.stdout.write(`\x1b[${baseRow + 1 + s};1H  \x1b[90m${tree}\x1b[0m ${color}${cmd}\x1b[0m`);
            }
        }

        process.stdout.write('\x1b[u');
    }

    private nameBadge(status: AppStatus): { plain: string; ansi: string } {
        switch (status) {
            case 'pending':    return { plain: '',       ansi: '' };
            case 'processing': return { plain: ' ...',   ansi: '\x1b[33m ...\x1b[0m' };
            case 'good':       return { plain: ' good',  ansi: '\x1b[32m good\x1b[0m' };
            case 'bad':        return { plain: ' bad',   ansi: '\x1b[31m bad\x1b[0m' };
        }
    }

    private stepColor(status: StepStatus): string {
        switch (status) {
            case 'pending': return '\x1b[90m'; // dim gray
            case 'running': return '\x1b[33m'; // yellow
            case 'ok':      return '\x1b[32m'; // green
            case 'fail':    return '\x1b[31m'; // red
        }
    }

    private renderSeparator(): void {
        process.stdout.write('\x1b[s');
        process.stdout.write(`\x1b[${this.separatorRow};1H\x1b[K`);
        process.stdout.write('\x1b[90m' + '\u2500'.repeat(this.totalCols) + '\x1b[0m');
        process.stdout.write('\x1b[u');
    }

    private ensureVisible(index: number): void {
        if (index < this.viewStart) {
            this.viewStart = index;
        } else if (index >= this.viewStart + this.maxVisible) {
            this.viewStart = index - this.maxVisible + 1;
        }
    }

    setProcessing(name: string): void {
        const entry = this.entries.find(a => a.name === name);
        if (!entry) return;
        entry.status = 'processing';
        this.ensureVisible(this.entries.indexOf(entry));
        this.renderTop();
    }

    setStepRunning(name: string, step: 0 | 1 | 2): void {
        const entry = this.entries.find(a => a.name === name);
        if (!entry) return;
        entry.steps[step].status = 'running';
        this.ensureVisible(this.entries.indexOf(entry));
        this.renderTop();
    }

    setStepDone(name: string, step: 0 | 1 | 2, success: boolean): void {
        const entry = this.entries.find(a => a.name === name);
        if (!entry) return;
        entry.steps[step].status = success ? 'ok' : 'fail';
        this.renderTop();
    }

    // Call after mtb2cmake succeeds and the cmake dir is known.
    setCmakeDir(name: string, cmakeDir: string): void {
        const entry = this.entries.find(a => a.name === name);
        if (!entry) return;
        entry.steps[1].cmd = `cmake --preset=llvm-debug  (in ${cmakeDir})`;
        entry.steps[2].cmd = `cmake --build build/llvm-debug  (in ${cmakeDir})`;
        this.renderTop();
    }

    setDone(name: string, success: boolean): void {
        const entry = this.entries.find(a => a.name === name);
        if (!entry) return;
        entry.status = success ? 'good' : 'bad';
        this.renderTop();
    }

    writeOutput(line: string): void {
        const clean = line.replace(/[\r\n]/g, '').slice(0, this.totalCols);
        process.stdout.write('\x1b[s');
        process.stdout.write(`\x1b[${this.scrollBottom};1H\n\x1b[K${clean}`);
        process.stdout.write('\x1b[u');
    }

    cleanup(): void {
        process.stdout.write('\x1b[r');    // reset scroll region
        process.stdout.write('\x1b[?25h'); // show cursor
        process.stdout.write(`\x1b[${this.scrollBottom};1H\n`);
    }
}

// ─── Command runners ──────────────────────────────────────────────────────────

function buildMtb2CmakeArgs(
    dependsJson: string,
    appSourceDir: string,
    dest: string,
    bspName: string,
    generatedDirFile: string
): string[] {
    return [
        '--source', appSourceDir,
        '--dest', dest,
        '--bsp', bspName,
        '--target', 'gcc,llvm,iar,arm',
        '--depends', dependsJson,
        '--force',
        '--generated-dir', generatedDirFile,
    ];
}

// Async runner that streams stdout/stderr line-by-line to the FancyUI.
async function runCommandFancy(
    exe: string,
    args: string[],
    cwd: string | undefined,
    ui: FancyUI
): Promise<boolean> {
    return new Promise((resolve) => {
        const opts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], cwd };
        const child = spawn(exe, args, opts);

        const onData = (data: Buffer): void => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (line) ui.writeOutput(line);
            }
        };

        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (err) => { ui.writeOutput(`Error: ${err.message}`); resolve(false); });
        child.on('close', (code) => resolve(code === 0));
    });
}

// Plain (non-fancy) synchronous runners.
function runMtb2Cmake(
    mtb2cmakeExe: string,
    dependsJson: string,
    appSourceDir: string,
    dest: string,
    bspName: string,
    generatedDirFile: string
): boolean {
    const args = buildMtb2CmakeArgs(dependsJson, appSourceDir, dest, bspName, generatedDirFile);
    console.log(`  Running: ${mtb2cmakeExe} ${args.join(' ')}`);
    const result = spawnSync(mtb2cmakeExe, args, { stdio: 'inherit', encoding: 'utf-8' });
    if (result.error) { console.error(`  Error spawning mtb2cmake: ${result.error.message}`); return false; }
    if (result.status !== 0) { console.error(`  mtb2cmake exited with code ${result.status}`); return false; }
    return true;
}

function runCmake(cmakeArgs: string[], cwd: string): boolean {
    console.log(`  cmake ${cmakeArgs.join(' ')}  (in ${cwd})`);
    const result = spawnSync('cmake', cmakeArgs, { stdio: 'inherit', encoding: 'utf-8', cwd });
    if (result.error) { console.error(`  Error spawning cmake: ${result.error.message}`); return false; }
    if (result.status !== 0) { console.error(`  cmake exited with code ${result.status}`); return false; }
    return true;
}

// ─── File utilities ───────────────────────────────────────────────────────────

function copyDirSync(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        entry.isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
    }
}

// Move a directory, handling cross-device scenarios.
function moveDirSync(src: string, dest: string): void {
    try {
        fs.renameSync(src, dest);
    } catch (err: any) {
        if (err.code === 'EXDEV') {
            copyDirSync(src, dest);
            fs.rmSync(src, { recursive: true, force: true });
        } else {
            throw err;
        }
    }
}

function findAppDirectories(sourceDir: string): string[] {
    return fs.readdirSync(sourceDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !EXCLUDED_DIRS.has(e.name))
        .map(e => e.name);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printUsage(): void {
    console.log('Usage: bulk3tocmake --source <path> --dest <path> --good <path> --bad <path> --depends <path> --mtb2cmake <path> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --source <path>     ModusToolbox workspace directory; its basename is the BSP name');
    console.log('  --dest <path>       Destination root directory for converted CMake projects');
    console.log('  --good <path>       Directory to move successfully built MTB3 app source into');
    console.log('  --bad <path>        Directory to move failed MTB3 app source into');
    console.log('  --depends <path>    Path to depends.json file');
    console.log('  --mtb2cmake <path>  Path to the mtb2cmake executable');
    console.log('  --dry-run           Print the mtb2cmake command line for each app and exit');
    console.log('  --fancy             Split-screen ANSI UI: app list (top third) + output scroll (bottom)');
    console.log('  --help              Display this help message');
}

interface CliArgs {
    source: string;
    dest: string;
    good: string;
    bad: string;
    depends: string;
    mtb2cmake: string;
    dryRun: boolean;
    fancy: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    let source: string | undefined;
    let dest: string | undefined;
    let good: string | undefined;
    let bad: string | undefined;
    let depends: string | undefined;
    let mtb2cmake: string | undefined;
    let dryRun = false;
    let fancy  = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help') {
            printUsage(); process.exit(0);
        } else if (arg === '--source') {
            i++;
            if (i >= argv.length) { console.error('Error: --source requires a path argument'); printUsage(); process.exit(1); }
            source = argv[i];
        } else if (arg === '--dest') {
            i++;
            if (i >= argv.length) { console.error('Error: --dest requires a path argument'); printUsage(); process.exit(1); }
            dest = argv[i];
        } else if (arg === '--good') {
            i++;
            if (i >= argv.length) { console.error('Error: --good requires a path argument'); printUsage(); process.exit(1); }
            good = argv[i];
        } else if (arg === '--bad') {
            i++;
            if (i >= argv.length) { console.error('Error: --bad requires a path argument'); printUsage(); process.exit(1); }
            bad = argv[i];
        } else if (arg === '--depends') {
            i++;
            if (i >= argv.length) { console.error('Error: --depends requires a path argument'); printUsage(); process.exit(1); }
            depends = argv[i];
        } else if (arg === '--mtb2cmake') {
            i++;
            if (i >= argv.length) { console.error('Error: --mtb2cmake requires a path argument'); printUsage(); process.exit(1); }
            mtb2cmake = argv[i];
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--fancy') {
            fancy = true;
        } else {
            console.error(`Unknown argument: ${arg}`);
            printUsage();
            process.exit(1);
        }
    }

    if (!source)    { console.error('Error: --source is required');    printUsage(); process.exit(1); }
    if (!dest)      { console.error('Error: --dest is required');      printUsage(); process.exit(1); }
    if (!good)      { console.error('Error: --good is required');      printUsage(); process.exit(1); }
    if (!bad)       { console.error('Error: --bad is required');       printUsage(); process.exit(1); }
    if (!depends)   { console.error('Error: --depends is required');   printUsage(); process.exit(1); }
    if (!mtb2cmake) { console.error('Error: --mtb2cmake is required'); printUsage(); process.exit(1); }

    return { source, dest, good, bad, depends, mtb2cmake, dryRun, fancy };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    const sourceDir    = path.resolve(args.source);
    const destDir      = path.resolve(args.dest);
    const goodDir      = path.resolve(args.good);
    const badDir       = path.resolve(args.bad);
    const bspName      = path.basename(sourceDir);
    const mtb2cmakeExe = path.resolve(args.mtb2cmake);
    const dependsJson  = path.resolve(args.depends);
    const generatedDirFile = path.join(process.cwd(), GENERATED_DIR_FILE);

    if (!fs.existsSync(sourceDir)) {
        console.error(`Error: source directory does not exist: ${sourceDir}`);
        process.exit(1);
    }
    if (!fs.existsSync(mtb2cmakeExe)) {
        console.error(`Error: mtb2cmake executable not found at ${mtb2cmakeExe}`);
        process.exit(1);
    }
    if (!fs.existsSync(dependsJson)) {
        console.error(`Error: depends.json not found at ${dependsJson}`);
        process.exit(1);
    }

    const appDirs = findAppDirectories(sourceDir);

    if (appDirs.length === 0) {
        console.warn(`Warning: no application directories found in ${sourceDir} (excluding mtb_shared)`);
        process.exit(0);
    }

    // ── Dry-run: just print commands and exit ──────────────────────────────
    if (args.dryRun) {
        console.log(`BSP: ${bspName}  Source: ${sourceDir}  Dest: ${args.dest}`);
        console.log('-- DRY RUN: mtb2cmake command lines --');
        for (const appName of appDirs) {
            const cmdArgs = buildMtb2CmakeArgs(
                dependsJson, path.join(sourceDir, appName),
                args.dest, bspName, generatedDirFile
            );
            console.log(`${mtb2cmakeExe} ${cmdArgs.join(' ')}`);
        }
        process.exit(0);
    }

    fs.mkdirSync(destDir, { recursive: true });
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(badDir,  { recursive: true });

    // ── Set up UI ──────────────────────────────────────────────────────────
    let ui: FancyUI | undefined;

    if (args.fancy) {
        ui = new FancyUI();
        // Pre-compute the mtb2cmake command string for each app so the UI can show it upfront.
        const uiApps = appDirs.map(name => ({
            name,
            mtb2cmakeCmd: [mtb2cmakeExe, ...buildMtb2CmakeArgs(
                dependsJson, path.join(sourceDir, name), args.dest, bspName, generatedDirFile
            )].join(' '),
        }));
        ui.init(uiApps);
        const cleanup = (): void => { ui!.cleanup(); };
        process.on('exit', cleanup);
        process.on('SIGINT', () => { cleanup(); process.exit(130); });
    } else {
        console.log(`BSP:    ${bspName}`);
        console.log(`Source: ${sourceDir}`);
        console.log(`Dest:   ${args.dest}`);
        console.log(`Good:   ${goodDir}`);
        console.log(`Bad:    ${badDir}`);
        console.log(`Found ${appDirs.length} application(s): ${appDirs.join(', ')}`);
        console.log('');
    }

    // ── Process each app ───────────────────────────────────────────────────
    let passed = 0;
    let failed = 0;
    const failures: string[] = [];

    for (const appName of appDirs) {
        const appSourceDir = path.join(sourceDir, appName);
        const index        = passed + failed + 1;

        if (ui) {
            ui.setProcessing(appName);
        } else {
            console.log(`[${index}/${appDirs.length}] Converting: ${appName}`);
        }

        // Remove stale dirname file so we can detect if mtb2cmake wrote a fresh one.
        try { fs.unlinkSync(generatedDirFile); } catch { /* ignore if absent */ }

        // --- Run mtb2cmake (step 0) ---
        let appOk: boolean;
        if (ui) {
            ui.setStepRunning(appName, 0);
            const mtbArgs = buildMtb2CmakeArgs(dependsJson, appSourceDir, args.dest, bspName, generatedDirFile);
            appOk = await runCommandFancy(mtb2cmakeExe, mtbArgs, undefined, ui);
            ui.setStepDone(appName, 0, appOk);
        } else {
            appOk = runMtb2Cmake(mtb2cmakeExe, dependsJson, appSourceDir, args.dest, bspName, generatedDirFile);
        }

        // --- Read generated cmake dir ---
        let cmakeDir: string | undefined;
        if (appOk) {
            if (!fs.existsSync(generatedDirFile)) {
                const msg = `Error: mtb2cmake did not write ${generatedDirFile}`;
                ui ? ui.writeOutput(msg) : console.error(`  ${msg}`);
                appOk = false;
            } else {
                cmakeDir = fs.readFileSync(generatedDirFile, 'utf-8').trim().replace(/\//g, path.sep);
                if (ui) {
                    ui.setCmakeDir(appName, cmakeDir);
                } else {
                    console.log(`  CMake dir: ${cmakeDir}`);
                }
            }
        }

        // --- cmake --preset=llvm-debug (step 1) ---
        if (appOk && cmakeDir) {
            if (ui) {
                ui.setStepRunning(appName, 1);
                appOk = await runCommandFancy('cmake', ['--preset=llvm-debug'], cmakeDir, ui);
                ui.setStepDone(appName, 1, appOk);
            } else {
                appOk = runCmake(['--preset=llvm-debug'], cmakeDir);
            }
        }

        // --- cmake --build build/llvm-debug (step 2) ---
        if (appOk && cmakeDir) {
            if (ui) {
                ui.setStepRunning(appName, 2);
                appOk = await runCommandFancy('cmake', ['--build', 'build/llvm-debug'], cmakeDir, ui);
                ui.setStepDone(appName, 2, appOk);
            } else {
                appOk = runCmake(['--build', 'build/llvm-debug'], cmakeDir);
            }
        }

        // --- Move source and update status ---
        if (appOk) {
            moveDirSync(appSourceDir, path.join(goodDir, appName));
            passed++;
            if (ui) {
                ui.setDone(appName, true);
            } else {
                console.log(`  ✓ ${appName} succeeded`);
                console.log('');
            }
        } else {
            if (cmakeDir && fs.existsSync(cmakeDir)) {
                fs.rmSync(cmakeDir, { recursive: true, force: true });
            }
            if (fs.existsSync(appSourceDir)) {
                moveDirSync(appSourceDir, path.join(badDir, appName));
            }
            failed++;
            failures.push(appName);
            if (ui) {
                ui.setDone(appName, false);
            } else {
                console.error(`  ✗ ${appName} failed`);
                console.log('');
            }
        }
    }

    if (ui) {
        ui.cleanup();
    }

    console.log(`Done: ${passed} succeeded, ${failed} failed.`);
    if (failures.length > 0) {
        console.error(`Failed applications: ${failures.join(', ')}`);
        process.exit(1);
    }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`bulk3tocmake failed: ${message}`);
    process.exit(1);
});

