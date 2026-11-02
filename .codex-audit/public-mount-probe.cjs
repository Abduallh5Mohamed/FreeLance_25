const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const original = Module._load;
const root = path.resolve(__dirname, '..');
const sqlSeen = [];
const draft = { id: '00000000-0000-4000-8000-000000000001', name: 'PRIVATE DRAFT FIXTURE', publication_state: 'draft' };
Module._load = function(request, parent, isMain) {
  if (parent?.filename?.includes(path.join('server','src','routes'))) {
    if (request === '../db') return {
      query: async sql => { sqlSeen.push(sql); return sql.includes("publication_state='published'") ? [] : [draft]; },
      queryOne: async () => null,
    };
    if (request === '../middleware/auth') return { optionalAuth: (_req, _res, next) => next() };
  }
  return original.apply(this, arguments);
};
const legacy = require(path.join(root, 'server/src/routes/public-identity.ts')).default;
const catalog = require(path.join(root, 'server/src/routes/public-catalog.ts')).default;
Module._load = original;
const index = fs.readFileSync(path.join(root,'server/src/index.ts'),'utf8');
assert.ok(index.indexOf("app.use('/api/public', publicIdentityRoutes)") < index.indexOf("app.use('/api/public', publicCatalogRoutes)"));
const router = Module.createRequire(path.join(root,'server/package.json'))('express').Router();
router.use('/api/public', legacy);
router.use('/api/public', catalog);
new Promise((resolve, reject) => {
  const req = { method: 'GET', url: '/api/public/courses', originalUrl: '/api/public/courses', headers: {}, query: {} };
  const res = { set() { return this; }, status() { return this; }, json: resolve };
  router.handle(req,res,reject);
}).then(body => {
  assert.deepEqual(body,[draft]);
  assert.equal(sqlSeen.length,1);
  assert.ok(!sqlSeen[0].includes('publication_state'));
  console.log('CONFIRMED: mounted legacy handler returned draft fixture; canonical catalog handler was never reached; response is an array. No database/network/listener used.');
}).catch(error => { console.error(error); process.exitCode=1; });
