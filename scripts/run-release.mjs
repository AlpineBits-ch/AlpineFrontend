// Run the release binary and tee everything it writes to a log file.
//
// The point of this script is diagnosing the *shipped* build. A release build differs from
// `tauri dev` in three ways that all matter to voice: it is compiled with optimisations and without
// debug assertions, it serves the production Angular bundle from the app itself rather than from
// `ng serve`, and it is linked as a GUI subsystem binary. Any of those can change timing, and the
// third is why nobody could read a released client's output before - see `attach_parent_console`
// in src-tauri/src/main.rs.
//
// Started here rather than by double-clicking the exe so there is a parent console to attach to and
// somewhere to keep the transcript. The log is what gets attached to a bug report.

import {spawn} from 'node:child_process';
import {createWriteStream, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exe = join(
    root,
    'src-tauri',
    'target',
    'release',
    process.platform === 'win32' ? 'Venta.exe' : 'Venta',
);

// One file per run, named so several runs can be compared side by side.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = join(root, 'logs');
mkdirSync(logDir, {recursive: true});
const logPath = join(logDir, `venta-${stamp}.log`);
const log = createWriteStream(logPath);

console.log(`> ${exe}`);
console.log(`> logging to ${logPath}\n`);

// `pipe`, not `inherit`: inherited handles would go straight to the terminal and there would be
// nothing left to write to the file.
const child = spawn(exe, process.argv.slice(2), {stdio: ['inherit', 'pipe', 'pipe']});

for (const [stream, sink] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
]) {
    stream.on('data', chunk => {
        sink.write(chunk);
        log.write(chunk);
    });
}

child.on('error', err => {
    console.error(`could not start ${exe}: ${err.message}`);
    console.error('build it first with: bun run tauri:ci:run');
    process.exit(1);
});

child.on('exit', (code, signal) => {
    log.end(() => {
        console.log(`\n> exited with ${signal ?? code}; log saved to ${logPath}`);
        process.exit(code ?? 1);
    });
});
