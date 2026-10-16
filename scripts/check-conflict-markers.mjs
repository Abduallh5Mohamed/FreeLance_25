import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit, safe directory policy: the scan root is the repository that
// contains this script, resolved from the file location — never from the
// caller's working directory. An invocation from a subdirectory (for example
// `cd server && npm run check:conflicts`) must not silently scan only that
// subtree and report success while unresolved markers remain elsewhere.
// The whole tree is covered, tracked and untracked alike, while findings
// carry only `path:line` — never file contents — so secret-bearing files
// are never exposed through this check.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next']);
const marker = /^(<<<<<<<(?:\s|$)|=======$|>>>>>>>(?:\s|$))/m;

/**
 * Find unresolved merge conflict markers under `scanRoot` (defaults to the
 * repository that contains this script). Returns `relative/path:line`
 * entries only — never file contents. Symlinks are not followed, so the
 * scan cannot escape the root through them.
 */
export async function findConflictMarkers(scanRoot = root) {
  const findings = [];
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await scan(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const contents = await readFile(absolute);
      if (contents.includes(0)) continue;
      const text = contents.toString('utf8');
      const lines = text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (marker.test(line)) findings.push(`${path.relative(scanRoot, absolute)}:${index + 1}`);
      });
    }
  }
  await scan(scanRoot);
  return findings;
}

/** CLI report text; the exact strings are asserted by the boundary tests. */
export function formatFindings(findings) {
  return findings.length
    ? `Unresolved merge conflict markers found:\n${findings.join('\n')}`
    : 'No merge conflict markers found.';
}

/** CI contract: any single finding fails the check. */
export function exitCodeFor(findings) {
  return findings.length ? 1 : 0;
}

// Run the check only when this file is executed directly (`node
// scripts/check-conflict-markers.mjs`, which is what `npm run
// check:conflicts` invokes); importing it must stay side-effect free.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  const findings = await findConflictMarkers();
  const exitCode = exitCodeFor(findings);
  const report = formatFindings(findings);
  if (exitCode) console.error(report);
  else console.log(report);
  process.exit(exitCode);
}
