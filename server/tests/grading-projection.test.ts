import test from 'node:test';
import assert from 'node:assert/strict';
import { projectionHundredths } from '../src/services/grading-projection';
test('SQL scale4 zero padding is exact, not a changed gradebook amount', () => { assert.equal(projectionHundredths('8.0000'), 800); assert.equal(projectionHundredths('10.0000'), 1000); assert.equal(projectionHundredths('0.1000'), 10); assert.equal(projectionHundredths('100'), 10000); });
test('projection comparison never rounds non-cent stored values or malformed strings', () => { for (const v of ['8.0001', '1.2340', '1e2', 'NaN', 'Infinity', '-1', '12abc'])
    assert.equal(projectionHundredths(v), null); });
