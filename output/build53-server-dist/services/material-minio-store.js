"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMinioMaterialFileStore = createMinioMaterialFileStore;
const node_async_hooks_1 = require("node:async_hooks");
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const node_crypto_1 = require("node:crypto");
const minio_1 = require("minio");
const material_file_delivery_1 = require("./material-file-delivery");
const transient = new Set([408, 429, 499, 500, 502, 503, 504, 520]);
const bad = () => new Error('Private material storage unavailable');
const token = (value) => {
    if (typeof value !== 'string' || !value || value === 'null' || Buffer.byteLength('minio-version:' + value) > 255)
        throw bad();
    return 'minio-version:' + value;
};
const raw = (value) => { if (!value.startsWith('minio-version:'))
    throw bad(); const version = value.slice(14); if (token(version) !== value)
    throw bad(); return version; };
const keyValid = (key) => /^catalog-materials\/[a-z0-9_-]{1,64}\/[a-f\d-]{36}\/[a-f\d-]{36}\/[a-f\d-]{36}\.pdf$/.test(key);
/** Explicit construction only. No import of the eager legacy MinIO/env module. */
function createMinioMaterialFileStore(config, wire = config.useSSL ? https : http) {
    config = { ...config };
    if (!config.endPoint || !config.accessKey || !config.secretKey || !config.region || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket))
        throw bad();
    const context = new node_async_hooks_1.AsyncLocalStorage();
    const transport = { request: ((options, callback) => {
            const signal = context.getStore();
            if (!signal || signal.aborted)
                throw bad();
            const request = wire.request({ ...options, signal }, response => {
                // The installed SDK otherwise retries 5xx with unbounded backoff/logging.
                // Domain recovery owns retries; convert transient HTTP responses to errors.
                if (transient.has(response.statusCode ?? 0)) {
                    response.destroy();
                    request.destroy(bad());
                    return;
                }
                callback(response);
            });
            request.setTimeout(10000, () => request.destroy(bad()));
            return request;
        }) };
    let client;
    try {
        client = new minio_1.Client({ ...config, transport, partSize: 64 * 1024 * 1024 });
    }
    catch {
        throw bad();
    }
    const verifyBucket = async () => {
        try {
            const policy = await client.getBucketPolicy(config.bucket);
            if (policy.trim())
                throw bad(); // Dedicated bucket only: no anonymous policy accepted.
        }
        catch (error) {
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'NoSuchBucketPolicy')
                throw bad();
        }
        const versioning = await client.getBucketVersioning(config.bucket);
        if (versioning.Status !== 'Enabled')
            throw bad();
    };
    const operation = (signal, work) => {
        if (signal.aborted)
            return Promise.reject(bad());
        return context.run(signal, async () => { try {
            await verifyBucket();
            if (signal.aborted)
                throw bad();
            return await work();
        }
        catch {
            throw bad();
        } });
    };
    return {
        putOnce: input => {
            if (!keyValid(input.objectKey) || input.bytes.length < 5 || input.bytes.length > material_file_delivery_1.MATERIAL_PDF_MAX_BYTES || !/^[a-f\d]{64}$/.test(input.sha256)
                || (0, node_crypto_1.createHash)('sha256').update(input.bytes).digest('hex') !== input.sha256)
                return Promise.reject(bad());
            const bytes = Buffer.from(input.bytes), digest = input.sha256;
            return operation(input.signal, async () => {
                try {
                    const result = await client.putObject(config.bucket, input.objectKey, bytes, bytes.length, { 'Content-Type': 'application/pdf', 'If-None-Match': '*', 'x-amz-meta-sha256': digest });
                    return { objectVersion: token(result.versionId) };
                }
                catch (error) {
                    if (!error || typeof error !== 'object' || !('code' in error) || !['PreconditionFailed', 'ConditionalRequestConflict'].includes(String(error.code)))
                        throw bad();
                    const stat = await client.statObject(config.bucket, input.objectKey);
                    const metadata = Object.fromEntries(Object.entries(stat.metaData ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
                    if (stat.size !== bytes.length || metadata['content-type'] !== 'application/pdf' || metadata.sha256 !== digest)
                        throw bad();
                    return { objectVersion: token(stat.versionId) };
                }
            });
        },
        read: input => operation(input.signal, async () => {
            if (!keyValid(input.objectKey))
                throw bad();
            const versionId = raw(input.objectVersion);
            const stream = await client.getObject(config.bucket, input.objectKey, { versionId });
            const versionHeader = stream.headers?.['x-amz-version-id'];
            if (versionHeader !== versionId || input.signal.aborted) {
                stream.destroy();
                throw bad();
            }
            const cancel = () => stream.destroy(bad());
            input.signal.addEventListener('abort', cancel, { once: true });
            // Keep a listener even before consumption to avoid an unhandled error on cancellation.
            stream.on('error', () => { });
            return (async function* () {
                let size = 0;
                try {
                    for await (const chunk of stream) {
                        if (input.signal.aborted || !(chunk instanceof Uint8Array))
                            throw bad();
                        size += chunk.byteLength;
                        if (size > material_file_delivery_1.MATERIAL_PDF_MAX_BYTES)
                            throw bad();
                        yield chunk;
                    }
                }
                finally {
                    input.signal.removeEventListener('abort', cancel);
                    stream.destroy();
                }
            })();
        }),
    };
}
