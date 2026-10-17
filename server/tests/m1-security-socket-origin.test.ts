import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const socketPath = path.join(__dirname, '..', 'src', 'services', 'socket.ts');
const socketSource = readFileSync(socketPath, 'utf8');
const sourceFile = ts.createSourceFile(socketPath, socketSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'isAllowedSocketOrigin');
assert.ok(declaration, 'Expected isAllowedSocketOrigin in server/src/services/socket.ts');
const javascript = ts.transpile(declaration.getText(sourceFile), { target: ts.ScriptTarget.ES2020 });
const isAllowedSocketOrigin = vm.runInNewContext(`(${javascript})`, { URL }) as (
    origin: string | undefined,
    corsOrigin: string | undefined,
    vercelUrl: string | undefined,
    nodeEnv: string | undefined,
) => boolean;

test('socket CORS allows absent origins, configured origins, and exact development loopback hosts', () => {
    assert.equal(isAllowedSocketOrigin(undefined, undefined, undefined, 'development'), true);
    assert.equal(isAllowedSocketOrigin('https://academy.example', 'https://academy.example', undefined, 'production'), true);
    assert.equal(isAllowedSocketOrigin('https://demo.vercel.app', undefined, 'demo.vercel.app', 'production'), true);
    assert.equal(isAllowedSocketOrigin('http://localhost:8080', undefined, undefined, 'development'), true);
    assert.equal(isAllowedSocketOrigin('https://127.0.0.1:8443', undefined, undefined, 'test'), true);
});

test('socket CORS rejects unconfigured loopback origins in production', () => {
    assert.equal(isAllowedSocketOrigin('http://localhost:3000', undefined, undefined, 'production'), false);
    assert.equal(isAllowedSocketOrigin('http://127.0.0.1:4173', undefined, undefined, 'production'), false);
});

test('socket CORS denies lookalike hosts, malformed origins, and non-origin URLs', () => {
    assert.equal(isAllowedSocketOrigin('https://localhost.attacker.example', undefined, undefined, 'development'), false);
    assert.equal(isAllowedSocketOrigin('https://evil-localhost.net', undefined, undefined, 'development'), false);
    assert.equal(isAllowedSocketOrigin('http://127.0.0.1.attacker.example', undefined, undefined, 'development'), false);
    assert.equal(isAllowedSocketOrigin('http://localhost:8080/path', undefined, undefined, 'development'), false);
    assert.equal(isAllowedSocketOrigin('ftp://localhost', undefined, undefined, 'development'), false);
    assert.equal(isAllowedSocketOrigin('not-an-origin', undefined, undefined, 'development'), false);
});

test('socket CORS matches configured origins exactly', () => {
    assert.equal(isAllowedSocketOrigin('https://academy.example', 'https://academy.example', undefined, 'production'), true);
    assert.equal(isAllowedSocketOrigin('https://academy.example.evil.test', 'https://academy.example', undefined, 'production'), false);
    assert.equal(isAllowedSocketOrigin('https://academy.example/path', 'https://academy.example', undefined, 'production'), false);
});
