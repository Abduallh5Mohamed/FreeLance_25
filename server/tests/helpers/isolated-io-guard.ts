/**
 * Default isolation barrier for hermetic suites.
 *
 * Importing this module for its side effect installs a fail-fast guard over
 * every real outbound I/O surface a server test could reach: TCP sockets, TLS,
 * the HTTP(S) clients, DNS lookups, the global `fetch`, and listening servers.
 *
 * A suite that injects its data access, provider and transport never touches
 * any of them. A suite that silently falls back to a real pool, a real
 * provider or a real listener fails IMMEDIATELY with a named error, instead of
 * hanging on a connect timeout or reaching a real system by accident.
 *
 * The guard is test-only; production code never imports it. It is idempotent
 * and installs once per process.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const blocked = (capability: string): never => {
    throw new Error(
        `ISOLATED_IO_BLOCKED:${capability} — this suite must inject its data access, `
        + 'provider and transport; real DB/network/listener access is not allowed here.',
    );
};

/** Replace a property with a throwing stub, keeping it configurable. */
const block = (target: object, property: string, capability: string): void => {
    Object.defineProperty(target, property, {
        value: function blockedCapability(): never {
            return blocked(capability);
        },
        writable: true,
        configurable: true,
    });
};

let installed = false;

/**
 * Install the guard. Called automatically when this module is imported; the
 * named export exists for a suite that wants to be explicit about it.
 */
export const installIsolatedIoGuard = (): void => {
    if (installed) return;
    installed = true;

    // Every mysql2 pool, undici connection, raw client and outbound socket
    // starts here. Blocking the prototype covers them all.
    block(net.Socket.prototype, 'connect', 'net.Socket.connect');
    block(net, 'createConnection', 'net.createConnection');
    block(net, 'connect', 'net.connect');

    // A listener is a real transport too: an isolated suite must drive the
    // router in-process, never over a port.
    block(net.Server.prototype, 'listen', 'net.Server.listen');

    block(tls, 'connect', 'tls.connect');
    block(http, 'request', 'http.request');
    block(http, 'get', 'http.get');
    block(https, 'request', 'https.request');
    block(https, 'get', 'https.get');

    block(dns, 'lookup', 'dns.lookup');
    block(dns.promises, 'lookup', 'dns.promises.lookup');

    Object.defineProperty(globalThis, 'fetch', {
        value: function blockedFetch(): never {
            return blocked('fetch');
        },
        writable: true,
        configurable: true,
    });
};

installIsolatedIoGuard();
