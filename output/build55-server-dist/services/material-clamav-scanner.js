"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClamAvMaterialScanner = createClamAvMaterialScanner;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
const material_file_delivery_1 = require("./material-file-delivery");
/** No process starts until scan(), and no real scanner is bound by default. */
function createClamAvMaterialScanner(config, start = node_child_process_1.spawn) {
    config = { ...config };
    if (!node_path_1.default.isAbsolute(config.executable) || !node_path_1.default.isAbsolute(config.databaseDirectory) || !node_path_1.default.isAbsolute(config.tempDirectory) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(config.policyVersion)
        || !Number.isInteger(config.maxDatabaseAgeDays) || config.maxDatabaseAgeDays < 1 || config.maxDatabaseAgeDays > 365)
        throw Error('Invalid private scanner configuration');
    const timeout = config.timeoutMs ?? 30000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
        throw Error('Invalid scanner deadline');
    let active = 0;
    return { engine: 'clamav-clamscan', policyVersion: config.policyVersion,
        scan: input => {
            const digest = input.sha256, objectVersion = input.objectVersion;
            const result = (verdict) => ({ verdict, sha256: digest, objectVersion });
            if (active >= 2 || input.signal.aborted || !Buffer.isBuffer(input.bytes) || input.bytes.length < 5 || input.bytes.length > material_file_delivery_1.MATERIAL_PDF_MAX_BYTES
                || !input.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || (0, node_crypto_1.createHash)('sha256').update(input.bytes).digest('hex') !== input.sha256
                || !input.objectVersion || Buffer.byteLength(input.objectVersion) > 255)
                return Promise.resolve(result('failed'));
            active++;
            const bytes = Buffer.from(input.bytes);
            return new Promise(resolve => {
                let child, settled = false, released = false, stdinFinished = false, size = 0;
                const output = [];
                let stderr = false;
                const release = () => { if (!released) {
                    released = true;
                    active--;
                } };
                const finish = (verdict) => { if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    input.signal.removeEventListener('abort', cancel);
                    resolve(result(verdict));
                } };
                const cancel = () => { if (settled)
                    return; try {
                    child?.kill('SIGKILL');
                }
                catch { /* lease held until exit acknowledgement */ } finish('failed'); };
                const timer = setTimeout(cancel, timeout);
                try {
                    child = start(node_path_1.default.normalize(config.executable), ['--stdout', '--no-summary', `--database=${node_path_1.default.normalize(config.databaseDirectory)}`, `--tempdir=${node_path_1.default.normalize(config.tempDirectory)}`,
                        `--fail-if-cvd-older-than=${config.maxDatabaseAgeDays}`, '--alert-exceeds-max=yes', '--alert-encrypted=yes',
                        '--max-filesize=10M', '--max-scansize=40M', '--max-files=1000', '--max-recursion=16', '-'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { LANG: 'C', LC_ALL: 'C',
                            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
                    input.signal.addEventListener('abort', cancel, { once: true });
                    if (input.signal.aborted)
                        cancel();
                    child.once('error', () => { if (!child?.pid)
                        release(); finish('failed'); });
                    child.stdin.once('finish', () => { stdinFinished = true; });
                    child.stdin.on('error', cancel);
                    const consume = (chunk, errorOutput) => {
                        if (settled)
                            return;
                        size += chunk.length;
                        if (size > 32768) {
                            cancel();
                            return;
                        }
                        if (errorOutput && chunk.length)
                            stderr = true;
                        else
                            output.push(Buffer.from(chunk));
                    };
                    child.stdout.on('data', chunk => consume(Buffer.from(chunk), false));
                    child.stderr.on('data', chunk => consume(Buffer.from(chunk), true));
                    child.once('close', (code, signal) => {
                        release();
                        const text = Buffer.concat(output).toString('utf8').trim();
                        finish(signal || stderr || !stdinFinished ? 'failed' : code === 1 ? 'infected'
                            : code === 0 && /^(stdin|stream): OK$/.test(text) ? 'clean' : 'failed');
                    });
                    child.stdin.end(bytes);
                }
                catch {
                    if (child)
                        cancel();
                    else {
                        release();
                        finish('failed');
                    }
                }
            });
        },
    };
}
