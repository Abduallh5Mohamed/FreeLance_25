const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  conn.exec(`mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT name, grade, grade_id FROM students LIMIT 10; SELECT id, name FROM grades LIMIT 10;"`, (err, stream) => {
    if (err) { console.error(err); conn.end(); return; }
    let out = '';
    stream.on('data', d => out += d.toString());
    stream.stderr.on('data', d => process.stderr.write(d));
    stream.on('close', () => {
      console.log(out);
      conn.end();
    });
  });
}).connect({
  host: '72.62.35.177',
  port: 22,
  username: 'root',
  password: 'NewSecureP@ssw0rd2025!'
});
