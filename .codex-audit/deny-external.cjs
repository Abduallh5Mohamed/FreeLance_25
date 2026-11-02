const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
function deny() { throw new Error('AUDIT_EXTERNAL_IO_BLOCKED'); }
net.Socket.prototype.connect = deny;
net.Server.prototype.listen = deny;
tls.connect = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
globalThis.fetch = deny;
