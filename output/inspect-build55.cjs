const {connect}=require('./demo-db.cjs');
(async()=>{const {c}=await connect();try{for(const t of ['exams','exam_versions','exam_version_questions','exam_versioned_attempts','course_lesson_contents']){const [r]=await c.query('SHOW CREATE TABLE `'+t+'`');console.log(Object.values(r[0])[1]);}}finally{await c.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
