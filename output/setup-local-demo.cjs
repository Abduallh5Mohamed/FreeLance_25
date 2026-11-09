// Explicitly authorized local demo setup. Never copies existing user data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const mysql=require(path.join(root,'server/node_modules/mysql2/promise'));
const dotenv=require(path.join(root,'server/node_modules/dotenv'));
const bcrypt=require(path.join(root,'server/node_modules/bcryptjs'));
async function main(){
 const e=dotenv.parse(fs.readFileSync(path.join(root,'server/.env')));
 if(!['localhost','127.0.0.1','::1'].includes(e.DB_HOST||'localhost'))throw Error('LOCAL_TARGET_REQUIRED');
 const name='tabweb_demo_'+new Date().toISOString().replace(/\D/g,'').slice(0,14);
 if(!/^tabweb_demo_\d{14}$/.test(name)||name===e.DB_NAME)throw Error('INVALID_DEMO_TARGET');
 const privateDir=process.argv[2];if(!privateDir||!path.isAbsolute(privateDir))throw Error('PRIVATE_DIRECTORY_REQUIRED');
 fs.mkdirSync(privateDir,{recursive:true});
 const cfg={host:e.DB_HOST||'localhost',port:Number(e.DB_PORT||3306),user:e.DB_USER||'root',password:e.DB_PASSWORD||'',connectTimeout:8000};
 const c=await mysql.createConnection(cfg);
 try{
  const [exists]=await c.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[name]);if(exists.length)throw Error('DEMO_TARGET_EXISTS');
  const [tables]=await c.execute("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",[e.DB_NAME]);
  await c.query('CREATE DATABASE `'+name+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await c.query('USE `'+name+'`');await c.query('SET FOREIGN_KEY_CHECKS=0');
  for(const t of tables){if(!/^[a-zA-Z0-9_]+$/.test(t.name))throw Error('INVALID_TABLE_NAME');
   const [ddl]=await c.query('SHOW CREATE TABLE `'+e.DB_NAME.replace(/`/g,'``')+'`.`'+t.name+'`');
   let sql=ddl[0]['Create Table'].replace(/AUTO_INCREMENT=\d+/g,'AUTO_INCREMENT=1');
   sql=sql.split('`'+e.DB_NAME+'`.').join('`'+name+'`.');
   await c.query(sql);
  }
  await c.query('SET FOREIGN_KEY_CHECKS=1');
  // Auth requires these enrollment fields. Changes are limited to the brand-new demo.
  const [studentCols]=await c.execute("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='students'",[name]);
  const additions={enrollment_status:"VARCHAR(20) NULL DEFAULT 'active'",enrollment_start_date:'DATETIME NULL',enrollment_end_date:'DATETIME NULL',term:'VARCHAR(50) NULL'};
  for(const [column,type] of Object.entries(additions))if(!studentCols.some(r=>r.name===column))await c.query('ALTER TABLE students ADD COLUMN `'+column+'` '+type);
  const [groupCols]=await c.execute("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='groups'",[name]);
  for(const [column,type] of Object.entries({branch_scope:"VARCHAR(16) NOT NULL DEFAULT 'tenant'",branch_id:'CHAR(36) NULL'}))if(!groupCols.some(r=>r.name===column))await c.query('ALTER TABLE `groups` ADD COLUMN `'+column+'` '+type);
  // This legacy installation still points course enrollment at users. Correct
  // the empty demo copy only, matching the current enrollment-ID contract.
  const [courseFks]=await c.execute("SELECT CONSTRAINT_NAME AS name,REFERENCED_TABLE_NAME AS parent FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME='student_courses' AND COLUMN_NAME='student_id' AND REFERENCED_TABLE_NAME IS NOT NULL",[name]);
  for(const fk of courseFks)if(fk.parent==='users'){
   if(!/^[a-zA-Z0-9_]+$/.test(fk.name))throw Error('INVALID_CONSTRAINT');
   await c.query('ALTER TABLE student_courses DROP FOREIGN KEY `'+fk.name+'`, ADD CONSTRAINT demo_student_course_enrollment_fk FOREIGN KEY(student_id) REFERENCES students(id)');
  }
  const accounts=[
   {key:'admin',role:'admin',name:'Demo Platform Admin',phone:'01000009001',route:'/admin'},
   {key:'teacher',role:'teacher',name:'Demo Teacher',phone:'01000009002',route:'/teacher'},
   {key:'instructor',role:'instructor',name:'Demo Instructor',phone:'01000009003',route:'/teacher'},
   {key:'staff',role:'staff',name:'Demo Staff',phone:'01000009004',route:'/teacher'},
   {key:'student',role:'student',name:'Demo Student',phone:'01000009005',route:'/student-spaces'},
  ].map(a=>({...a,id:crypto.randomUUID(),password:crypto.randomBytes(12).toString('base64url')+'A7!'}));
  const uid=key=>accounts.find(a=>a.key===key).id;
  await c.beginTransaction();
  try{
   for(const a of accounts){const hash=await bcrypt.hash(a.password,12);await c.execute('INSERT INTO users (id,name,phone,email,password_hash,role,is_active,email_verified,phone_verified,token_version) VALUES (?,?,?,?,?,?,1,1,1,0)',[a.id,a.name,'+20'+a.phone.slice(1),a.key+'@tabweb-demo.example.test',hash,a.role]);}
   // Copy only static role/permission definitions, never user-role bindings.
   for(const table of ['admin_roles','admin_role_permissions']){
    const projection=table==='admin_roles'?'code,name':'role_code,permission_key';
    const [rows]=await c.query('SELECT '+projection+' FROM `'+e.DB_NAME.replace(/`/g,'``')+'`.`'+table+'` LIMIT 1000');
    for(const row of rows){const keys=Object.keys(row);await c.execute('INSERT INTO `'+table+'` ('+keys.map(k=>'`'+k+'`').join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')',keys.map(k=>row[k]));}
   }
   const [superRole]=await c.execute('SELECT code FROM admin_roles WHERE code=?',['super_admin']);if(!superRole.length)await c.execute('INSERT INTO admin_roles (code,name) VALUES (?,?)',['super_admin','Demo Super Admin']);
   await c.execute('INSERT INTO admin_user_roles (user_id,role_code,assigned_by) VALUES (?,?,?)',[uid('admin'),'super_admin',uid('admin')]);
   const demoPermissions=['admin.dashboard.read','instructor.read','instructor.detail.read','task.read','subscription.read','approval.read','admin_roles.manage','finance.read','security.read','support.read'];
   for(const permission of demoPermissions)await c.execute('INSERT IGNORE INTO admin_role_permissions (role_code,permission_key) VALUES (?,?)',['super_admin',permission]);
   const teacherTenant=crypto.randomUUID(),instructorTenant=crypto.randomUUID();
   for(const [tenant,owner,label] of [[teacherTenant,uid('teacher'),'Demo Teacher Academy'],[instructorTenant,uid('instructor'),'Demo Instructor Academy']]){
    await c.execute("INSERT INTO tenants (id,owner_user_id,business_name,status,legacy_compat) VALUES (?,?,?,'active',1)",[tenant,owner,label]);
    await c.execute("INSERT INTO tenant_memberships (id,tenant_id,user_id,role_key,status) VALUES (?,?,?,'owner','active')",[crypto.randomUUID(),tenant,owner]);
   }
   await c.execute("INSERT INTO tenant_memberships (id,tenant_id,user_id,role_key,status) VALUES (?,?,?,'assistant','active')",[crypto.randomUUID(),teacherTenant,uid('staff')]);
   await c.execute("INSERT INTO staff (id,name,email,phone,role,is_active,accessible_pages) VALUES (?,?,?,?,'Demo assistant',1,?)",[uid('staff'),'Demo Staff','staff@tabweb-demo.example.test','+201000009004',JSON.stringify(['students','courses','groups','attendance','messages','reports'])]);
   const course=crypto.randomUUID(),group=crypto.randomUUID(),enrollment=crypto.randomUUID();
   await c.execute('INSERT INTO courses (id,tenant_id,instructor_id,name,is_active,price) VALUES (?,?,?,?,1,0)',[course,instructorTenant,uid('instructor'),'Demo Mathematics']);
   await c.execute('INSERT INTO `groups` (id,name,course_id,instructor_id,max_students,current_students,is_active) VALUES (?,?,?,?,30,1,1)',[group,'Demo Group',course,uid('instructor')]);
   await c.execute("INSERT INTO students (id,user_id,tenant_id,instructor_id,group_id,name,phone,is_active,is_offline,approval_status,enrollment_status) VALUES (?,?,?,?,?,?,?,1,0,'approved','active')",[enrollment,uid('student'),instructorTenant,uid('instructor'),group,'Demo Student','+201000009005']);
   await c.execute('UPDATE users SET student_id=? WHERE id=?',[enrollment,uid('student')]);
   await c.execute("INSERT INTO student_courses (id,student_id,course_id,status) VALUES (?,?,?,'active')",[crypto.randomUUID(),enrollment,course]);
   await c.commit();
  }catch(err){await c.rollback();throw err;}
  // Private artifacts are outside the shared workspace, never emitted to tools.
  const runtime={DB_HOST:cfg.host,DB_PORT:String(cfg.port),DB_USER:cfg.user,DB_PASSWORD:cfg.password,DB_NAME:name,JWT_SECRET:crypto.randomBytes(48).toString('hex'),SKIP_DB_ON_START:'true',PORT:'3001',MINIO_ENDPOINT:'127.0.0.1',MINIO_PORT:'65534',MINIO_USE_SSL:'false',MINIO_ACCESS_KEY:crypto.randomBytes(16).toString('hex'),MINIO_SECRET_KEY:crypto.randomBytes(32).toString('hex')};
  fs.writeFileSync(path.join(privateDir,'backend-runtime.json'),JSON.stringify(runtime),{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(privateDir,'accounts.json'),JSON.stringify(accounts),{mode:0o600,flag:'wx'});
  const lines=['TABWEB LOCAL DEMO LOGIN','http://localhost:8081/auth','Database: '+name,'Synthetic accounts only. Existing application data was not copied.',''];
  for(const a of accounts)lines.push(a.name+' ('+a.role+')','Phone: '+a.phone,'Password: '+a.password,'Page: http://localhost:8081'+a.route,'');
  fs.writeFileSync(path.join(privateDir,'LOGIN.txt'),lines.join('\r\n'),{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(root,'output/local-demo-public.json'),JSON.stringify({database:name,privateDir,accounts:accounts.map(({key,role,phone,route})=>({key,role,phone,route})),tablesCloned:tables.length},null,2));
  console.log(JSON.stringify({created:true,database:name,accounts:accounts.length,tablesCloned:tables.length,credentialFile:path.join(privateDir,'LOGIN.txt')}));
 }finally{await c.end();}
}
main().catch(e=>{console.log(JSON.stringify({error:e.code||'DEMO_SETUP_FAILED',table:e.sqlMessage?.match(/fails \(`[^`]+`\.`([^`]+)`/)?.[1],constraint:e.sqlMessage?.match(/CONSTRAINT `([^`]+)`/)?.[1]}));process.exitCode=1;});
