const fs=require('node:fs');let p='server/src/routes/exam-manual-grading.ts',s=fs.readFileSync(p,'utf8');s=s.replace("        if(req.method==='POST'&&deps.readOnly){res.status(409).json({code:'GRADING_USE_QUESTION_WORKBENCH',error:'Use the scoped question grading workflow'});return;}\n",'');s=s.replaceAll('            if (!bundle) return;','            if (!bundle) return;\n            if(req.method===\'POST\'&&deps.readOnly)return res.status(409).json({code:\'GRADING_USE_QUESTION_WORKBENCH\',error:\'Use the scoped question grading workflow\'});');fs.writeFileSync(p,s);
p='server/tests/b2-production-wiring.test.ts';s=fs.readFileSync(p,'utf8');s=s.replace("sql.includes('WHERE c.tenant_id = ?')", "/WHERE c\\.tenant_id\\s*=\\s*\\?/.test(sql)");s=s.replace('course.id === exam.course_id && course.tenant_id === params[0]))','course.id === exam.course_id && course.tenant_id === params[0] && (!sql.includes(\'c.instructor_id=?\') || course.instructor_id === params[1])))');
let a=s.indexOf("test('owner answer grade:"),b=s.indexOf("test('unrelated teacher",a);if(a<0||b<0)throw Error('TEST_ANCHOR');s=s.slice(0,a)+`test('production compatibility grading rejects mutation and points to the scoped question workbench', async () => {
 const db=seedGradeFlow(),routers=build(db);
 const response=await invoke(appFor('/api/exam-manual-grading',routers.examManualGrading),{method:'POST',url:'/api/exam-manual-grading/attempts/a1/answers/q1/grade',body:{points:5}});
 assert.equal(response.statusCode,409);assert.equal((response.body as any).code,'GRADING_USE_QUESTION_WORKBENCH');
 assert.equal(db.state.revisions.length,0);assert.equal(db.state.auditEvents.length,0);assert.equal(Number(db.state.attempts[0].version),3);
});

`+s.slice(b);
a=s.indexOf("test('manual grading authority: owner, course instructor"),b=s.indexOf("test('audit failure on finalize",a);if(a<0||b<0)throw Error('SCOPE_TEST_ANCHOR');s=s.slice(0,a)+`test('production compatibility reads require actual course responsibility; owner/group alone are not grading grants', async()=>{
 for(const kind of ['owner','course','group'] as const){const db=seedAuthorityState(kind),routers=build(db,{authenticate:authAs({id:'teacher1',role:'teacher',tenantId:'t1'})}),app=appFor('/api/exam-manual-grading',routers.examManualGrading);
 const pending=await invoke(app,{method:'GET',url:'/api/exam-manual-grading/pending'});assert.equal(pending.statusCode,200);assert.equal((pending.body as any).count,kind==='course'?1:0);
 const detail=await invoke(app,{method:'GET',url:'/api/exam-manual-grading/attempts/a1'});assert.equal(detail.statusCode,kind==='course'?200:403);
 for(const suffix of ['answers/q1/grade','finalize']){const r=await invoke(app,{method:'POST',url:'/api/exam-manual-grading/attempts/a1/'+suffix,body:{points:5}});assert.equal(r.statusCode,kind==='course'?409:403);}
 assert.equal(db.state.auditEvents.length,0);
 }
});

`+s.slice(b);
s=s.replace("test('audit failure on finalize rolls the state change back and returns a generic error'", "test('production compatibility finalize cannot bypass the scoped workflow even with an audit writer'");s=s.replace("assert.equal(response.statusCode, 500);\n    assert.deepEqual(response.body, { error: 'Failed to finalize attempt' });", "assert.equal(response.statusCode, 409);\n    assert.equal((response.body as any).code,'GRADING_USE_QUESTION_WORKBENCH');");s=s.replace("assert.equal(db.rollbacks, 1);\n});\n\ntest('publish and unpublish", "assert.equal(db.rollbacks, 0);\n});\n\ntest('publish and unpublish");fs.writeFileSync(p,s);
