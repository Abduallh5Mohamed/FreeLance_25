const fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!/^tabweb_demo_\d{14}$/.test(config.DB_NAME)||!['localhost','127.0.0.1','::1'].includes(config.DB_HOST))throw Error('LOCAL_DEMO_REQUIRED');
Object.assign(process.env,config);process.chdir(path.join(root,'server'));
import(pathToFileURL(path.join(root,'server/src/index.ts')).href).catch(()=>{console.error('Local demo startup failed');process.exitCode=1;});
