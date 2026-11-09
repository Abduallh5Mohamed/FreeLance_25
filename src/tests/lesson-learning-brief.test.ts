import test from 'node:test';
import assert from 'node:assert/strict';
import {createLessonLearning,initialLearning,learningBrief,type LessonLearning} from '../features/catalog/lesson-learning';
const id=(n:number)=>`b4800000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const data=():LessonLearning=>({context:{course_id:id(1),lesson_id:id(2),group_id:id(3),from:'2026-11-01T00:00:00.000Z',to:'2026-11-08T00:00:00.000Z'},checked_at:'2026-11-08T00:00:00.000Z',group_name:'Synthetic group',rule_version:'automatic-tags-v1',reason:null,state:'available',graded_attempts:5,automatic_questions:1,unmapped_questions:0,excluded_manual_questions:0,suggestions:[{tag:'Fractions',responses:5,not_fully_correct:4,question_count:1,evidence:[{question_ref:id(9),position:1,text:'PRIVATE QUESTION STEM',responses:5,not_correct:4}]}]});
function fixture(){let state=initialLearning(),principal='A',event=()=>{};const s={calls:[] as string[],copy:async(text:string)=>{s.calls.push(text);}};const c=createLessonLearning({groups:async()=>({groups:[{id:id(3),name:'Synthetic group'}],nextCursor:null}),read:async()=>data(),readPrincipal:()=>principal,subscribeSession:fn=>{event=fn;return()=>{};},copyText:text=>s.copy(text)});c.subscribe(x=>state=x);return{c,s,state:()=>state,replace:()=>{principal='B';},event:()=>event(),prepare:async()=>{await c.first();c.change(id(3),data().context.from,data().context.to);await c.read();c.decide('Fractions','use');}};}
test('brief contains only explicit used tags/current group/window/counts, never question text or identities',()=>{
 const d=data();assert.throws(()=>learningBrief(d,{}));assert.throws(()=>learningBrief({...d,state:'insufficient'}, {Fractions:'use'}));const text=learningBrief(d,{Fractions:'use',unknown:'use'});assert.match(text,/Fractions: 4 من 5/);assert.match(text,/Synthetic group/);assert.match(text,/2026-11-01/);assert.match(text,/ليست قياسًا/);assert.doesNotMatch(text,/PRIVATE|b4800000|unknown|question_ref/);
});
test('explicit copy succeeds, failed clipboard is not success and selection/window updates clear its status',async()=>{
 const h=fixture();await h.c.copy();assert.equal(h.s.calls.length,0);await h.prepare();await h.c.copy();assert.equal(h.s.calls.length,1);assert.equal(h.state().copyPhase,'copied');h.c.decide('Fractions','dismiss');assert.equal(h.state().copyPhase,'idle');h.c.decide('Fractions','use');h.s.copy=async()=>{throw Error('permission denied');};await h.c.copy();assert.equal(h.state().copyPhase,'error');assert.ok(h.state().data);h.c.change(id(3),'','');assert.equal(h.state().data,null);assert.equal(h.state().copyPhase,'idle');h.c.dispose();
});
for(const change of ['principal','event','selection','dispose'])test(`copy single-flight and late acknowledgement fenced after ${change}`,async()=>{
 const h=fixture();await h.prepare();let resolve!:()=>void;h.s.copy=async text=>{h.s.calls.push(text);await new Promise<void>(r=>resolve=r);};const pending=h.c.copy();await h.c.copy();assert.equal(h.s.calls.length,1);
 if(change==='principal')h.replace();if(change==='event')h.event();if(change==='selection')h.c.decide('Fractions','dismiss');if(change==='dispose')h.c.dispose();resolve();await pending;if(change!=='dispose')assert.notEqual(h.state().copyPhase,'copied');h.c.dispose();
});
test('clipboard deadline does not claim success from a late result',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=fixture();await h.prepare();let resolve!:()=>void;h.s.copy=()=>new Promise<void>(r=>resolve=r);const pending=h.c.copy();t.mock.timers.tick(10000);assert.equal(h.state().copyPhase,'error');resolve();await pending;assert.equal(h.state().copyPhase,'error');h.c.dispose();
});
