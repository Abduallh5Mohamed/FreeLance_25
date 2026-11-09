const fs=require('node:fs'),path=require('node:path');const {connect}=require('./demo-db.cjs');
(async()=>{const {c,pub,database}=await connect();try{
 const accounts=JSON.parse(fs.readFileSync(path.join(pub.privateDir,'accounts.json'),'utf8'));
 const names=['support_tickets','support_ticket_replies','support_ticket_private_notes','support_assignment_attempts','admin_user_roles','admin_role_permissions'];const placeholders=names.map(()=>'?').join(',');
 const [tables]=await c.execute('SELECT TABLE_NAME AS name,ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('+placeholders+')',names);
 const [columns]=await c.execute('SELECT TABLE_NAME AS tbl,COLUMN_NAME AS name,COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('+placeholders+') ORDER BY TABLE_NAME,ORDINAL_POSITION',names);
 const [indexes]=await c.execute('SELECT TABLE_NAME AS tbl,INDEX_NAME AS name,COLUMN_NAME AS col,SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('+placeholders+') ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX',names);
 const [roles]=await c.execute('SELECT ur.role_code,COUNT(*) AS n FROM admin_user_roles ur JOIN users u ON u.id=ur.user_id AND u.is_active=1 GROUP BY ur.role_code');
 fs.writeFileSync(path.join(__dirname,'build54-prerequisites.json'),JSON.stringify({database,tables,columns,indexes,roles},null,2));console.log(JSON.stringify({database,account_keys:accounts.map(x=>x.key),present:tables.map(x=>x.name),roles}));
 }finally{await c.end();}})().catch(e=>{console.error(e.code||'SUPPORT_INSPECT_FAILED');process.exitCode=1;});
