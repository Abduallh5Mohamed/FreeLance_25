const fs=require('node:fs'),path=require('node:path'),{connect}=require('./demo-db.cjs');
(async()=>{const{c,pub,database}=await connect();try{
 const file='output/dev-session-20261107-1815.json',state=JSON.parse(fs.readFileSync(file,'utf8'));if(state.backend.database!==database)throw Error('DEMO_STATE_MISMATCH');
 state.updated_at=new Date().toISOString();state.backend={...state.backend,pid:9660,url:'http://localhost:3001'};state.frontend={...state.frontend,pid:7000,url:'http://localhost:8081'};
 state.teacher_workspace={url:'http://localhost:8081/teacher-workspace',authority:'live_responsible_course_teacher',institution_ownership_is_teaching_grant:false,read_only_saved_plan_follow_up:true,completion_source:'independent_catalog_record_only',season_reuse:'educational_institution_owner_only',production_accepted:false};
 fs.writeFileSync(file,JSON.stringify(state,null,2));
 const root=path.resolve(pub.privateDir),temporary=path.resolve(root,'build61-test-sessions.json');if(path.dirname(temporary)!==root||path.basename(temporary)!=='build61-test-sessions.json')throw Error('PRIVATE_TARGET_MISMATCH');if(fs.existsSync(temporary))fs.unlinkSync(temporary);
 console.log(JSON.stringify({runtime_record_updated:true,temporary_sessions_removed:!fs.existsSync(temporary),credentials_changed:false,product_probe_changes:0,database}));
}finally{await c.end();}})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
