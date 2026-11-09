"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.catalogReadLimitParams = catalogReadLimitParams;
exports.withCatalogReadLimits = withCatalogReadLimits;
exports.withMysqlReadLimitBindings = withMysqlReadLimitBindings;
/**
 * mysql2 sends JS numbers as DOUBLE; MySQL 8 rejects that parameter type for
 * prepared LIMIT/OFFSET. Keep SQL parameterized and normalize only positional
 * integer parameters of a terminal SELECT limit. Never touch write values,
 * identity selectors, SQL text or quoted/commented question marks.
 */
function catalogReadLimitParams(sql, params = []) {
    let mask = '', quote = null, line = false, block = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i], next = sql[i + 1];
        if (line) {
            mask += ch === '\n' ? '\n' : ' ';
            if (ch === '\n')
                line = false;
            continue;
        }
        if (block) {
            mask += ' ';
            if (ch === '*' && next === '/') {
                mask += ' ';
                i++;
                block = false;
            }
            continue;
        }
        if (quote) {
            mask += ' ';
            if (ch === '\\' && next) {
                mask += ' ';
                i++;
            }
            else if (ch === quote) {
                if (next === quote) {
                    mask += ' ';
                    i++;
                }
                else
                    quote = null;
            }
            continue;
        }
        if (ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? '')) {
            mask += '  ';
            i++;
            line = true;
            continue;
        }
        if (ch === '#') {
            mask += ' ';
            line = true;
            continue;
        }
        if (ch === '/' && next === '*') {
            mask += '  ';
            i++;
            block = true;
            continue;
        }
        if (["'", '"', '`'].includes(ch)) {
            quote = ch;
            mask += ' ';
            continue;
        }
        mask += ch;
    }
    const out = [...params];
    if (quote || block || !/^\s*SELECT\b/i.test(mask))
        return out;
    const match = /\bLIMIT\s+\?(?:\s*,\s*\?|\s+OFFSET\s+\?)?\s*(?:FOR\s+UPDATE)?\s*;?\s*$/i.exec(mask);
    if (!match)
        return out;
    const positions = [...mask.matchAll(/\?/g)].map(m => m.index);
    for (let n = 0; n < positions.length; n++)
        if (positions[n] >= match.index) {
            const value = out[n];
            if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647)
                out[n] = String(value);
        }
    return out;
}
/** Narrow connection facade used only by mounted unit/lesson catalogs. */
function withCatalogReadLimits(c) {
    return {
        execute: (sql, params) => c.execute(sql, catalogReadLimitParams(sql, params)),
        beginTransaction: () => c.beginTransaction(), commit: () => c.commit(), rollback: () => c.rollback(),
        release: () => c.release(), destroy: () => c.destroy(),
    };
}
/** Install once at the native promise-driver boundary, including pool reads.
 * All other methods retain their original receiver (not a connection clone).
 * Injected route/test connections are deliberately outside this adapter.
 */
function withMysqlReadLimitBindings(driver) {
    return new Proxy(driver, { get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === 'execute' && typeof value === 'function')
                return (sql, params, ...rest) => value.call(target, sql, typeof sql === 'string' && Array.isArray(params) ? catalogReadLimitParams(sql, params) : params, ...rest);
            if (key === 'getConnection' && typeof value === 'function')
                return async () => withMysqlReadLimitBindings(await value.call(target));
            return typeof value === 'function' ? value.bind(target) : value;
        } });
}
