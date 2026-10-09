import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next']);
const marker = /^(<<<<<<<(?:\s|$)|=======$|>>>>>>>(?:\s|$))/m;
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
      if (marker.test(line)) findings.push(`${path.relative(root, absolute)}:${index + 1}`);
    });
  }
}

await scan(root);
if (findings.length) {
  console.error(`Unresolved merge conflict markers found:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log('No merge conflict markers found.');
