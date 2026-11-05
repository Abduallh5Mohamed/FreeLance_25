import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createMaterialFileDeliveryService, MATERIAL_PDF_MAX_BYTES, type MaterialFileDeliveryConfig } from '../src/services/material-file-delivery';

const id = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pdf = Buffer.from('%PDF-1.7\nsynthetic fixture only\n%%EOF');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const columns = ['id','material_id','tenant_id','course_id','object_key','object_version','sha256','size_bytes','mime_type','status',
  'scan_status','scanned_object_version','scanned_sha256','scan_engine','scan_policy_version','scanned_at'];
function fixture(configured = true) {
  const record: any = { id: id(4), material_id: id(3), tenant_id: id(1), course_id: id(2),
    object_key: `catalog-materials/${id(1)}/${id(2)}/${id(3)}/${id(4)}.pdf`, object_version: Buffer.from('opaque-version '),
    sha256: digest(pdf), size_bytes: pdf.length, mime_type: 'application/pdf', status: 'active', scan_status: 'clean',
    scanned_object_version: Buffer.from('opaque-version '), scanned_sha256: digest(pdf), scan_engine: 'fixture-scanner',
    scan_policy_version: 'v1', scanned_at_epoch: 1000, now_epoch: 1001 };
  const state = { record, schema: true, authorized: true, visible: true, type: 'pdf', reads: 0, begins: 0, releases: 0, rollbacks: 0, destroys: 0,
    authCalls: 0, failBegin: false, failRollback: false, failSql: false, sql: [] as string[] };
  const config: MaterialFileDeliveryConfig = { trustedScanner: { engine: 'fixture-scanner', policyVersion: 'v1' }, timeoutMs: 100,
    reader: { read: async input => { state.reads++; assert.equal(input.objectKey, record.object_key); assert.equal(input.objectVersion, 'opaque-version ');
      return (async function*() { yield pdf.subarray(0, 7); yield pdf.subarray(7); })(); } } };
  const getConnection = async () => ({
    beginTransaction: async () => { state.begins++; if (state.failBegin) throw Error('begin failed'); },
    execute: async (sql: string, params?: any[]): Promise<[any, any]> => {
      state.sql.push(sql); if (state.failSql) throw Error('internal private error');
      if (sql.includes('information_schema')) return [state.schema ? columns.map(column_name => ({ column_name })) : [], []];
      assert.ok(sql.includes('m.is_published=1')); assert.ok(sql.includes('f.tenant_id=?')); assert.ok(sql.trim().endsWith('LIMIT 2'));
      assert.deepEqual(params, [id(5), id(6), id(2), id(1)]); return [[{ ...record }], []];
    },
    commit: async () => { throw Error('read-only'); }, rollback: async () => { state.rollbacks++; if (state.failRollback) throw Error('rollback failed'); },
    release: () => { state.releases++; }, destroy: () => { state.destroys++; },
  });
  const authorize = async () => { state.authCalls++; return state.authorized ? { status: 200,
    body: { contents: state.visible ? [{ content_id: id(5), material_type: state.type }] : [] }, commit: false }
    : { status: 404, body: { error: 'Course not found' }, commit: false }; };
  const input = { courseId: id(2), lessonId: id(6), contentId: id(5), tenantId: id(1), authorize };
  const service = createMaterialFileDeliveryService({ getConnection, config: configured ? config : undefined });
  return { state, config, input, service };
}
test('verified PDF is released only after exact byte hash and a second fresh authorization/source snapshot', async () => {
  const { service, input, state } = fixture(); const result = await service(input);
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.deepEqual(result.bytes, pdf); assert.equal(result.fileId, id(4)); result.release(); result.release();
  assert.equal(state.authCalls, 2); assert.equal(state.begins, 2); assert.equal(state.releases, 2); assert.equal(state.rollbacks, 2);
  assert.equal(state.reads, 1); assert.ok(state.sql.every(sql => !/INSERT|UPDATE|DELETE/.test(sql)));
});
for (const scenario of ['unconfigured','not-visible','no-authority','non-pdf','schema','pending','rejected','revoked','wrong-version','wrong-digest','wrong-policy','wrong-engine','wrong-key','foreign-tenant','foreign-course','oversize','future-scan','missing-scan'] as const) {
  test(`proof ${scenario} refuses before storage read`, async () => {
    const h = fixture(scenario !== 'unconfigured'), r = h.state.record;
    if (scenario === 'not-visible') h.state.visible = false;
    if (scenario === 'no-authority') h.state.authorized = false;
    if (scenario === 'non-pdf') h.state.type = 'video';
    if (scenario === 'schema') h.state.schema = false;
    if (scenario === 'pending' || scenario === 'rejected') r.scan_status = scenario;
    if (scenario === 'revoked') r.status = 'revoked';
    if (scenario === 'wrong-version') r.scanned_object_version = Buffer.from('opaque-version');
    if (scenario === 'wrong-digest') r.scanned_sha256 = '0'.repeat(64);
    if (scenario === 'wrong-policy') r.scan_policy_version = 'old-policy';
    if (scenario === 'wrong-engine') r.scan_engine = 'client-claimed-clean';
    if (scenario === 'wrong-key') r.object_key = 'https://foreign.example/private';
    if (scenario === 'foreign-tenant') r.tenant_id = id(9);
    if (scenario === 'foreign-course') r.course_id = id(9);
    if (scenario === 'oversize') r.size_bytes = MATERIAL_PDF_MAX_BYTES + 1;
    if (scenario === 'future-scan') r.scanned_at_epoch = 1002;
    if (scenario === 'missing-scan') r.scanned_at_epoch = null;
    const result = await h.service(h.input); assert.equal(result.ok, false); assert.equal(h.state.reads, 0);
    assert.ok(!JSON.stringify(result).includes(r.object_key)); assert.ok(!JSON.stringify(result).includes('opaque-version'));
  });
}
for (const kind of ['short','overlong','hash-mismatch','signature','read-error','iterator-error','empty-flood'] as const) {
  test(`reader ${kind} releases no bytes and frees its lease`, async () => {
    const h = fixture();
    if (kind === 'signature') { const body = Buffer.from('not-a-pdf'); h.state.record.size_bytes = body.length; h.state.record.sha256 = h.state.record.scanned_sha256 = digest(body); }
    h.config.reader.read = async () => {
      if (kind === 'read-error') throw Error('private bucket details');
      return (async function*() {
        if (kind === 'iterator-error') throw Error('object failed');
        if (kind === 'empty-flood') { for (let n = 0; n < 16385; n++) yield Buffer.alloc(0); return; }
        yield kind === 'short' ? pdf.subarray(0, 4) : kind === 'overlong' ? Buffer.concat([pdf, Buffer.from('extra')])
          : kind === 'signature' ? Buffer.from('not-a-pdf') : Buffer.from('%PDF-different synthetic bytes');
      })();
    };
    for (let n = 0; n < 3; n++) {
      const result = await h.service(h.input); assert.equal(result.ok, false); if (!result.ok) assert.notEqual(result.body.code, 'MATERIAL_FILE_BUSY');
    }
  });
}
test('a reused chunk buffer cannot mutate already-accepted PDF bytes', async () => {
  const h = fixture(); h.config.reader.read = async () => (async function*() { const chunk = Buffer.from(pdf); yield chunk; chunk.fill(0); })();
  const result = await h.service(h.input); assert.equal(result.ok, true); if (result.ok) { assert.deepEqual(result.bytes, pdf); result.release(); }
});
for (const change of ['revoked','new-version','policy','scan','key'] as const) {
  test(`source/authority ${change} during read refuses before response`, async () => {
    const h = fixture(); h.config.reader.read = async () => (async function*() {
      yield pdf;
      if (change === 'revoked') h.state.authorized = false;
      if (change === 'new-version') h.state.record.object_version = h.state.record.scanned_object_version = Buffer.from('replacement');
      if (change === 'policy') h.state.record.scan_policy_version = 'old';
      if (change === 'scan') h.state.record.scan_status = 'pending';
      if (change === 'key') h.state.record.object_key = 'different';
    })();
    const result = await h.service(h.input); assert.equal(result.ok, false); assert.equal(h.state.authCalls, 2);
  });
}
test('two response leases bound concurrency; release is idempotent and permits a new request', async () => {
  const h = fixture(), first = await h.service(h.input), second = await h.service(h.input);
  assert.ok(first.ok && second.ok); const denied = await h.service(h.input); assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.body.code, 'MATERIAL_FILE_BUSY');
  if (first.ok) { first.release(); first.release(); } if (second.ok) second.release();
  const next = await h.service(h.input); assert.equal(next.ok, true); if (next.ok) next.release();
});
test('storage timeout aborts adapter and releases the service lease', async () => {
  const h = fixture(); h.config.timeoutMs = 10; let signal: AbortSignal | undefined;
  h.config.reader.read = async input => { signal = input.signal; return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }; };
  const result = await h.service(h.input); assert.equal(result.ok, false); assert.equal(signal?.aborted, true);
});
test('caller cancellation never reaches storage when already aborted', async () => {
  const h = fixture(), controller = new AbortController(); controller.abort();
  assert.equal((await h.service({ ...h.input, signal: controller.signal })).ok, false); assert.equal(h.state.reads, 0);
});
for (const flag of ['failBegin','failRollback','failSql'] as const) {
  test(`connection ${flag} fails closed with proper disposal`, async () => {
    const h = fixture(); h.state[flag] = true;
    assert.equal((await h.service(h.input)).ok, false); assert.equal(h.state.reads, 0);
    assert.equal(h.state.destroys, flag === 'failSql' ? 0 : 1); assert.equal(h.state.releases, flag === 'failSql' ? 1 : 0);
  });
}
