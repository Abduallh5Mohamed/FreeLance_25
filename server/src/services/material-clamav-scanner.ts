import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MaterialPdfScanner } from './material-file-ingestion';
import { MATERIAL_PDF_MAX_BYTES } from './material-file-delivery';

type Start = (file: string, args: string[], options: { shell: false; windowsHide: true; stdio: ['pipe','pipe','pipe']; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
/** No process starts until scan(), and no real scanner is bound by default. */
export function createClamAvMaterialScanner(config: {
  executable: string; databaseDirectory: string; tempDirectory: string; policyVersion: string; maxDatabaseAgeDays: number; timeoutMs?: number;
}, start: Start = spawn): MaterialPdfScanner {
  config = { ...config };
  if (!path.isAbsolute(config.executable) || !path.isAbsolute(config.databaseDirectory) || !path.isAbsolute(config.tempDirectory) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(config.policyVersion)
    || !Number.isInteger(config.maxDatabaseAgeDays) || config.maxDatabaseAgeDays < 1 || config.maxDatabaseAgeDays > 365) throw Error('Invalid private scanner configuration');
  const timeout = config.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw Error('Invalid scanner deadline');
  let active = 0;
  return { engine: 'clamav-clamscan', policyVersion: config.policyVersion,
    scan: input => {
      const digest = input.sha256, objectVersion = input.objectVersion;
      const result = (verdict: 'clean'|'infected'|'failed') => ({ verdict, sha256: digest, objectVersion });
      if (active >= 2 || input.signal.aborted || !Buffer.isBuffer(input.bytes) || input.bytes.length < 5 || input.bytes.length > MATERIAL_PDF_MAX_BYTES
        || !input.bytes.subarray(0,5).equals(Buffer.from('%PDF-')) || createHash('sha256').update(input.bytes).digest('hex') !== input.sha256
        || !input.objectVersion || Buffer.byteLength(input.objectVersion) > 255) return Promise.resolve(result('failed'));
      active++;
      const bytes = Buffer.from(input.bytes);
      return new Promise(resolve => {
        let child: ChildProcessWithoutNullStreams | undefined, settled = false, released = false, stdinFinished = false, size = 0;
        const output: Buffer[] = []; let stderr = false;
        const release = () => { if (!released) { released = true; active--; } };
        const finish = (verdict: 'clean'|'infected'|'failed') => { if (!settled) { settled = true; clearTimeout(timer); input.signal.removeEventListener('abort', cancel); resolve(result(verdict)); } };
        const cancel = () => { if (settled) return; try { child?.kill('SIGKILL'); } catch { /* lease held until exit acknowledgement */ } finish('failed'); };
        const timer = setTimeout(cancel, timeout);
        try {
          child = start(path.normalize(config.executable), ['--stdout','--no-summary',`--database=${path.normalize(config.databaseDirectory)}`,`--tempdir=${path.normalize(config.tempDirectory)}`,
            `--fail-if-cvd-older-than=${config.maxDatabaseAgeDays}`,'--alert-exceeds-max=yes','--alert-encrypted=yes',
            '--max-filesize=10M','--max-scansize=40M','--max-files=1000','--max-recursion=16','-'],
            { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { LANG: 'C', LC_ALL: 'C',
              ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
          input.signal.addEventListener('abort', cancel, { once: true }); if (input.signal.aborted) cancel();
          child.once('error', () => { if (!child?.pid) release(); finish('failed'); });
          child.stdin.once('finish', () => { stdinFinished = true; }); child.stdin.on('error', cancel);
          const consume = (chunk: Buffer, errorOutput: boolean) => {
            if (settled) return;
            size += chunk.length; if (size > 32768) { cancel(); return; }
            if (errorOutput && chunk.length) stderr = true; else output.push(Buffer.from(chunk));
          };
          child.stdout.on('data', chunk => consume(Buffer.from(chunk), false)); child.stderr.on('data', chunk => consume(Buffer.from(chunk), true));
          child.once('close', (code, signal) => {
            release(); const text = Buffer.concat(output).toString('utf8').trim();
            finish(signal || stderr || !stdinFinished ? 'failed' : code === 1 ? 'infected'
              : code === 0 && /^(stdin|stream): OK$/.test(text) ? 'clean' : 'failed');
          });
          child.stdin.end(bytes);
        } catch { if (child) cancel(); else { release(); finish('failed'); } }
      });
    },
  };
}
