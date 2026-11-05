import { AsyncLocalStorage } from 'node:async_hooks';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Client } from 'minio';
import type { MaterialFileStore } from './material-file-ingestion';
import { MATERIAL_PDF_MAX_BYTES } from './material-file-delivery';

type Transport = Pick<typeof http, 'request'>;
const transient = new Set([408,429,499,500,502,503,504,520]);
const bad = () => new Error('Private material storage unavailable');
const token = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value === 'null' || Buffer.byteLength('minio-version:' + value) > 255) throw bad();
  return 'minio-version:' + value;
};
const raw = (value: string): string => { if (!value.startsWith('minio-version:')) throw bad(); const version = value.slice(14); if (token(version) !== value) throw bad(); return version; };
const keyValid = (key: string) => /^catalog-materials\/[a-z0-9_-]{1,64}\/[a-f\d-]{36}\/[a-f\d-]{36}\/[a-f\d-]{36}\.pdf$/.test(key);

/** Explicit construction only. No import of the eager legacy MinIO/env module. */
export function createMinioMaterialFileStore(config: {
  endPoint: string; port: number; useSSL: boolean; accessKey: string; secretKey: string; region: string; bucket: string;
}, wire: Transport = config.useSSL ? https : http): MaterialFileStore {
  config = { ...config };
  if (!config.endPoint || !config.accessKey || !config.secretKey || !config.region || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket)) throw bad();
  const context = new AsyncLocalStorage<AbortSignal>();
  const transport: Transport = { request: ((options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const signal = context.getStore(); if (!signal || signal.aborted) throw bad();
    const request = wire.request({ ...options, signal }, response => {
      // The installed SDK otherwise retries 5xx with unbounded backoff/logging.
      // Domain recovery owns retries; convert transient HTTP responses to errors.
      if (transient.has(response.statusCode ?? 0)) { response.destroy(); request.destroy(bad()); return; }
      callback(response);
    });
    request.setTimeout(10000, () => request.destroy(bad()));
    return request;
  }) as typeof http.request };
  let client: Client;
  try { client = new Client({ ...config, transport, partSize: 64 * 1024 * 1024 }); } catch { throw bad(); }
  const verifyBucket = async () => {
    try {
      const policy = await client.getBucketPolicy(config.bucket);
      if (policy.trim()) throw bad(); // Dedicated bucket only: no anonymous policy accepted.
    } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'NoSuchBucketPolicy') throw bad(); }
    const versioning = await client.getBucketVersioning(config.bucket);
    if (versioning.Status !== 'Enabled') throw bad();
  };
  const operation = <T>(signal: AbortSignal, work: () => Promise<T>) => {
    if (signal.aborted) return Promise.reject(bad());
    return context.run(signal, async () => { try { await verifyBucket(); if (signal.aborted) throw bad(); return await work(); } catch { throw bad(); } });
  };
  return {
    putOnce: input => {
      if (!keyValid(input.objectKey) || input.bytes.length < 5 || input.bytes.length > MATERIAL_PDF_MAX_BYTES || !/^[a-f\d]{64}$/.test(input.sha256)
        || createHash('sha256').update(input.bytes).digest('hex') !== input.sha256) return Promise.reject(bad());
      const bytes = Buffer.from(input.bytes), digest = input.sha256;
      return operation(input.signal, async () => {
      try {
        const result = await client.putObject(config.bucket, input.objectKey, bytes, bytes.length,
          { 'Content-Type': 'application/pdf', 'If-None-Match': '*', 'x-amz-meta-sha256': digest });
        return { objectVersion: token(result.versionId) };
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || !['PreconditionFailed','ConditionalRequestConflict'].includes(String(error.code))) throw bad();
        const stat = await client.statObject(config.bucket, input.objectKey);
        const metadata = Object.fromEntries(Object.entries(stat.metaData ?? {}).map(([key,value]) => [key.toLowerCase(), value]));
        if (stat.size !== bytes.length || metadata['content-type'] !== 'application/pdf' || metadata.sha256 !== digest) throw bad();
        return { objectVersion: token(stat.versionId) };
      }
      });
    },
    read: input => operation(input.signal, async () => {
      if (!keyValid(input.objectKey)) throw bad();
      const versionId = raw(input.objectVersion);
      const stream = await client.getObject(config.bucket, input.objectKey, { versionId });
      const versionHeader = (stream as Readable & { headers?: Record<string,string> }).headers?.['x-amz-version-id'];
      if (versionHeader !== versionId || input.signal.aborted) { stream.destroy(); throw bad(); }
      const cancel = () => stream.destroy(bad()); input.signal.addEventListener('abort', cancel, { once: true });
      // Keep a listener even before consumption to avoid an unhandled error on cancellation.
      stream.on('error', () => {});
      return (async function*() {
        let size = 0;
        try { for await (const chunk of stream) {
          if (input.signal.aborted || !(chunk instanceof Uint8Array)) throw bad();
          size += chunk.byteLength; if (size > MATERIAL_PDF_MAX_BYTES) throw bad(); yield chunk;
        } } finally { input.signal.removeEventListener('abort', cancel); stream.destroy(); }
      })();
    }),
  };
}
