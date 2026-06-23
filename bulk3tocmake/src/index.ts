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
    private topContentRows: number = 0; // rows available for app entries (below header)
    private maxVisible: number = 0;     // max fully visible app blocks
    private separatorRow: number = 0;
    private scrollTop: number = 0;
    private scrollBottom: number = 0;
    private totalCols: number = 0;
    private resizeHandler?: () => void;
    private stdinDataHandler?: (data: Buffer) => void;

    constructor() {
        this.computeLayout();
    }

    private computeLayout(): void {
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

    redraw(): void {
        this.computeLayout();
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(`\x1b[${this.scrollTop};${this.scrollBottom}r`);
        this.renderTop();
        this.renderSeparator();
        process.stdout.write(`\x1b[${this.scrollBottom};1H`);
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

        // Respond to terminal resize
        this.resizeHandler = () => this.redraw();
        process.stdout.on('resize', this.resizeHandler);

        // Respond to Ctrl-L (redraw) and Ctrl-C (exit) via raw stdin
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            this.stdinDataHandler = (data: Buffer) => {
                if (data[0] === 0x0c) {       // Ctrl-L
                    this.redraw();
                } else if (data[0] === 0x03) { // Ctrl-C — re-raise as SIGINT
                    process.emit('SIGINT');
                }
            };
            process.stdin.on('data', this.stdinDataHandler);
        }
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
        // Only scroll forward when the current app would fall below the visible window.
        // Place it at the bottom of the list area. Never scroll backward.
        if (index >= this.viewStart + this.maxVisible) {
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
        if (this.resizeHandler) {
            process.stdout.off('resize', this.resizeHandler);
            this.resizeHandler = undefined;
        }
        if (this.stdinDataHandler && process.stdin.isTTY) {
            process.stdin.off('data', this.stdinDataHandler);
            this.stdinDataHandler = undefined;
            process.stdin.setRawMode(false);
            process.stdin.pause();
        }
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
    generatedDirFile: string
): string[] {
    return [
        '--source', appSourceDir,
        '--dest', dest,
        '--target', 'gcc,llvm,iar,arm',
        '--depends', dependsJson,
        '--force',
        '--generated-dir', generatedDirFile,
    ];
}

// Plain synchronous runner: captures output, writes to both console and log.
function runCommandPlain(
    exe: string,
    args: string[],
    cwd: string | undefined,
    logStream: fs.WriteStream
): boolean {
    const label  = `${exe} ${args.join(' ')}`;
    const header = `\n=== ${label} ===\n`;
    process.stdout.write(header);
    logStream.write(header);

    const result = spawnSync(exe, args, { stdio: 'pipe', encoding: 'utf-8', cwd });

    if (result.stdout) { process.stdout.write(result.stdout); logStream.write(result.stdout); }
    if (result.stderr) { process.stderr.write(result.stderr); logStream.write(result.stderr); }

    if (result.error) {
        const msg = `Error spawning process: ${result.error.message}\n`;
        process.stderr.write(msg);
        logStream.write(msg);
        return false;
    }

    const exitLine = `Exit code: ${result.status}\n`;
    logStream.write(exitLine);
    return result.status === 0;
}

// Async runner: streams output to FancyUI scroll pane and log file.
async function runCommandFancy(
    exe: string,
    args: string[],
    cwd: string | undefined,
    ui: FancyUI,
    logStream: fs.WriteStream
): Promise<boolean> {
    const label  = `${exe} ${args.join(' ')}`;
    const header = `\n=== ${label} ===\n`;
    logStream.write(header);

    return new Promise((resolve) => {
        const opts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], cwd };
        const child = spawn(exe, args, opts);

        const onData = (data: Buffer): void => {
            const text = data.toString();
            logStream.write(text);
            for (const line of text.split(/\r?\n/)) {
                if (line) ui.writeOutput(line);
            }
        };

        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', (err) => {
            const msg = `Error spawning process: ${err.message}\n`;
            ui.writeOutput(msg.trimEnd());
            logStream.write(msg);
            resolve(false);
        });
        child.on('close', (code) => {
            logStream.write(`Exit code: ${code}\n`);
            resolve(code === 0);
        });
    });
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
        .filter(e => fs.existsSync(path.join(sourceDir, e.name, 'Makefile')))
        .map(e => e.name);
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printUsage(): void {
    console.log('Usage: bulk3tocmake --source <path> --dest <path> --good <path> --bad <path> --depends <path> --mtb2cmake <path> --logs <path> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --source <path>     ModusToolbox workspace directory; its basename is the BSP name');
    console.log('  --dest <path>       Destination root directory for converted CMake projects');
    console.log('  --good <path>       Directory to move successfully built MTB3 app source into');
    console.log('  --bad <path>        Directory to move failed MTB3 app source into');
    console.log('  --depends <path>    Path to depends.json file');
    console.log('  --mtb2cmake <path>  Path to the mtb2cmake executable');
    console.log('  --logs <path>       Directory to write per-app log files (<appname>.log)');
    console.log('  --dry-run           Print the mtb2cmake command line for each app and exit');
    console.log('  --stop-on-error     Stop immediately on any failure, leaving the dest dir in place');
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
    logs: string;
    dryRun: boolean;
    stopOnError: boolean;
    fancy: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    let source: string | undefined;
    let dest: string | undefined;
    let good: string | undefined;
    let bad: string | undefined;
    let depends: string | undefined;
    let mtb2cmake: string | undefined;
    let logs: string | undefined;
    let dryRun      = false;
    let stopOnError = false;
    let fancy       = false;

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
        } else if (arg === '--logs') {
            i++;
            if (i >= argv.length) { console.error('Error: --logs requires a path argument'); printUsage(); process.exit(1); }
            logs = argv[i];
        } else if (arg === '--dry-run') {
            dryRun = true;
        } else if (arg === '--stop-on-error') {
            stopOnError = true;
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
    if (!logs)      { console.error('Error: --logs is required');      printUsage(); process.exit(1); }

    return { source, dest, good, bad, depends, mtb2cmake, logs, dryRun, stopOnError, fancy };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    const sourceDir    = path.resolve(args.source);
    const destDir      = path.resolve(args.dest);
    const goodDir      = path.resolve(args.good);
    const badDir       = path.resolve(args.bad);
    const logsDir      = path.resolve(args.logs);
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
                args.dest, generatedDirFile
            );
            console.log(`${mtb2cmakeExe} ${cmdArgs.join(' ')}`);
        }
        process.exit(0);
    }

    fs.mkdirSync(destDir, { recursive: true });
    fs.mkdirSync(goodDir, { recursive: true });
    fs.mkdirSync(badDir,  { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // ── Set up UI ──────────────────────────────────────────────────────────
    let ui: FancyUI | undefined;

    if (args.fancy) {
        ui = new FancyUI();
        // Pre-compute the mtb2cmake command string for each app so the UI can show it upfront.
        const uiApps = appDirs.map(name => ({
            name,
            mtb2cmakeCmd: [mtb2cmakeExe, ...buildMtb2CmakeArgs(
                dependsJson, path.join(sourceDir, name), args.dest, generatedDirFile
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

        // Open log file for this app.
        const logFile   = path.join(logsDir, `${appName}.log`);
        const logStream = fs.createWriteStream(logFile, { encoding: 'utf-8' });
        logStream.write(`Log for: ${appName}\n`);
        logStream.write(`Started: ${new Date().toISOString()}\n`);

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
            const mtbArgs = buildMtb2CmakeArgs(dependsJson, appSourceDir, args.dest, generatedDirFile);
            appOk = await runCommandFancy(mtb2cmakeExe, mtbArgs, undefined, ui, logStream);
            ui.setStepDone(appName, 0, appOk);
        } else {
            const mtbArgs = buildMtb2CmakeArgs(dependsJson, appSourceDir, args.dest, generatedDirFile);
            appOk = runCommandPlain(mtb2cmakeExe, mtbArgs, undefined, logStream);
        }

        // --- Read generated cmake dir ---
        let cmakeDir: string | undefined;
        if (appOk) {
            if (!fs.existsSync(generatedDirFile)) {
                const msg = `Error: mtb2cmake did not write ${generatedDirFile}`;
                if (ui) { ui.writeOutput(msg); } else { console.error(`  ${msg}`); }
                logStream.write(`${msg}\n`);
                appOk = false;
            } else {
                cmakeDir = fs.readFileSync(generatedDirFile, 'utf-8').trim().replace(/\//g, path.sep);
                logStream.write(`CMake dir: ${cmakeDir}\n`);
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
                appOk = await runCommandFancy('cmake', ['--preset=llvm-debug'], cmakeDir, ui, logStream);
                ui.setStepDone(appName, 1, appOk);
            } else {
                appOk = runCommandPlain('cmake', ['--preset=llvm-debug'], cmakeDir, logStream);
            }
        }

        // --- cmake --build build/llvm-debug (step 2) ---
        if (appOk && cmakeDir) {
            if (ui) {
                ui.setStepRunning(appName, 2);
                appOk = await runCommandFancy('cmake', ['--build', 'build/llvm-debug'], cmakeDir, ui, logStream);
                ui.setStepDone(appName, 2, appOk);
            } else {
                appOk = runCommandPlain('cmake', ['--build', 'build/llvm-debug'], cmakeDir, logStream);
            }
        }

        logStream.write(`\nFinished: ${new Date().toISOString()}\n`);
        logStream.write(`Result: ${appOk ? 'GOOD' : 'BAD'}\n`);
        await new Promise<void>((res) => logStream.end(res));

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
            failed++;
            failures.push(appName);
            if (ui) {
                ui.setDone(appName, false);
            } else {
                console.error(`  ✗ ${appName} failed`);
                console.log('');
            }
            if (args.stopOnError) {
                if (ui) ui.cleanup();
                console.error(`Stopped after failure: ${appName} (--stop-on-error)`);
                process.exit(1);
            }
            if (cmakeDir && fs.existsSync(cmakeDir)) {
                fs.rmSync(cmakeDir, { recursive: true, force: true });
            }
            if (fs.existsSync(appSourceDir)) {
                moveDirSync(appSourceDir, path.join(badDir, appName));
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

