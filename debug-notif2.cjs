const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

conn.on('ready', () => {
    const queries = [
        "SELECT '--- CONV ---' as x",
        "SELECT id, LEFT(user1_id,8) as u1, LEFT(user2_id,8) as u2, unread_count_user1 as uc1, unread_count_user2 as uc2 FROM conversations",
        "SELECT '--- MSGS ---' as x",
        "SELECT m.id as mid, LEFT(m.sender_id,8) as sender, LEFT(m.receiver_id,8) as receiver, LEFT(m.content,20) as msg, ms.is_read, ms.is_delivered FROM messages m LEFT JOIN message_status ms ON m.id = ms.message_id ORDER BY m.created_at DESC",
        "SELECT '--- USERS ---' as x",
        "SELECT LEFT(id,8) as uid, name, role FROM users",
    ];
    
    conn.exec(`mysql -u root -p'${password}' freelance -e "${queries.join('; ')}"`, (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        let out = '';
        stream.on('data', d => out += d.toString());
        stream.stderr.on('data', () => {});
        stream.on('close', () => { console.log(out); conn.end(); });
    });
});

conn.connect({ host: '72.62.35.177', port: 22, username: 'root', password });
