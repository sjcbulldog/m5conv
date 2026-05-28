import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export function run(exe: string, args: string[], cwd?: string, logFile?: string): Promise<RunResult> {
    return new Promise((resolve) => {
        const proc = spawn(exe, args, {
            cwd,
            windowsHide: true,
            shell: false,
        });

        let stdout = '';
        let stderr = '';
        let logStream: fs.WriteStream | undefined;

        if (logFile) {
            try {
                fs.mkdirSync(path.dirname(logFile), { recursive: true });
                logStream = fs.createWriteStream(logFile, { encoding: 'utf-8' });
                logStream.write(`=== command ===\n${exe} ${args.join(' ')}\n\n=== output ===\n`);
            } catch { /* ignore log setup failures */ }
        }

        proc.stdout.on('data', (data: Buffer) => {
            const str = data.toString();
            stdout += str;
            logStream?.write(str);
        });

        proc.stderr.on('data', (data: Buffer) => {
            const str = data.toString();
            stderr += str;
            logStream?.write(str);
        });

        const finish = (code: number): void => {
            const result: RunResult = { exitCode: code, stdout, stderr };
            if (logStream) {
                logStream.write(`\n=== exit code ===\n${code}\n`);
                logStream.end(() => resolve(result));
            } else {
                resolve(result);
            }
        };

        proc.on('close', (code) => finish(code ?? 1));

        proc.on('error', (err) => {
            const msg = '\n' + err.message;
            stderr += msg;
            logStream?.write(msg);
            finish(1);
        });
    });
}
