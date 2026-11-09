// Restricted helper for the owner's isolated synthetic local demo only.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
async function connect(){
 const pub=JSON.parse(fs.readFileSync(path.join(__dirname,'local-demo-public.json'),'utf8'));
 const config=JSON.parse(fs.readFileSync(path.join(pub.privateDir,'backend-runtime.json'),'utf8'));
 if(!/^tabweb_demo_\d{14}$/.test(config.DB_NAME)||config.DB_NAME!==pub.database||!['localhost','127.0.0.1','::1'].includes(config.DB_HOST))throw Error('DEMO_TARGET_REQUIRED');
 const mysql=require(path.join(root,'server/node_modules/mysql2/promise'));
 const c=await mysql.createConnection({host:config.DB_HOST,port:Number(config.DB_PORT),user:config.DB_USER,password:config.DB_PASSWORD,database:config.DB_NAME,multipleStatements:false});
 const [[row]]=await c.query('SELECT DATABASE() AS db,VERSION() AS version');
 if(row.db!==config.DB_NAME){await c.end();throw Error('DEMO_TARGET_REQUIRED');}
 return{c,root,pub,version:row.version,database:row.db};
}
module.exports={connect};
if(require.main===module)(async()=>{const {c,version,database}=await connect();try{
 const [columns]=await c.execute('SELECT TABLE_NAME AS name,COLUMN_NAME AS col,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,COLUMN_DEFAULT AS def FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
 const [indices]=await c.execute('SELECT TABLE_NAME AS name,INDEX_NAME AS idx,COLUMN_NAME AS col,SEQ_IN_INDEX AS seq,NON_UNIQUE AS non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX');
 fs.writeFileSync(path.join(__dirname,'build43-demo-catalog.json'),JSON.stringify({database,version,columns,indices},null,2));
 console.log(JSON.stringify({database,version,tables:new Set(columns.map(x=>x.name)).size,featureTables:[...new Set(columns.map(x=>x.name))].filter(x=>/exam_version|manual_|audit_|course_unit|course_lesson|return_plan|template/.test(x))}));
 }finally{await c.end();}})().catch(e=>{console.log(JSON.stringify({error:e.code||'DEMO_CATALOG_FAILED'}));process.exitCode=1;});
