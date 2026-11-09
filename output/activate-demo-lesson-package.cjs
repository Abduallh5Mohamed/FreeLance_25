const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {connect}=require('./demo-db.cjs'),{statements}=require('./activate-demo-grading.cjs');
async function main(){const {c,pub,root,database}=await connect();const journalFile=path.join(__dirname,'build45-demo-migration-journal.json');try{
 const specifications=[
  {file:'20261018_08_question_bank_assignments.sql',start:'SET @has_assignments =',end:'SET @has_submissions =',prefix:'SET @m4_db = DATABASE();\n'},
  {file:'20261103_01_course_lesson_contents.sql'},
  {file:'20261104_01_course_material_files.sql'},
  {file:'20261105_01_material_file_ingestion.sql'},
  {file:'20261106_01_course_lesson_videos.sql'},
  {file:'20261106_03_course_lesson_activities.sql'},
  {file:'20261023_02_group_announcements.sql'},
  {file:'20261106_07_course_lesson_announcements.sql'},
  {file:'20261106_09_course_lesson_package_operations.sql'},
  {file:'20260922_00_tenant_media_and_subscription_requests.sql',start:'ALTER TABLE videos ADD COLUMN tenant_id',end:'ALTER TABLE video_processing_queue'},
 ];
 const sections=specifications.map(spec=>{let sql=fs.readFileSync(path.join(root,'server/migrations',spec.file),'utf8');if(spec.start){const n=sql.indexOf(spec.start);if(n<0)throw Error('SECTION_MISSING');sql=sql.slice(n);}if(spec.end){const n=sql.indexOf(spec.end);if(n<0)throw Error('SECTION_MISSING');sql=sql.slice(0,n);}sql=(spec.prefix??'')+sql;const items=statements(sql);if(items.some(s=>!/^(SET|SELECT|PREPARE|EXECUTE|DEALLOCATE|CREATE TABLE|ALTER TABLE)\b/i.test(s)))throw Error('UNREVIEWED_STATEMENT');return{file:spec.file,start:spec.start??null,end:spec.end??null,items,hash:crypto.createHash('sha256').update(sql).digest('hex'),prepared:items.some(s=>s.startsWith('PREPARE'))};});
 let journal=fs.existsSync(journalFile)?JSON.parse(fs.readFileSync(journalFile,'utf8')):null;
 if(!journal){const [tables]=await c.execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME");if(tables.length>250)throw Error('SNAPSHOT_TABLE_CAP');const backup={database,created_at:new Date().toISOString(),tables:[]};await c.beginTransaction();try{for(const t of tables){if(!/^[a-zA-Z0-9_]+$/.test(t.name))throw Error('INVALID_TABLE');const [[ddl]]=await c.query('SHOW CREATE TABLE `'+t.name+'`');const [rows]=await c.query('SELECT * FROM `'+t.name+'` LIMIT 5001');if(rows.length>5000)throw Error('SNAPSHOT_ROW_CAP');backup.tables.push({name:t.name,ddl:ddl['Create Table'],rows});}await c.rollback();}catch(e){await c.rollback();throw e;}
 fs.writeFileSync(path.join(pub.privateDir,'before-build45-lesson-package.json'),JSON.stringify(backup),{flag:'wx',mode:0o600});journal={database,backup:'private LocalDemo/before-build45-lesson-package.json',sections:sections.map(s=>({file:s.file,start:s.start,end:s.end,hash:s.hash,completed:0,total:s.items.length}))};fs.writeFileSync(journalFile,JSON.stringify(journal,null,2),{flag:'wx'});}
 if(journal.database!==database||journal.sections.length!==sections.length)throw Error('JOURNAL_TARGET_MISMATCH');for(let n=0;n<sections.length;n++){const s=sections[n],p=journal.sections[n];if(p.hash!==s.hash||p.file!==s.file)throw Error('MIGRATION_CHANGED');if(p.completed===p.total)continue;for(let i=s.prepared?0:p.completed;i<s.items.length;i++){try{await c.query(s.items[i]);}catch(e){console.log(JSON.stringify({file:s.file,statement:i+1,error:e.code||'SQL_FAILED'}));throw Error('STOPPED_AT_DDL_BOUNDARY');}p.completed=i+1;fs.writeFileSync(journalFile,JSON.stringify(journal,null,2));}console.log(JSON.stringify({file:s.file,complete:true,sectionOnly:!!s.start||!!s.end}));}
 journal.finished_at=new Date().toISOString();fs.writeFileSync(journalFile,JSON.stringify(journal,null,2));
 const {lessonTemplateSchema}=require('../server/src/services/lesson-package-templates.ts');const {lessonVideoSchema}=require('../server/src/services/lesson-videos.ts');const {lessonActivitySchemaReady}=require('../server/src/services/lesson-activities.ts');const {lessonAnnouncementSchema}=require('../server/src/services/lesson-announcements.ts');
 const ready={templates:await lessonTemplateSchema(c),videos:await lessonVideoSchema(c),activities:await lessonActivitySchemaReady(c),announcements:await lessonAnnouncementSchema(c)};fs.writeFileSync(path.join(__dirname,'build45-schema-readiness.json'),JSON.stringify({database,ready},null,2));console.log(JSON.stringify({database,ready}));if(!ready.templates||ready.videos!=='ready'||!ready.activities||!ready.announcements)process.exitCode=1;
 }finally{await c.end();}}
main().catch(e=>{console.log(JSON.stringify({error:e.code||e.message||'DEMO_ACTIVATION_FAILED'}));process.exitCode=1;});
