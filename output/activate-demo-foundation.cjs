// Exact additive prerequisites found by the real browser; demo target guarded.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {connect}=require('./demo-db.cjs'),{statements}=require('./activate-demo-grading.cjs');
async function main(){const {c,root,pub,database}=await connect();try{
 const journal={database,sections:[]};
 // Keep the pre-change grade table privately. Branch tables do not yet exist.
 const [[ddl]]=await c.query('SHOW CREATE TABLE grades');
 const [gradeRows]=await c.query('SELECT id,name,display_order,is_active,created_at,updated_at FROM grades LIMIT 5001');if(gradeRows.length>5000)throw Error('SNAPSHOT_CAP');
 const backup=path.join(pub.privateDir,'before-build43-foundation.json');if(!fs.existsSync(backup))fs.writeFileSync(backup,JSON.stringify({database,ddl:ddl['Create Table'],rows:gradeRows}),{flag:'wx',mode:0o600});
 for(const file of ['20261017_01_grades_tenant_scope.sql','20261017_06_branch_membership.sql']){const sql=fs.readFileSync(path.join(root,'server/migrations',file),'utf8');const items=statements(sql);if(items.some(s=>!/^(SET|PREPARE|EXECUTE|DEALLOCATE|SELECT)\b/.test(s)))throw Error('UNREVIEWED_SQL');for(let i=0;i<items.length;i++){try{await c.query(items[i]);}catch(e){console.log(JSON.stringify({file,statement:i+1,error:e.code||'SQL_FAILED'}));throw Error('DDL_FAILED');}}journal.sections.push({file,sha256:crypto.createHash('sha256').update(sql).digest('hex'),statements:items.length,complete:true});}
 journal.finished_at=new Date().toISOString();fs.writeFileSync(path.join(__dirname,'build43-foundation-migration-journal.json'),JSON.stringify(journal,null,2));console.log(JSON.stringify({database,applied:journal.sections.map(x=>x.file)}));
 }finally{await c.end();}}
main().catch(e=>{console.log(JSON.stringify({error:e.code||e.message||'DEMO_FOUNDATION_FAILED'}));process.exitCode=1;});
