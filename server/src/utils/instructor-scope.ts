import { queryOne, execute } from '../db';

let groupColumnEnsured = false;

/**
 * Ensure `groups.instructor_id` exists (used to attribute groups to an
 * instructor). Safe to call repeatedly; no-op after the first success.
 */
export async function ensureGroupInstructorColumn(): Promise<void> {
    if (groupColumnEnsured) return;
    try {
        const col = await queryOne<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'groups' AND COLUMN_NAME = 'instructor_id'`
        );
        if (col && col.cnt === 0) {
            await execute(
                'ALTER TABLE `groups` ADD COLUMN instructor_id CHAR(36) DEFAULT NULL AFTER grade_id, ADD INDEX idx_group_instructor (instructor_id)'
            );
            console.log('✅ groups.instructor_id column added');
        }
        groupColumnEnsured = true;
    } catch (error) {
        console.error('⚠️ groups.instructor_id migration error (non-fatal):', error);
    }
}
