const { Client } = require('ssh2');

const conn = new Client();
const password = process.argv[2] || 'NewSecureP@ssw0rd2025!';

conn.on('ready', () => {
    const cmds = [
        // Check registration-requests.js for the FK fix
        "echo '=== Check student_courses INSERT ==='",
        "grep -n 'student_courses' /var/www/alqaed-api/dist/routes/registration-requests.js",
        
        // Check if userId is used instead of studentId  
        "echo '=== Check userId vs studentId ==='",
        "grep -A2 'student_courses' /var/www/alqaed-api/dist/routes/registration-requests.js",
        
        // Check line 218
        "echo '=== Line 218 area ==='",
        "sed -n '210,230p' /var/www/alqaed-api/dist/routes/registration-requests.js",
        
        // Check index.html hash references
        "echo '=== index.html JS references ==='",
        "grep 'index-' /var/www/alqaed/dist/index.html",
        
        // Check nginx caching headers
        "echo '=== Nginx cache config ==='",
        "grep -A5 'cache' /etc/nginx/sites-enabled/alqaed 2>/dev/null || grep -A5 'cache' /etc/nginx/sites-available/alqaed 2>/dev/null || echo 'No cache config found in named sites'",
        "grep -A5 'cache' /etc/nginx/conf.d/alqaed*.conf 2>/dev/null || echo 'No cache config in conf.d'",
        
        // List nginx config files
        "echo '=== Nginx configs ==='",
        "ls /etc/nginx/sites-enabled/ 2>/dev/null",
        "ls /etc/nginx/conf.d/ 2>/dev/null",
    ].join(' && ');
    
    conn.exec(cmds, (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        let out = '';
        stream.on('data', d => out += d.toString());
        stream.stderr.on('data', () => {});
        stream.on('close', () => { console.log(out); conn.end(); });
    });
});

conn.connect({ host: '72.62.35.177', port: 22, username: 'root', password });
