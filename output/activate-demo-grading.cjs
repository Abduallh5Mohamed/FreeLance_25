// Owner requested actual local operation. This script cannot target source DB.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {connect}=require('./demo-db.cjs');
function statements(source){
 const result=[];let quote=null,line=false,block=false,part='';
 for(let i=0;i<source.length;i++){
  const ch=source[i],next=source[i+1];
  if(line){if(ch==='\n'){line=false;part+='\n';}continue;}
  if(block){if(ch==='*'&&next==='/'){block=false;i++;part+=' ';}continue;}
  if(quote){part+=ch;if(ch==='\\'&&next){part+=next;i++;}else if(ch===quote){if(next===quote){part+=next;i++;}else quote=null;}continue;}
  if(ch==='-'&&next==='-'&&/\s/.test(source[i+2]||'')){line=true;i++;continue;}
  if(ch==='#'){line=true;continue;}
  if(ch==='/'&&next==='*'){block=true;i++;continue;}
  if(["'",'"','`'].includes(ch)){quote=ch;part+=ch;continue;}
  if(ch===';'){if(part.trim())result.push(part.trim());part='';}else part+=ch;
 }
 if(quote||block)throw Error('INVALID_SQL_BOUNDARY');if(part.trim())result.push(part.trim());return result;
}
async function main(){
 const {c,root,pub,database}=await connect();const journalFile=path.join(__dirname,'build43-demo-migration-journal.json');
 try{
  const specs=[
   ['20261018_09_exam_snapshots_grading.sql',null,null],
   ['20261018_17_feature_flags_audit_chain.sql','SET @m7_has_audit_events =',null],
   ['20261018_22_audit_chain_sequence.sql',null,null],
   ['20261021_01_exam_manual_publication.sql',null,'SET @b2c_has_publications ='],
   ['20261018_10_gradebook_certificates.sql',null,'SET @has_cert ='],
   ['20261107_03_exam_manual_operations.sql',null,null],
  ];
  const sections=specs.map(([file,start,end])=>{
   let sql=fs.readFileSync(path.join(root,'server/migrations',file),'utf8');
   if(start){const i=sql.indexOf(start);if(i<0)throw Error('MISSING_SECTION');sql=sql.slice(i);}
   if(end){const i=sql.indexOf(end);if(i<0)throw Error('MISSING_SECTION');sql=sql.slice(0,i);}
   const items=statements(sql);if(items.some(s=>!/^(?:SET|SELECT|PREPARE|EXECUTE|DEALLOCATE|CREATE TABLE|CREATE INDEX)\b/i.test(s)))throw Error('UNREVIEWED_STATEMENT');
   return{file,start,end,hash:crypto.createHash('sha256').update(sql).digest('hex'),items};
  });
  let journal=fs.existsSync(journalFile)?JSON.parse(fs.readFileSync(journalFile,'utf8')):null;
  if(!journal){
   // A bounded private snapshot before DDL; no account rows leave private storage.
   const [tables]=await c.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");
   const backup={database,created_at:new Date().toISOString(),tables:[]};
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');await c.beginTransaction();
   try{for(const t of tables){if(!/^[a-zA-Z0-9_]+$/.test(t.name))throw Error('INVALID_TABLE');const [[ddl]]=await c.query('SHOW CREATE TABLE `'+t.name+'`');const [rows]=await c.query('SELECT * FROM `'+t.name+'` LIMIT 5001');if(rows.length>5000)throw Error('SNAPSHOT_CAP');backup.tables.push({name:t.name,ddl:ddl['Create Table'],rows});}await c.rollback();}catch(e){await c.rollback();throw e;}
   const backupFile=path.join(pub.privateDir,'before-build43-grading.json');fs.writeFileSync(backupFile,JSON.stringify(backup),{flag:'wx',mode:0o600});
   journal={database,created_at:new Date().toISOString(),backup:'private LocalDemo/before-build43-grading.json',sections:sections.map(s=>({file:s.file,start:s.start,end:s.end,hash:s.hash,completed:0,total:s.items.length}))};
   fs.writeFileSync(journalFile,JSON.stringify(journal,null,2),{flag:'wx'});
  }
  if(journal.database!==database||journal.sections.length!==sections.length)throw Error('JOURNAL_TARGET_MISMATCH');
  for(let n=0;n<sections.length;n++){
   const section=sections[n],progress=journal.sections[n];if(progress.hash!==section.hash||progress.file!==section.file)throw Error('MIGRATION_CHANGED');
   // Re-run only the explicitly idempotent prepared sections from the start to
   // restore their session variables. The new non-idempotent file resumes at
   // its recorded statement boundary; no DDL rollback claim is made.
   if(progress.completed===progress.total)continue;
   const start=section.file==='20261107_03_exam_manual_operations.sql'?progress.completed:0;
   for(let i=start;i<section.items.length;i++){
    try{await c.query(section.items[i]);}catch(e){console.log(JSON.stringify({migration:section.file,statement:i+1,error:e.code||'SQL_FAILED'}));throw Error('STOPPED_AT_DDL_BOUNDARY');}
    progress.completed=i+1;fs.writeFileSync(journalFile,JSON.stringify(journal,null,2));
   }
   console.log(JSON.stringify({migration:section.file,statements:section.items.length,applied:true,sectionOnly:!!section.start||!!section.end}));
  }
  journal.finished_at=new Date().toISOString();fs.writeFileSync(journalFile,JSON.stringify(journal,null,2));
  console.log(JSON.stringify({database,complete:true,scope:'local synthetic demo only'}));
 }finally{await c.end();}
}
module.exports={statements};
if(require.main===module)main().catch(e=>{console.log(JSON.stringify({error:e.code||e.message||'DEMO_ACTIVATION_FAILED'}));process.exitCode=1;});
