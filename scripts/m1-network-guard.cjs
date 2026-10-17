'use strict';

// Process-local network fence for the M1 hermetic and isolated test runners.
// This file deliberately has no effect unless M1_NETWORK_MODE is recognized.

const net = require('node:net');

const MODES = new Set(['hermetic', 'isolated-api', 'isolated-test']);
const ISOLATED_PORTS = new Set([13316, 19000, 3188]);

function isPort(value, { allowZero = false } = {}) {
  const port = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value)
      : NaN;
  return Number.isInteger(port) && port >= (allowZero ? 0 : 1) && port <= 65535 ? port : null;
}

function connectTarget(args) {
  const values = Array.isArray(args) ? args : Array.from(args || []);
  let options;
  if (Array.isArray(values[0])) {
    return connectTarget(values[0]);
  }
  if (values[0] && typeof values[0] === 'object') {
    options = values[0];
    if (options.path !== undefined && options.path !== null) return { ipc: true };
    return {
      port: options.port,
      host: options.host ?? options.hostname,
      localAddress: options.localAddress,
      lookup: options.lookup,
    };
  }
  if (typeof values[0] === 'string') return { ipc: true };
  return { port: values[0], host: typeof values[1] === 'string' ? values[1] : undefined };
}

function isLoopbackHost(host, mode) {
  if (host === undefined || host === null) return true; // Node's TCP default is localhost.
  if (typeof host !== 'string') return false;
  const normalized = host.toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    const octets = normalized.split('.').map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255) && (mode === 'hermetic' || normalized === '127.0.0.1');
  }
  return false;
}

function decideConnect(mode, args, hermeticPorts = new Set()) {
  if (!MODES.has(mode)) return { allowed: false, reason: 'mode' };
  const target = connectTarget(args);
  if (target.ipc) return { allowed: false, reason: 'ipc' };
  const port = isPort(target.port);
  if (port === null || !isLoopbackHost(target.host, mode)) return { allowed: false, reason: 'endpoint' };
  if (target.localAddress !== undefined && !isLoopbackHost(target.localAddress, mode)) return { allowed: false, reason: 'source' };
  if (target.lookup !== undefined) return { allowed: false, reason: 'custom-lookup' };
  if (mode === 'hermetic') return hermeticPorts.has(port) ? { allowed: true, port } : { allowed: false, reason: 'unregistered-port' };
  return ISOLATED_PORTS.has(port) ? { allowed: true, port } : { allowed: false, reason: 'port' };
}

function listenTarget(args) {
  const values = Array.isArray(args) ? args : Array.from(args || []);
  const first = values[0];
  if (first && typeof first === 'object') {
    if (first.path !== undefined && first.path !== null) return { ipc: true };
    return { port: first.port, host: first.host };
  }
  if (typeof first === 'string') return { ipc: true };
  return { port: first, host: typeof values[1] === 'string' ? values[1] : undefined };
}

function decideListen(mode, args) {
  if (!MODES.has(mode)) return { allowed: false, reason: 'mode' };
  const target = listenTarget(args);
  if (target.ipc) return { allowed: false, reason: 'ipc' };
  const port = isPort(target.port, { allowZero: mode === 'hermetic' });
  if (port === null) return { allowed: false, reason: 'port' };
  if (mode !== 'hermetic' && port !== 3188) return { allowed: false, reason: 'port' };
  return { allowed: true, port, host: '127.0.0.1' };
}

function blockedError() {
  const error = new Error('Network operation blocked by M1 network guard');
  error.code = 'M1_NETWORK_BLOCKED';
  return error;
}

function forceLoopbackListenArgs(args) {
  const values = Array.from(args);
  if (values[0] && typeof values[0] === 'object') {
    values[0] = { ...values[0], host: '127.0.0.1' };
    return values;
  }
  if (typeof values[1] === 'function' || values[1] === undefined) {
    values.splice(1, 0, '127.0.0.1');
  } else {
    values[1] = '127.0.0.1';
  }
  return values;
}

function installNetworkGuard(options = {}) {
  const mode = options.mode;
  const netModule = options.net || net;
  if (!MODES.has(mode)) throw new TypeError('Unsupported M1 network guard mode');

  const socketPrototype = netModule.Socket.prototype;
  const serverPrototype = netModule.Server.prototype;
  const originalConnect = socketPrototype.connect;
  const originalListen = serverPrototype.listen;
  const hermeticPorts = new Set();
  let restored = false;

  function guardedConnect(...args) {
    if (!decideConnect(mode, args, hermeticPorts).allowed) throw blockedError();
    return originalConnect.apply(this, args);
  }

  function guardedListen(...args) {
    const decision = decideListen(mode, args);
    if (!decision.allowed) throw blockedError();
    const safeArgs = forceLoopbackListenArgs(args);
    if (mode === 'hermetic') {
      let boundPort = null;
      this.once('listening', () => {
        const address = this.address();
        if (address && typeof address === 'object' && Number.isInteger(address.port)) {
          boundPort = address.port;
          hermeticPorts.add(boundPort);
        }
      });
      this.once('close', () => { if (boundPort !== null) hermeticPorts.delete(boundPort); });
    }
    return originalListen.apply(this, safeArgs);
  }

  socketPrototype.connect = guardedConnect;
  serverPrototype.listen = guardedListen;
  return {
    mode,
    hermeticPorts,
    restore() {
      if (restored) return;
      restored = true;
      if (socketPrototype.connect === guardedConnect) socketPrototype.connect = originalConnect;
      if (serverPrototype.listen === guardedListen) serverPrototype.listen = originalListen;
    },
  };
}

let activeGuard = null;
const mode = process.env.M1_NETWORK_MODE;
if (MODES.has(mode)) activeGuard = installNetworkGuard({ mode });

module.exports = {
  MODES,
  ISOLATED_PORTS,
  decideConnect,
  decideListen,
  installNetworkGuard,
  get activeGuard() { return activeGuard; },
};
