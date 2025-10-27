#!/usr/bin/env node
// Script to update all pages to use MySQL API instead of Supabase

const fs = require('fs');
const path = require('path');

const pagesDir = path.join(__dirname, '../src/pages');

// Get all TypeScript files in pages directory
const files = fs.readdirSync(pagesDir).filter(f => f.endsWith('.tsx'));

console.log(`Found ${files.length} page files`);

files.forEach(file => {
    const filePath = path.join(pagesDir, file);
    let content = fs.readFileSync(filePath, 'utf8');

    // Skip if already updated or doesn't use supabase
    if (!content.includes('from "@/integrations/supabase/client"')) {
        console.log(`✓ ${file} - Already updated or doesn't use Supabase`);
        return;
    }

    console.log(`Updating ${file}...`);

    // Replace supabase import with API imports
    content = content.replace(
        /import { supabase } from "@\/integrations\/supabase\/client";/g,
        '// Using MySQL API - Supabase replaced\n// import { supabase } from "@/integrations/supabase/client";'
    );

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ ${file} - Import commented out`);
});

console.log('\nDone! Review the changes and update each file to use the API functions.');
