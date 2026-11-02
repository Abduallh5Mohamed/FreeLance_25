/**
 * Proves the isolation barrier actually blocks every surface it claims to.
 *
 * This is the negative control for the hermetic suites: if the guard silently
 * stopped working, a suite could quietly reach a real pool, provider or port
 * again. Each assertion below must throw the named error.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import dns from 'node:dns';
import net from 'node:net';
import './isolated-io-guard';

test('the isolation guard blocks sockets, listeners, DNS and fetch', () => {
    assert.throws(
        () => net.createConnection({ port: 3306 }),
        /ISOLATED_IO_BLOCKED:net\.createConnection/,
        'a raw outbound socket must be blocked',
    );
    assert.throws(
        () => new net.Socket().connect({ port: 3306 }),
        /ISOLATED_IO_BLOCKED:net\.Socket\.connect/,
        'the socket prototype must be blocked (mysql2 reaches the DB through it)',
    );
    assert.throws(
        () => net.createServer().listen(0),
        /ISOLATED_IO_BLOCKED:net\.Server\.listen/,
        'an in-process listener must be blocked',
    );
    assert.throws(
        () => dns.lookup('example.com'),
        /ISOLATED_IO_BLOCKED:dns\.lookup/,
        'a DNS lookup must be blocked',
    );
    assert.throws(
        () => fetch('https://example.com'),
        /ISOLATED_IO_BLOCKED:fetch/,
        'the global fetch must be blocked',
    );
});
