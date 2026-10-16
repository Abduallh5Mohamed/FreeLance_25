import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';
import vm from 'node:vm';
import express from 'express';
import ts from 'typescript';

const indexPath = path.join(__dirname, '..', 'src', 'index.ts');
const indexSource = readFileSync(indexPath, 'utf8');
const sourceFile = ts.createSourceFile(indexPath, indexSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function loadProductionFunction(name: string): unknown {
    const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, `Expected ${name} in server/src/index.ts`);
    const javascript = ts.transpile(declaration.getText(sourceFile), { target: ts.ScriptTarget.ES2020 });
    return vm.runInNewContext(`(${javascript})`, { URL });
}

const isAllowedCorsOrigin = loadProductionFunction('isAllowedCorsOrigin') as (
    origin: string | undefined,
    corsOrigin: string | undefined,
    vercelUrl: string | undefined,
) => boolean;
const trustedProxyAddresses = loadProductionFunction('trustedProxyAddresses') as (
    value: string | undefined,
) => string[];
const getErrorResponse = loadProductionFunction('getErrorResponse') as (
    error: Error,
) => { status: number; body: { error: string; message?: string } };

test('CORS allows absent origins, configured origins, and exact loopback hosts', () => {
    assert.equal(isAllowedCorsOrigin(undefined, undefined, undefined), true);
    assert.equal(isAllowedCorsOrigin('http://localhost:5173', undefined, undefined), true);
    assert.equal(isAllowedCorsOrigin('http://127.0.0.1:4173', undefined, undefined), true);
    assert.equal(isAllowedCorsOrigin('https://academy.example', 'https://academy.example', undefined), true);
    assert.equal(isAllowedCorsOrigin('https://demo.vercel.app', undefined, 'demo.vercel.app'), true);
});

test('CORS denies lookalike hosts and malformed origins', () => {
    assert.equal(isAllowedCorsOrigin('https://localhost.attacker.example', undefined, undefined), false);
    assert.equal(isAllowedCorsOrigin('http://127.0.0.1.attacker.example', undefined, undefined), false);
    assert.equal(isAllowedCorsOrigin('http://localhost:8080/path', undefined, undefined), false);
    assert.equal(isAllowedCorsOrigin('not-an-origin', undefined, undefined), false);
});

test('proxy trust is deny-by-default and limited to configured addresses', () => {
    const defaultApp = express();
    defaultApp.set('trust proxy', trustedProxyAddresses(undefined));
    const defaultTrust = defaultApp.get('trust proxy fn') as (address: string, hopIndex: number) => boolean;
    assert.equal(defaultTrust('192.0.2.10', 0), false);

    const configuredApp = express();
    configuredApp.set('trust proxy', trustedProxyAddresses('192.0.2.10, 2001:db8::/32'));
    const configuredTrust = configuredApp.get('trust proxy fn') as (address: string, hopIndex: number) => boolean;
    assert.equal(configuredTrust('192.0.2.10', 0), true);
    assert.equal(configuredTrust('192.0.2.11', 0), false);
});

test('generic server failures do not expose internal error messages', () => {
    const response = getErrorResponse(new Error('database password or query details'));
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(response.body), JSON.stringify({
        error: 'Internal server error',
        message: 'Internal server error',
    }));
});

test('Multer failures retain their client-facing 400 response', () => {
    const multerError = new Error('private upload details');
    multerError.name = 'MulterError';
    const response = getErrorResponse(multerError);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'ملف الإثبات غير صالح أو يتجاوز الحد الأقصى 8MB');
});
