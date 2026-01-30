const mysql = require('mysql2/promise');

async function main() {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'root',
        password: '123580',
        database: 'Freelance'
    });

    const [cols] = await conn.query('DESCRIBE lectures');
    console.log('Lectures table columns:');
    cols.forEach(c => console.log(`  ${c.Field} - ${c.Type} - ${c.Null}`));
    
    await conn.end();
}

main();
