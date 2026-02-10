const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

conn.on('ready', () => {
    console.log('Connected to server');
    
    const queries = `
        SELECT '=== CONVERSATIONS ===' as info;
        SELECT id, user1_id, user2_id, unread_count_user1, unread_count_user2, updated_at FROM conversations;
        
        SELECT '=== UNREAD MESSAGES (message_status) ===' as info;
        SELECT ms.message_id, m.sender_id, m.receiver_id, ms.is_read, ms.is_delivered, m.created_at 
        FROM message_status ms 
        JOIN messages m ON ms.message_id = m.id 
        WHERE ms.is_read = 0 
        LIMIT 20;
        
        SELECT '=== TOTAL MESSAGES ===' as info;
        SELECT COUNT(*) as total_messages FROM messages;
        
        SELECT '=== RECENT MESSAGES ===' as info;
        SELECT m.id, m.sender_id, m.receiver_id, m.content, m.message_type, m.created_at,
               ms.is_read, ms.is_delivered
        FROM messages m
        LEFT JOIN message_status ms ON m.id = ms.message_id
        ORDER BY m.created_at DESC
        LIMIT 15;
        
        SELECT '=== USERS ===' as info;
        SELECT id, name, role, phone FROM users;
    `;
    
    conn.exec(`mysql -u root -p'${password}' freelance -e "${queries}"`, (err, stream) => {
        if (err) { console.error('Exec error:', err); conn.end(); return; }
        
        let stdout = '';
        let stderr = '';
        
        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });
        
        stream.on('close', () => {
            if (stdout) console.log(stdout);
            if (stderr && !stderr.includes('Warning')) console.error('STDERR:', stderr);
            conn.end();
        });
    });
});

conn.on('error', (err) => {
    console.error('Connection error:', err.message);
});

conn.connect({
    host: '72.62.35.177',
    port: 22,
    username: 'root',
    password: password
});
