#!/usr/bin/env node
/**
 * Bounded tracked-source secret scan (S9 evidence).
 *
 * Scope: tracked textual code/config files from `git ls-files` plus any
 * explicitly supplied changed paths. Never reads .env*, .qa, browser
 * profiles, ignored files, claim archives or real secret stores. Findings are
 * reported as `path:line rule-id` only — matched values are never printed,
 * not even partially, so the scan output is safe to paste into a report.
 *
 * Exit codes: 0 clean, 1 findings, 2 usage/environment error.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TEXT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml',
    '.sql', '.md', '.sh', '.ps1', '.env.example', '.example', '.conf', '.ini', '.toml',
]);

const EXCLUDED_PATH_PATTERNS = [
    /(^|\/)\.env(\.|$)/i,
    /(^|\/)\.qa(\/|$)/i,
    /(^|\/)node_modules(\/|$)/i,
    /(^|\/)dist(\/|$)/i,
    /(^|\/)build(\/|$)/i,
    /(^|\/)coverage(\/|$)/i,
    /(^|\/)\.git(\/|$)/i,
    /(^|\/)handoff\/retired-claims(\/|$)/i,
    /package-lock\.json$/i,
];

/**
 * Rules are intentionally narrow so the scan is meaningful: each one matches
 * a credential shape that has no legitimate reason to appear in tracked
 * source. Fixture allowlist entries are explicit, justified and bounded.
 */
const RULES = [
    { id: 'private-key-block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
    { id: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    { id: 'slack-token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
    { id: 'stripe-live-key', pattern: /\bsk_live_[0-9A-Za-z]{16,}\b/ },
    { id: 'jwt-secret-assignment', pattern: /\bJWT_SECRET\s*[:=]\s*['"][^'"\s]{24,}['"]/ },
    { id: 'db-password-assignment', pattern: /\b(?:DB_PASSWORD|MYSQL_ROOT_PASSWORD|MINIO_ROOT_PASSWORD)\s*[:=]\s*['"][^'"\s]{12,}['"]/ },
    { id: 'bearer-token-literal', pattern: /\bBearer\s+eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
];

/**
 * Explicit, justified fixtures: values that are deliberately synthetic test
 * constants and must not fail the scan. Keep this list tiny and specific.
 */
const FIXTURE_ALLOWLIST = [
    { path: /server\/tests\//, rule: 'jwt-secret-assignment', reason: 'synthetic test-only JWT secret constants in hermetic tests' },
    { path: /server\/tests\//, rule: 'db-password-assignment', reason: 'synthetic test-only DB password constants in hermetic tests' },
];

function isTextCandidate(filePath) {
    const base = path.basename(filePath);
    if (base === '.env.example' || base.endsWith('.example')) return true;
    return TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function isExcluded(filePath) {
    const normalized = filePath.split(path.sep).join('/');
    return EXCLUDED_PATH_PATTERNS.some(pattern => pattern.test(normalized));
}

function listTrackedFiles(cwd) {
    const output = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return output.split('\0').filter(Boolean);
}

function scanFile(cwd, relativePath, rules) {
    const absolute = path.join(cwd, relativePath);
    let content;
    try {
        content = fs.readFileSync(absolute, 'utf8');
    } catch {
        return [];
    }
    const findings = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        for (const rule of rules) {
            if (!rule.pattern.test(line)) continue;
            findings.push({ path: relativePath, line: index + 1, rule: rule.id });
            break;
        }
    }
    return findings;
}

function isAllowedFinding(finding, allowlist) {
    return allowlist.some(entry => entry.rule === finding.rule && entry.path.test(finding.path.split(path.sep).join('/')));
}

/**
 * Runs the scan. `changedPaths` are extra task-owned files to include; they
 * must still pass the same exclusion and extension rules.
 */
function scan(options = {}) {
    const cwd = options.cwd || process.cwd();
    const rules = options.rules || RULES;
    const allowlist = options.allowlist || FIXTURE_ALLOWLIST;
    const tracked = listTrackedFiles(cwd);
    const extra = (options.changedPaths || []).map(item => path.relative(cwd, path.resolve(cwd, item)).split(path.sep).join('/'));
    const candidates = [...new Set([...tracked, ...extra])]
        .filter(file => isTextCandidate(file) && !isExcluded(file));

    const findings = [];
    for (const file of candidates) {
        findings.push(...scanFile(cwd, file, rules));
    }
    const allowed = findings.filter(finding => isAllowedFinding(finding, allowlist));
    const blocking = findings.filter(finding => !isAllowedFinding(finding, allowlist));
    return { scannedFiles: candidates.length, findings: blocking, allowlisted: allowed };
}

function main(argv) {
    const args = argv.slice(2);
    const changedIndex = args.indexOf('--changed');
    let changedPaths = [];
    if (changedIndex !== -1) {
        changedPaths = args.slice(changedIndex + 1);
        if (changedPaths.length === 0) {
            console.error('scan-m1-tracked-secrets: --changed requires at least one path');
            return 2;
        }
    }
    let result;
    try {
        result = scan({ cwd: process.cwd(), changedPaths });
    } catch (error) {
        console.error(`scan-m1-tracked-secrets: ${error && error.message ? error.message : 'scan failed'}`);
        return 2;
    }
    // Redacted output only: path:line rule-id. Never the matched value.
    for (const finding of result.findings) {
        console.log(`${finding.path}:${finding.line} ${finding.rule}`);
    }
    console.log(`scanned=${result.scannedFiles} findings=${result.findings.length} allowlisted=${result.allowlisted.length}`);
    return result.findings.length === 0 ? 0 : 1;
}

if (require.main === module) {
    process.exitCode = main(process.argv);
}

module.exports = { RULES, FIXTURE_ALLOWLIST, EXCLUDED_PATH_PATTERNS, scan, isExcluded, isTextCandidate };
