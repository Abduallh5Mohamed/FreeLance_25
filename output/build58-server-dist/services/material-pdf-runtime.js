"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMaterialPdfRuntime = createMaterialPdfRuntime;
/** Assembly only: caller must separately verify schema/adapters and explicitly mount. */
function createMaterialPdfRuntime(config) {
    if (typeof config.store?.putOnce !== 'function' || typeof config.store.read !== 'function')
        throw Error('Private material store required');
    if (config.scanner && (typeof config.scanner.scan !== 'function'
        || ![config.scanner.engine, config.scanner.policyVersion].every(value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(value))))
        throw Error('Trusted scanner configuration required');
    return {
        ingestion: { store: config.store, scanner: config.scanner, timeoutMs: config.ingestionTimeoutMs },
        delivery: config.scanner ? { reader: config.store, trustedScanner: { engine: config.scanner.engine, policyVersion: config.scanner.policyVersion }, timeoutMs: config.deliveryTimeoutMs } : undefined,
    };
}
