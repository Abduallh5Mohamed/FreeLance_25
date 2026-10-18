import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantHostResolver, normalizeHostHeader, resolveTenantHost, stripPort } from '../src/services/tenant-host';
import { createTenantBrandingRouter } from '../src/routes/tenant-branding';
import { createTenantDomainsRouter } from '../src/routes/tenant-domains';
import { makeFakeDataAccess, invokeRoute } from './helpers/m2-harness';

test('host: strips port safely', () => {
  assert.equal(stripPort('Example.COM:8080'), 'Example.COM');
  assert.equal(stripPort('[::1]:8080'), '[::1]');
  assert.equal(stripPort('example.com'), 'example.com');
  assert.equal(normalizeHostHeader('Example.COM:8080'), 'example.com');
});

test('host: resolves verified custom domain', async () => {
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenant_custom_domains')) return [{ id: 'tenant-a', status: 'active', subdomain: null }];
    return [];
  });
  const resolver = createTenantHostResolver({ query: db.query, queryOne: db.queryOne });
  const res = await resolver.resolve('Shop.Example.com:443');
  assert.equal(res?.tenantId, 'tenant-a');
});

test('host: denies unknown/unverified/suspended', async () => {
  const db = makeFakeDataAccess(() => []);
  const resolver = createTenantHostResolver({ query: db.query, queryOne: db.queryOne });
  assert.equal(await resolver.resolve('unknown.example.com'), null);
});

test('host: platform subdomain resolves active tenant', async () => {
  const db = makeFakeDataAccess((sql, params) => {
    if (sql.includes('FROM tenants') && params?.includes('school')) return [{ id: 'tenant-b', status: 'active', subdomain: 'school' }];
    return [];
  });
  const resolver = createTenantHostResolver({ query: db.query, queryOne: db.queryOne, platformDomain: 'tabweb.test' });
  const res = await resolver.resolve('school.tabweb.test');
  assert.equal(res?.tenantId, 'tenant-b');
});

test('branding: owner-only update validates colors', async () => {
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenants WHERE id = ?') && sql.includes('owner_user_id')) return [{ id: 't1' }];
    if (sql.includes('FROM tenants WHERE id = ?')) return [{ id: 't1', business_name: 'T', status: 'active' }];
    if (sql.includes('FROM tenant_branding')) return [];
    return [];
  });
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const bad = await invokeRoute(router, { method: 'PUT', url: '/', body: { primary_color: 'red' } });
  assert.equal(bad.statusCode, 400);
  const good = await invokeRoute(router, { method: 'PUT', url: '/', body: { primary_color: '#ff0000', locale: 'en', rtl: false } });
  assert.equal(good.statusCode, 200);
});

test('domains: cross-tenant claim denied', async () => {
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 'A', token: 't1', txtName: 'n' });
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenants WHERE id = ?') && !sql.includes('owner_user_id')) return [{ id: 't2', business_name: 'T2', status: 'active' }];
    if (sql.includes('owner_user_id')) return [{ id: 't2' }];
    return [];
  });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u2', tenantId: 't2' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
    txtResolver: async () => [],
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/', body: { hostname: 'school.com' } });
  assert.equal(res.statusCode, 409);
});

test('domains: expired challenge denied on verify', async () => {
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  const claim = await store.savePendingClaim({ hostname: 'school.com', tenantId: 't1', token: 't1', txtName: 'n' });
  (claim as any).createdAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  // mutate store copy not enough; instead inject a fake store
  const fakeStore = {
    findByHostname: async () => ({ ...claim, createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }),
    listByTenant: async () => [],
    savePendingClaim: store.savePendingClaim.bind(store),
    markVerified: store.markVerified.bind(store),
    deleteClaim: store.deleteClaim.bind(store),
  };
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenants WHERE id = ?') && !sql.includes('owner_user_id')) return [{ id: 't1', business_name: 'T', status: 'active' }];
    if (sql.includes('owner_user_id')) return [{ id: 't1' }];
    return [];
  });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: fakeStore as any,
    txtResolver: async () => ['tabweb-verify=t1'],
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/school.com/verify', body: {} });
  assert.equal(res.statusCode, 400);
});

/* ================= tenant-host service ================= */

test('host: normalizeHostHeader rejects non-string and empty', () => {
  assert.equal(normalizeHostHeader(123), null);
  assert.equal(normalizeHostHeader('   '), null);
  assert.equal(normalizeHostHeader(''), null);
});

test('host: stripPort rejects bad ports and ipv6 literals', () => {
  assert.equal(stripPort('example.com:abc'), null);
  assert.equal(stripPort('example.com:80:90'), null);
  assert.equal(stripPort('[::1'), null);
});

test('host: denies suspended tenant on custom domain', async () => {
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenant_custom_domains')) return [{ id: 'tenant-a', status: 'suspended', subdomain: null }];
    return [];
  });
  const resolver = createTenantHostResolver({ query: db.query, queryOne: db.queryOne });
  assert.equal(await resolver.resolve('shop.example.com'), null);
});

test('host: denies unverified custom domain', async () => {
  const db = makeFakeDataAccess(() => []);
  const resolver = createTenantHostResolver({ query: db.query, queryOne: db.queryOne });
  assert.equal(await resolver.resolve('shop.example.com'), null);
});

test('host: denies multi-label platform host', async () => {
  const db = makeFakeDataAccess(() => []);
  const resolver = createTenantHostResolver({ query: db.query, queryOne: db.queryOne, platformDomain: 'tabweb.test' });
  assert.equal(await resolver.resolve('a.b.tabweb.test'), null);
});

test('host: denies punycode/idn label on platform subdomain', async () => {
  const db = makeFakeDataAccess(() => []);
  const resolver = createTenantHostResolver({ query: db.query, queryOne: db.queryOne, platformDomain: 'tabweb.test' });
  assert.equal(await resolver.resolve('xn--abc.tabweb.test'), null);
});

test('host: resolves tenant via detailed resolver with reason', async () => {
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenant_custom_domains')) return [{ id: 'tenant-a', status: 'active', subdomain: null }];
    return [];
  });
  const r = await resolveTenantHost({ query: db.query, queryOne: db.queryOne } as any, 'shop.example.com');
  assert.equal((r as any)?.tenantId, 'tenant-a');
  const detailed = await (await import('../src/services/tenant-host')).resolveTenantHostDetailed({ query: db.query, queryOne: db.queryOne } as any, 123);
  assert.equal(detailed.ok, false);
  assert.equal(detailed.reason, 'BAD_HOST');
});

test('host: stripPort exposed on resolver', () => {
  const resolver = createTenantHostResolver({});
  assert.equal(resolver.stripPort('a.com:80'), 'a.com');
});

test('host: failure propagates when db throws', async () => {
  const db = makeFakeDataAccess(() => { throw new Error('db down'); });
  const resolver = createTenantHostResolver({ query: db.query, queryOne: db.queryOne });
  await assert.rejects(() => resolver.resolve('shop.example.com'), /db down/);
});

/* ================= tenant branding ================= */

function brandingTenantDb() {
  return makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenants WHERE id = ?') && !sql.includes('owner_user_id')) return [{ id: 't1', business_name: 'T', status: 'active' }];
    if (sql.includes('owner_user_id')) return [{ id: 't1' }];
    if (sql.includes('FROM tenant_branding')) return [];
    return [];
  });
}

test('branding: GET allow returns default when no row', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as any).locale, 'ar');
});

test('branding: GET deny without authority', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => null,
  });
  const res = await invokeRoute(router, { method: 'GET', url: '/branding' });
  assert.equal(res.statusCode, 403);
});

test('branding: GET cross-tenant deny', async () => {
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenants WHERE id = ?') && !sql.includes('owner_user_id')) return [{ id: 't2', business_name: 'T2', status: 'active' }];
    return [];
  });
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u2', tenantId: 't2' }; next(); }) as any,
    loadActiveTenantAuthority: async () => null,
  });
  const res = await invokeRoute(router, { method: 'GET', url: '/me' });
  assert.equal(res.statusCode, 403);
});

test('branding: GET failure when db throws', async () => {
  const db = makeFakeDataAccess(() => { throw new Error('db down'); });
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'GET', url: '/' });
  assert.equal(res.statusCode, 500);
});

test('branding: PUT allow valid', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/', body: { primary_color: '#ff0000', locale: 'en', rtl: false } });
  assert.equal(res.statusCode, 200);
});

test('branding: PUT deny without authority', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => null,
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/branding', body: { primary_color: '#ff0000' } });
  assert.equal(res.statusCode, 403);
});

test('branding: PUT cross-tenant deny', async () => {
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenants WHERE id = ?') && !sql.includes('owner_user_id')) return [{ id: 't2', business_name: 'T2', status: 'active' }];
    return [];
  });
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u2', tenantId: 't2' }; next(); }) as any,
    loadActiveTenantAuthority: async () => null,
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/', body: { primary_color: '#ff0000' } });
  assert.equal(res.statusCode, 403);
});

test('branding: PUT validation invalid color', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/', body: { primary_color: 'red' } });
  assert.equal(res.statusCode, 400);
});

test('branding: PUT validation invalid url', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/', body: { logo_url: 'ftp://x' } });
  assert.equal(res.statusCode, 400);
});

test('branding: PUT validation invalid locale', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/', body: { locale: 'fr' } });
  assert.equal(res.statusCode, 400);
});

test('branding: PUT validation rtl non-boolean', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/', body: { rtl: 'yes' } });
  assert.equal(res.statusCode, 400);
});

test('branding: PUT validation nothing to update', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/', body: {} });
  assert.equal(res.statusCode, 400);
});

test('branding: PUT failure when audit throws', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    audit: async () => { throw new Error('audit down'); },
  });
  const res = await invokeRoute(router, { method: 'PUT', url: '/', body: { primary_color: '#ff0000' } });
  assert.equal(res.statusCode, 500);
});

test('branding: PATCH allow valid', async () => {
  const db = brandingTenantDb();
  const router = createTenantBrandingRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'PATCH', url: '/branding', body: { accent_color: '#00ff00' } });
  assert.equal(res.statusCode, 200);
});

/* ================= tenant domains ================= */

function domainsTenantDb() {
  return makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenants WHERE id = ?') && !sql.includes('owner_user_id')) return [{ id: 't1', business_name: 'T', status: 'active' }];
    if (sql.includes('owner_user_id')) return [{ id: 't1' }];
    return [];
  });
}

test('domains: GET allow list', async () => {
  const db = domainsTenantDb();
  const store = (await import('../src/services/domain-verification')).createMemoryDomainClaimStore();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
  });
  const res = await invokeRoute(router, { method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body));
});

test('domains: GET deny without authority', async () => {
  const db = domainsTenantDb();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => null,
  });
  const res = await invokeRoute(router, { method: 'GET', url: '/domains' });
  assert.equal(res.statusCode, 403);
});

test('domains: GET cross-tenant deny', async () => {
  const db = makeFakeDataAccess((sql) => {
    if (sql.includes('FROM tenants WHERE id = ?') && !sql.includes('owner_user_id')) return [{ id: 't2', business_name: 'T2', status: 'active' }];
    return [];
  });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u2', tenantId: 't2' }; next(); }) as any,
    loadActiveTenantAuthority: async () => null,
  });
  const res = await invokeRoute(router, { method: 'GET', url: '/' });
  assert.equal(res.statusCode, 403);
});

test('domains: GET failure when db throws', async () => {
  const db = makeFakeDataAccess(() => { throw new Error('db down'); });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'GET', url: '/' });
  assert.equal(res.statusCode, 500);
});

test('domains: POST claim allow', async () => {
  const db = domainsTenantDb();
  const store = (await import('../src/services/domain-verification')).createMemoryDomainClaimStore();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
    txtResolver: async () => [],
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/', body: { hostname: 'school.com' } });
  assert.equal(res.statusCode, 201);
});

test('domains: POST claim deny without authority', async () => {
  const db = domainsTenantDb();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => null,
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/claim', body: { hostname: 'school.com' } });
  assert.equal(res.statusCode, 403);
});

test('domains: POST claim validation bad hostname', async () => {
  const db = domainsTenantDb();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/', body: { hostname: 'localhost' } });
  assert.equal(res.statusCode, 400);
});

test('domains: POST claim failure when audit throws', async () => {
  const db = domainsTenantDb();
  const store = (await import('../src/services/domain-verification')).createMemoryDomainClaimStore();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
    audit: async () => { throw new Error('audit down'); },
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/', body: { hostname: 'school2.com' } });
  assert.equal(res.statusCode, 500);
});

test('domains: POST verify allow', async () => {
  const db = domainsTenantDb();
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 't1', token: 't1', txtName: 'n' });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
    txtResolver: async () => ['tabweb-verify=t1'],
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/school.com/verify', body: {} });
  assert.equal(res.statusCode, 200);
});

test('domains: POST verify deny cross-tenant', async () => {
  const db = domainsTenantDb();
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 'other', token: 't1', txtName: 'n' });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
    txtResolver: async () => ['tabweb-verify=t1'],
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/verify', body: { hostname: 'school.com' } });
  assert.equal(res.statusCode, 404);
});

test('domains: POST verify validation bad hostname', async () => {
  const db = domainsTenantDb();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/verify', body: { hostname: 'localhost' } });
  assert.equal(res.statusCode, 400);
});

test('domains: POST verify DNS mismatch', async () => {
  const db = domainsTenantDb();
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 't1', token: 't1', txtName: 'n' });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
    txtResolver: async () => [],
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/school.com/verify', body: {} });
  assert.equal(res.statusCode, 400);
});

test('domains: POST verify failure when audit throws', async () => {
  const db = domainsTenantDb();
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 't1', token: 't1', txtName: 'n' });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
    txtResolver: async () => ['tabweb-verify=t1'],
    audit: async () => { throw new Error('audit down'); },
  });
  const res = await invokeRoute(router, { method: 'POST', url: '/school.com/verify', body: {} });
  assert.equal(res.statusCode, 500);
});

test('domains: DELETE revoke allow', async () => {
  const db = domainsTenantDb();
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 't1', token: 't1', txtName: 'n' });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
  });
  const res = await invokeRoute(router, { method: 'DELETE', url: '/school.com', body: {} });
  assert.equal(res.statusCode, 200);
});

test('domains: DELETE revoke deny without authority', async () => {
  const db = domainsTenantDb();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => null,
  });
  const res = await invokeRoute(router, { method: 'DELETE', url: '/revoke', body: { hostname: 'school.com' } });
  assert.equal(res.statusCode, 403);
});

test('domains: DELETE revoke cross-tenant', async () => {
  const db = domainsTenantDb();
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 'other', token: 't1', txtName: 'n' });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
  });
  const res = await invokeRoute(router, { method: 'DELETE', url: '/school.com', body: {} });
  assert.equal(res.statusCode, 404);
});

test('domains: DELETE revoke validation bad hostname', async () => {
  const db = domainsTenantDb();
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
  });
  const res = await invokeRoute(router, { method: 'DELETE', url: '/revoke', body: { hostname: 'localhost' } });
  assert.equal(res.statusCode, 400);
});

test('domains: DELETE revoke failure when audit throws', async () => {
  const db = domainsTenantDb();
  const { createMemoryDomainClaimStore } = await import('../src/services/domain-verification');
  const store = createMemoryDomainClaimStore();
  await store.savePendingClaim({ hostname: 'school.com', tenantId: 't1', token: 't1', txtName: 'n' });
  const router = createTenantDomainsRouter({
    db: { query: db.query, queryOne: db.queryOne, execute: db.execute },
    authenticate: ((_req: any, _res: any, next: any) => { (_req as any).user = { id: 'u1', tenantId: 't1' }; next(); }) as any,
    loadActiveTenantAuthority: async () => ({ authority: 'owner' }),
    domainClaimStore: store,
    audit: async () => { throw new Error('audit down'); },
  });
  const res = await invokeRoute(router, { method: 'DELETE', url: '/school.com', body: {} });
  assert.equal(res.statusCode, 500);
});

/* host: resolver creation failure when no data access */
test('host: createTenantHostResolver throws when resolving without data access', async () => {
  const resolver = createTenantHostResolver({});
  await assert.rejects(() => resolver.resolve('example.com'), /requires query\/queryOne/);
});

test('host: detailed resolver deny reasons', async () => {
  const db = makeFakeDataAccess(() => []);
  const detailed = await (await import('../src/services/tenant-host')).resolveTenantHostDetailed({ query: db.query, queryOne: db.queryOne } as any, 'unknown.example.com');
  assert.equal(detailed.ok, false);
  assert.equal(detailed.reason, 'HOST_NOT_RESOLVED');
});
