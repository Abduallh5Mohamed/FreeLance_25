import assert from 'node:assert/strict';
import test from 'node:test';
import {createCourseLessonsRouter} from '../src/routes/course-lessons';
import {makeReq,runChain,squash,withSilencedErrors} from './helpers/m2-course-lessons-harness';
const id=(n:number)=>`b1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const course=id(1),unit=id(2),lesson=id(3),video=id(4);
function fixture(){
  const s={owner:true,course:true,unit:true,lesson:true,schema:true,partial:false,engine:'InnoDB',indexes:true,sourcePrimary:true,reverseLecture:false,reverseMaterial:false,failAudit:false,failInsert:false,failCommit:false,
    videos:[{id:video,title:'Synthetic course video',course_id:course,tenant_id:'tenant',status:'ready',lecture_id:null as string|null,material_id:null as string|null,original_key:'private-source-key',hls_key:'private-hls-key'}],
    bindings:[] as any[],materials:[] as any[],audits:[] as any[],calls:[] as string[],events:[] as string[],acquired:0};
  let chain=Promise.resolve();
  const getConnection=async()=>{
    s.acquired++;let before:any,unlock=()=>{};
    return {beginTransaction:async()=>{const previous=chain;chain=new Promise(resolve=>{unlock=resolve;});await previous;before=structuredClone({bindings:s.bindings,audits:s.audits});s.events.push('begin');},
      execute:async(sql:string,p:any[]=[]):Promise<[any,any]>=>{
        const q=squash(sql);s.calls.push(q);
        if(q.includes("TABLE_NAME='videos'")&&q.includes('information_schema.STATISTICS'))return [s.sourcePrimary?[{column_name:'id',seq_in_index:1}]:[],[]];
        if(q.includes('FROM tenants t JOIN users'))return [[{owner_user_id:s.owner?'owner':'foreign',tenant_status:'active',caller_active:1}],[]];
        if(q.includes('FROM courses c'))return [s.course&&p[0]===course&&p[1]==='tenant'?[{id:course,tenant_id:'tenant'}]:[],[]];
        if(q.includes('FROM course_units u'))return [s.unit&&p[0]===unit&&p[1]===course?[{id:unit}]:[],[]];
        if(q.startsWith('SELECT l.id FROM course_lessons'))return [s.lesson&&p[0]===lesson&&p[1]===unit?[{id:lesson}]:[],[]];
        if(q.includes('information_schema.COLUMNS'))return [s.schema?(s.partial?['id']:['id','lesson_id','video_id','display_order']).map(column_name=>({column_name})):[],[]];
        if(q.includes('information_schema.TABLES'))return [['course_lesson_videos','videos','course_lesson_contents','course_lessons','course_units','courses','tenants','users','audit_events','lectures','course_materials'].map(table_name=>({table_name,engine:s.engine})),[]];
        if(q.includes('information_schema.STATISTICS'))return [s.indexes?['PRIMARY','uq_lesson_videos_source','uq_lesson_videos_order'].flatMap(index_name=>(index_name==='PRIMARY'?['id']:index_name==='uq_lesson_videos_source'?['lesson_id','video_id']:['lesson_id','display_order']).map((column_name,n)=>({index_name,column_name,seq_in_index:n+1,non_unique:0}))):[],[]];
        if(q.startsWith('SELECT id,video_id,display_order'))return [s.bindings.filter(row=>row.lesson_id===p[0]).sort((a,b)=>a.display_order-b.display_order).slice(0,21),[]];
        if(q.startsWith('SELECT id,display_order'))return [s.materials.filter(row=>row.lesson_id===p[0]).slice(0,21),[]];
        if(q.startsWith('SELECT v.id,v.title')){
          const selector=q.includes('ORDER BY v.id');
          assert.ok(q.includes("v.status='ready' AND v.lecture_id IS NULL AND v.material_id IS NULL")||selector&&q.includes("v.status='ready'"));
          if(selector){assert.ok(q.endsWith('LIMIT 26'));assert.ok(q.includes('NOT EXISTS (SELECT 1 FROM lectures'));assert.ok(q.includes('NOT EXISTS (SELECT 1 FROM course_materials'));}
          return [s.videos.filter(row=>row.course_id===p[selector?0:1]&&row.tenant_id===p[selector?1:2]&&row.status==='ready'&&row.lecture_id===null&&row.material_id===null
            &&(selector?row.id>p[2]:row.id.toLowerCase()===String(p[0]).toLowerCase())&&(!selector||!s.reverseLecture&&!s.reverseMaterial)).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,selector?26:1).map(({id,title})=>({id,title})),[]];
        }
        if(q.startsWith('SELECT id FROM lectures'))return [s.reverseLecture?[{id:id(88)}]:[],[]];
        if(q.startsWith('SELECT id FROM course_materials'))return [s.reverseMaterial?[{id:id(89)}]:[],[]];
        if(q.startsWith('SELECT b.id,b.video_id'))return [s.bindings.filter(row=>row.lesson_id===p[2]).sort((a,b)=>a.display_order-b.display_order).map(row=>{const v=s.videos.find(v=>v.id===row.video_id&&v.course_id===p[0]&&v.tenant_id===p[1]);return {...row,source_id:v?.id,title:v?.title,status:v?.status};}),[]];
        if(q.startsWith('INSERT INTO course_lesson_videos')){if(s.failInsert)throw Error('insert failed');s.bindings.push({id:p[0],lesson_id:p[1],video_id:p[2],display_order:p[3]});return [{affectedRows:1},[]];}
        if(q.startsWith('DELETE FROM course_lesson_videos')){const previous=s.bindings.length;s.bindings=s.bindings.filter(row=>!(row.id===p[0]&&row.lesson_id===p[1]));return [{affectedRows:previous-s.bindings.length},[]];}
        if(q.startsWith('INSERT INTO audit_events')){if(s.failAudit)throw Error('audit failed');s.audits.push(p);return [{affectedRows:1},[]];}
        throw Error('Unexpected synthetic SQL '+q);
      },commit:async()=>{s.events.push('commit');if(s.failCommit)throw Error('lost ack');},rollback:async()=>{s.events.push('rollback');Object.assign(s,before);},release:()=>{s.events.push('release');unlock();},destroy:()=>{s.events.push('destroy');unlock();},
    };
  };
  const router=createCourseLessonsRouter({getConnection});
  const request=async(method='GET',body:any={},suffix='',query:any={},user:any={id:'owner',tenantId:'tenant'})=>{
    const req:any=makeReq({method,pathName:`/courses/${course}/units/${unit}/lessons/${lesson}/videos${suffix}`,body,query});req.user=user;return runChain([router],req);
  };
  return {s,request};
}
test('video attach/repeat/list/detach use fixed private DTOs and preserve legacy sources and both progress ledgers',async()=>{
  const {s,request}=fixture(),original=structuredClone(s.videos);
  const first=await request('POST',{video_id:video,display_order:2});assert.equal(first.status,201);assert.equal(first.headers['Cache-Control'],'no-store');
  assert.equal((await request('POST',{video_id:video.toUpperCase(),display_order:2})).body.unchanged,true);assert.equal(s.audits.length,1);
  const list=await request();assert.deepEqual(list.body.videos,[{content_id:first.body.content.content_id,video_id:video,display_order:2,title:original[0].title,video_status:'ready'}]);
  assert.ok(!JSON.stringify(list.body).includes('private-'));assert.ok(!JSON.stringify(s.audits).includes(original[0].title));
  assert.equal((await request('DELETE',{},'/'+first.body.content.content_id)).status,200);assert.equal(s.bindings.length,0);assert.equal(s.audits.length,2);assert.deepEqual(s.videos,original);
  assert.ok(!s.calls.some(q=>q.startsWith('UPDATE videos')||q.includes('course_lesson_completions')||q.includes('student_progress')));
});
for(const gate of ['owner','course','unit','lesson','schema','partial','engine','indexes','sourcePrimary'] as const)test(`video ${gate} gate refuses writes`,async()=>{
  const {s,request}=fixture();if(gate==='partial')s.partial=true;else if(gate==='engine')s.engine='MyISAM';else s[gate]=false;
  const response=await request('POST',{video_id:video,display_order:0});assert.ok([403,404,503].includes(response.status));assert.equal(s.bindings.length,0);assert.equal(s.audits.length,0);assert.ok(!s.events.includes('commit'));
});
for(const cause of ['course','tenant','status','lecture','material','reverseLecture','reverseMaterial','missing'] as const)test(`video source ${cause} cannot be attached or discovered`,async()=>{
  const {s,request}=fixture();if(cause==='course')s.videos[0].course_id=id(99);if(cause==='tenant')s.videos[0].tenant_id='foreign';if(cause==='status')s.videos[0].status='processing';if(cause==='lecture')s.videos[0].lecture_id=id(88);if(cause==='material')s.videos[0].material_id=id(89);if(cause==='reverseLecture')s.reverseLecture=true;if(cause==='reverseMaterial')s.reverseMaterial=true;if(cause==='missing')s.videos=[];
  assert.equal((await request('POST',{video_id:video,display_order:0})).status,404);assert.deepEqual((await request('GET',{},'/available-videos')).body,{videos:[],next_cursor:null});assert.equal(s.audits.length,0);
});
test('video selector pages 25+1 and never accepts identity/tenant/provider selectors',async()=>{
  const {s,request}=fixture();for(let n=10;n<40;n++)s.videos.push({...s.videos[0],id:id(n)});
  const first=await request('GET',{},'/available-videos');assert.equal(first.body.videos.length,25);assert.equal(first.body.next_cursor,first.body.videos[24].video_id);
  assert.deepEqual(Object.keys(first.body.videos[0]),['video_id','title']);const second=await request('GET',{},'/available-videos',{cursor:first.body.next_cursor});assert.equal(second.body.videos.length,6);assert.equal(second.body.next_cursor,null);
  const before=s.acquired;for(const query of [{tenant_id:'foreign'},{cursor:['bad']},{cursor:'bad'},{provider:'anything'}])assert.equal((await request('GET',{},'/available-videos',query)).status,400);assert.equal(s.acquired,before);
});
test('video preparation shares material order/count, allows twenty total and rejects new conflicts without writes',async()=>{
  const {s,request}=fixture();s.materials=Array.from({length:19},(_,n)=>({id:id(100+n),lesson_id:lesson,display_order:n}));
  assert.equal((await request('POST',{video_id:video,display_order:0})).status,409);assert.equal(s.audits.length,0);
  assert.equal((await request('POST',{video_id:video,display_order:19})).status,201);
  s.videos.push({...s.videos[0],id:id(9)});assert.equal((await request('POST',{video_id:id(9),display_order:20})).status,409);assert.equal(s.audits.length,1);
  assert.equal((await request('POST',{video_id:video,display_order:18})).status,409);
  s.materials.push({id:id(199),lesson_id:lesson,display_order:19});assert.equal((await request()).status,409);
  assert.equal((await request('DELETE',{},'/'+s.bindings[0].id)).status,200);
});
test('concurrent duplicate video preparation creates one reference and one audit under the parent transaction',async()=>{
  const {s,request}=fixture();const responses=await Promise.all([request('POST',{video_id:video,display_order:0}),request('POST',{video_id:video,display_order:0})]);assert.deepEqual(responses.map(row=>row.status),[201,200]);assert.equal(s.bindings.length,1);assert.equal(s.audits.length,1);
});
test('withdrawn/foreign source names are withheld but an owner can detach the stale reference',async()=>{
  const {s,request}=fixture();const created=await request('POST',{video_id:video,display_order:0});s.videos[0].tenant_id='foreign';
  const read=await request();assert.equal(read.body.videos[0].title,null);assert.equal(read.body.videos[0].video_status,'unavailable');assert.equal((await request('POST',{video_id:video,display_order:0})).status,404);
  assert.equal((await request('DELETE',{},'/'+created.body.content.content_id)).status,200);assert.equal(s.videos.length,1);
});
for(const failure of ['failInsert','failAudit'] as const)test(`video ${failure} rolls back reference and audit`,async()=>withSilencedErrors(async()=>{
  const {s,request}=fixture();s[failure]=true;assert.equal((await request('POST',{video_id:video,display_order:0})).status,500);assert.equal(s.bindings.length,0);assert.equal(s.audits.length,0);
  s[failure]=false;await request('POST',{video_id:video,display_order:0});s.failAudit=true;assert.equal((await request('DELETE',{},'/'+s.bindings[0].id)).status,500);assert.equal(s.bindings.length,1);assert.equal(s.audits.length,1);
}));
test('video unknown commit is truthful, destroys connection and can be inspected without a second insert',async()=>withSilencedErrors(async()=>{
  const {s,request}=fixture();s.failCommit=true;const response=await request('POST',{video_id:video,display_order:0});assert.equal(response.body.code,'PERSISTENCE_UNCERTAIN');assert.deepEqual(s.events,['begin','commit','destroy']);
  s.failCommit=false;assert.equal((await request()).body.videos.length,1);assert.equal(s.audits.length,1);
}));
test('strict video bodies and billing/missing identity are refused before opening a connection',async()=>{
  const {s,request}=fixture();for(const body of [null,[],{}, {video_id:video,display_order:'0'},{video_id:video,display_order:-1},{video_id:video,display_order:1.23},{video_id:video,display_order:0,tenant_id:'foreign'},{video_asset_id:video,display_order:0}])assert.equal((await request('POST',body)).status,400);
  assert.equal((await request('GET',{},'',{},{id:'owner',tenantId:'tenant',billingOnly:true})).status,403);assert.equal((await request('GET',{},'',{},{})).status,404);assert.equal(s.acquired,0);
});
