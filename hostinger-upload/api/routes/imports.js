"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const DATABASE_NAME = process.env.DB_NAME || 'freelance';
let importsSchemaEnsured = false;
const ensureImportsSchema = async () => {
    if (importsSchemaEnsured) {
        return;
    }
    // Drop existing table to recreate with new logic
    await (0, db_1.execute)(`DROP TABLE IF EXISTS import_items`);
    await (0, db_1.execute)(`DROP TABLE IF EXISTS imports`);
    // Create imports table
    await (0, db_1.execute)(`
        CREATE TABLE IF NOT EXISTS imports (
            id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
            supplier_name VARCHAR(255) NOT NULL,
            supplier_phone VARCHAR(50),
            import_date DATE NOT NULL,
            payment_method VARCHAR(50),
            total_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
            paid_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
            remaining_amount DECIMAL(10, 2) GENERATED ALWAYS AS (
                CASE 
                    WHEN total_amount = 0 THEN paid_amount
                    ELSE total_amount - paid_amount
                END
            ) STORED,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_import_date (import_date),
            INDEX idx_supplier_name (supplier_name)
        ) ENGINE=InnoDB;
    `);
    // Create import_items table
    await (0, db_1.execute)(`
        CREATE TABLE IF NOT EXISTS import_items (
            id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
            import_id CHAR(36) NOT NULL,
            item_code VARCHAR(100),
            item_name VARCHAR(255) NOT NULL,
            quantity INT NOT NULL,
            unit_price DECIMAL(10, 2) NOT NULL,
            total_price DECIMAL(10, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
            INDEX idx_import_id (import_id)
        ) ENGINE=InnoDB;
    `);
    importsSchemaEnsured = true;
};
const router = (0, express_1.Router)();
// Get all imports with their items
router.get('/', async (req, res) => {
    try {
        await ensureImportsSchema();
        const imports = await (0, db_1.query)('SELECT * FROM imports ORDER BY created_at DESC');
        // Fetch items for each import
        const importsWithItems = await Promise.all(imports.map(async (imp) => {
            const items = await (0, db_1.query)('SELECT * FROM import_items WHERE import_id = ?', [imp.id]);
            return { ...imp, items };
        }));
        res.json(importsWithItems);
    }
    catch (error) {
        console.error('Get imports error:', error);
        res.status(500).json({ error: 'Failed to fetch imports' });
    }
});
// Get import by ID
router.get('/:id', async (req, res) => {
    try {
        const importData = await (0, db_1.queryOne)('SELECT * FROM imports WHERE id = ?', [req.params.id]);
        if (!importData) {
            return res.status(404).json({ error: 'Import not found' });
        }
        const items = await (0, db_1.query)('SELECT * FROM import_items WHERE import_id = ?', [req.params.id]);
        res.json({ ...importData, items });
    }
    catch (error) {
        console.error('Get import error:', error);
        res.status(500).json({ error: 'Failed to fetch import' });
    }
});
// Create new import
router.post('/', async (req, res) => {
    try {
        await ensureImportsSchema();
        const { supplier_name, supplier_phone, import_date, payment_method, total_amount, paid_amount, notes, items } = req.body;
        if (!supplier_name || !import_date) {
            return res.status(400).json({ error: 'Supplier name and import date are required' });
        }
        // Generate UUID for import
        const importId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        // Insert import record with explicit ID
        await (0, db_1.execute)(`INSERT INTO imports (id, supplier_name, supplier_phone, import_date, payment_method, total_amount, paid_amount, notes) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [importId, supplier_name, supplier_phone || null, import_date, payment_method || 'cash', total_amount || 0, paid_amount || 0, notes || null]);
        // Insert import items (only if items exist)
        if (items && Array.isArray(items) && items.length > 0) {
            for (const item of items) {
                if (item.item_name) {
                    const itemId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                    await (0, db_1.execute)(`INSERT INTO import_items (id, import_id, item_code, item_name, quantity, unit_price) 
                         VALUES (?, ?, ?, ?, ?, ?)`, [itemId, importId, item.item_code || null, item.item_name, item.quantity || 1, item.unit_price || 0]);
                }
            }
        }
        // Fetch the created import with items
        const newImport = await (0, db_1.queryOne)('SELECT * FROM imports WHERE id = ?', [importId]);
        const importItems = await (0, db_1.query)('SELECT * FROM import_items WHERE import_id = ?', [importId]);
        res.status(201).json({ ...newImport, items: importItems });
    }
    catch (error) {
        console.error('Create import error:', error);
        res.status(500).json({ error: 'Failed to create import' });
    }
});
// Update import
router.put('/:id', async (req, res) => {
    try {
        const { supplier_name, supplier_phone, import_date, payment_method, total_amount, paid_amount, notes } = req.body;
        const updates = [];
        const values = [];
        if (supplier_name !== undefined) {
            updates.push('supplier_name = ?');
            values.push(supplier_name);
        }
        if (supplier_phone !== undefined) {
            updates.push('supplier_phone = ?');
            values.push(supplier_phone);
        }
        if (import_date !== undefined) {
            updates.push('import_date = ?');
            values.push(import_date);
        }
        if (payment_method !== undefined) {
            updates.push('payment_method = ?');
            values.push(payment_method);
        }
        if (total_amount !== undefined) {
            updates.push('total_amount = ?');
            values.push(total_amount);
        }
        if (paid_amount !== undefined) {
            updates.push('paid_amount = ?');
            values.push(paid_amount);
        }
        if (notes !== undefined) {
            updates.push('notes = ?');
            values.push(notes);
        }
        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        values.push(req.params.id);
        await (0, db_1.execute)(`UPDATE imports SET ${updates.join(', ')} WHERE id = ?`, values);
        const updatedImport = await (0, db_1.queryOne)('SELECT * FROM imports WHERE id = ?', [req.params.id]);
        if (!updatedImport) {
            return res.status(404).json({ error: 'Import not found' });
        }
        const items = await (0, db_1.query)('SELECT * FROM import_items WHERE import_id = ?', [req.params.id]);
        res.json({ ...updatedImport, items });
    }
    catch (error) {
        console.error('Update import error:', error);
        res.status(500).json({ error: 'Failed to update import' });
    }
});
// Delete import
router.delete('/:id', async (req, res) => {
    try {
        const result = await (0, db_1.execute)('DELETE FROM imports WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Import not found' });
        }
        res.json({ message: 'Import deleted successfully' });
    }
    catch (error) {
        console.error('Delete import error:', error);
        res.status(500).json({ error: 'Failed to delete import' });
    }
});
exports.default = router;
