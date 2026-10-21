import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import searchRoutes from '../src/routes/search';
import tenantExportRoutes from '../src/routes/tenant-export';
import platformMfaRoutes from '../src/routes/platform-mfa';
import { invokeRoute } from './helpers/m2-harness';

const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');

test('stabilization: environment precedes route capture; API mounts follow shared guards', () => {
    assert.ok(source.indexOf("import 'dotenv/config'") < source.indexOf("from './routes/tenant-export'"));
    const guard = source.indexOf("app.use('/api', optionalAuth, enforceTenantAuthorityBoundary, enforceStudentWorkspaceBoundary)");
    assert.ok(guard > 0);
    const terminal404 = source.indexOf('// 404 handler');
    assert.ok(terminal404 > guard);
    for (const [path, router] of [
        ['/api/search', 'searchRoutes'],
        ['/api/tenant-exports', 'tenantExportRoutes'],
        ['/api/platform/mfa', 'platformMfaRoutes'],
    ]) {
        const mount = `app.use('${path}', ${router})`;
        assert.ok(source.indexOf(mount) > guard);
        assert.ok(source.indexOf(mount) < terminal404);
        assert.equal(source.split(mount).length - 1, 1);
    }
    assert.doesNotMatch(source, /app\.use\(['"]\/api\/certificates/);
    assert.doesNotMatch(source, /app\.use\(['"]\/api\/impersonation/);
    assert.equal((source.match(/mountObservability\(app,/g) ?? []).length, 1);
    assert.doesNotMatch(source, /console\.log\([^\n]*req\.path/);
});

test('stabilization: actual production API routers deny anonymous callers before DB/storage', async () => {
    const app = Router();
    app.use('/api/search', searchRoutes);
    app.use('/api/tenant-exports', tenantExportRoutes);
    app.use('/api/platform/mfa', platformMfaRoutes);
    for (const url of ['/api/search?kind=courses&q=math', '/api/tenant-exports', '/api/platform/mfa/status']) {
        const result = await invokeRoute(app, { method: 'GET', url });
        assert.equal(result.statusCode, 401, url);
    }
});
