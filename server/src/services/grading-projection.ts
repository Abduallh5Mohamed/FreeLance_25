import { toHundredths } from './exam-grading';
/** SQL DECIMAL projections may have scale4. Accept exact cents, never round. */
export function projectionHundredths(raw: unknown): number | null {
    if (typeof raw === 'string') {
        const match = /^(\d+)\.(\d{2})(\d{1,6})$/.exec(raw);
        if (match) {
            if (!/^0+$/.test(match[3]))
                return null;
            return toHundredths(match[1] + '.' + match[2]);
        }
    }
    return toHundredths(raw);
}
