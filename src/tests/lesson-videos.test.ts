import assert from 'node:assert/strict';
import test from 'node:test';
import {createLessonVideosController,parseLessonVideo,parseLessonVideos,parseVideoOptions} from '../features/catalog/lesson-videos';
import {ApiRequestError,listLessonVideos,listLessonVideoOptions,attachLessonVideo,detachLessonVideo,listLessonContents} from '../lib/api-http';
const id=(n:number)=>`b1000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const video=(n=1,display_order=n)=>({content_id:id(n+100),video_id:id(n),title:`Video ${n}`,video_status:'ready',display_order});
const option=(n=1)=>({video_id:id(n),title:`Video ${n}`});
const material=(n=1,display_order=0)=>({content_id:id(n+200),material_id:id(n+300),title:'Material',material_type:'pdf',display_order});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
  let principal='owner',changed=()=>{};const calls:any[]=[],rows:any[]=[],materials:any[]=[];
  const api={readPrincipal:()=>principal,subscribeSession:(listener:()=>void)=>{changed=listener;return()=>{changed=()=>{};};},
    list:async(_signal:AbortSignal):Promise<any>=>{calls.push('list');return {videos:[...rows]};},materials:async(_signal:AbortSignal):Promise<any>=>{calls.push('materials');return {contents:[...materials]};},
    options:async(cursor:string|null,_signal:AbortSignal):Promise<any>=>{calls.push({options:cursor});return {videos:[option()],next_cursor:null};},
    attach:async(input:{video_id:string;display_order:number},_signal:AbortSignal):Promise<any>=>{calls.push({attach:input});const content={...video(),...input};rows.push(content);return {content,unchanged:false};},
    detach:async(key:string,_signal:AbortSignal):Promise<any>=>{calls.push({detach:key});rows.splice(rows.findIndex(row=>row.content_id===key),1);return {detached:true,content_id:key};},
  };
  return {api,calls,rows,materials,controller:createLessonVideosController(api),identity:(value:string)=>{principal=value;},change:()=>changed()};
}
test('video DTOs reject locators, foreign shape, duplicate/order conflicts and unavailable titles',()=>{
  assert.equal(parseLessonVideo({...video(),title:null,video_status:'unavailable'}).title,null);
  for(const value of [{...video(),url:'private'},{...video(),video_id:'bad'},{...video(),display_order:'1'},{...video(),video_status:'unavailable'}, {...video(),video_status:'ready',title:null}])assert.throws(()=>parseLessonVideo(value));
  assert.throws(()=>parseLessonVideos({videos:[video(),video()]}));assert.throws(()=>parseLessonVideos({videos:[video(2),video(1)]}));
  assert.throws(()=>parseVideoOptions({videos:[{...option(),provider:'private'}],next_cursor:null},null));assert.throws(()=>parseVideoOptions({videos:[option()],next_cursor:id(1)},null));
  assert.throws(()=>parseVideoOptions({videos:[option()],next_cursor:null},id(1)));
});
test('video panel controller is inert until opened and reads shared materials before enabling writes',async()=>{
  const h=fixture();assert.equal(h.calls.length,0);h.materials.push(material());await h.controller.refresh();assert.equal(h.controller.getState().phase,'ready');assert.equal(h.controller.getState().materials.length,1);assert.equal(h.controller.getState().options.length,1);
  assert.equal(await h.controller.attach(id(1),'0'),false);assert.ok(!h.calls.some(call=>call.attach));assert.equal(await h.controller.attach(id(1),'1'),true);assert.equal(h.controller.getState().videos.length,1);h.controller.dispose();
});
test('video submission is single flight; a confirmed attach and detach refresh without touching original media',async()=>{
  const h=fixture();await h.controller.refresh();const wait=deferred();h.api.attach=async input=>{h.calls.push({attach:input});return wait.promise;};
  const saving=h.controller.attach(id(1),'1');assert.equal(await h.controller.attach(id(1),'1'),false);h.rows.push(video());wait.resolve({content:video(),unchanged:false});assert.equal(await saving,true);assert.equal(h.calls.filter(call=>call.attach).length,1);
  assert.match(h.controller.getState().notice!,/لا يفعّل تشغيل الطالب/);assert.equal(await h.controller.detach(id(101)),true);assert.equal(h.rows.length,0);assert.match(h.controller.getState().notice!,/الفيديو الأصلي محفوظ/);h.controller.dispose();
});
test('confirmed write and failed list refresh are distinct and a later successful refresh clears obsolete failure copy',async()=>{
  const h=fixture();await h.controller.refresh();h.api.list=async()=>{throw Error('read unavailable');};assert.equal(await h.controller.attach(id(1),'1'),true);
  assert.equal(h.controller.getState().videos.length,0);assert.equal(h.controller.getState().stale,true);assert.match(h.controller.getState().notice!,/الحفظ مؤكد/);assert.equal(await h.controller.attach(id(1),'1'),false);assert.equal(h.calls.filter(call=>call.attach).length,1);
  h.api.list=async()=>({videos:[...h.rows]});await h.controller.refresh();assert.equal(h.controller.getState().stale,false);assert.match(h.controller.getState().notice!,/^تم تأكيد ربط/);assert.equal(h.controller.getState().error,null);h.controller.dispose();
});
test('unknown/malformed acknowledgement blocks further writes until explicit validated read with no automatic resend',async()=>{
  for(const malformed of [false,true]){
    const h=fixture();await h.controller.refresh();h.api.attach=async input=>{h.calls.push({attach:input});h.rows.push(video());if(malformed)return {content:{...video(),video_id:id(99)},unchanged:false};throw new ApiRequestError('Lost',500,'PERSISTENCE_UNCERTAIN');};
    assert.equal(await h.controller.attach(id(1),'1'),false);assert.match(h.controller.getState().error!,/غير مؤكدة/);assert.equal(await h.controller.attach(id(1),'1'),false);
    await h.controller.refresh();assert.equal(h.controller.getState().videos.length,1);assert.equal(h.calls.filter(call=>call.attach).length,1);assert.equal(h.controller.getState().notice,null);h.controller.dispose();
  }
});
test('numeric validation, source membership and combined twenty-content ceiling reject before a request',async()=>{
  const h=fixture();await h.controller.refresh();for(const raw of ['12abc','1.2','NaN','Infinity','1e2','0x10','-1','2147483648',''])assert.equal(await h.controller.attach(id(1),raw),false);
  assert.equal(await h.controller.attach(id(99),'1'),false);assert.ok(!h.calls.some(call=>call.attach));h.materials.push(...Array.from({length:20},(_,n)=>material(n,n)));await h.controller.refresh();assert.equal(await h.controller.attach(id(1),'20'),false);assert.ok(!h.calls.some(call=>call.attach));h.controller.dispose();
});
test('inconsistent mixed snapshot and unavailable schema fail closed without pretending the lesson is empty',async()=>{
  const h=fixture();h.rows.push(video());h.materials.push(material(1,1));await h.controller.refresh();assert.equal(h.controller.getState().phase,'error');assert.equal(h.controller.getState().videos.length,0);assert.equal(await h.controller.attach(id(1),'2'),false);h.controller.dispose();
  const missing=fixture();missing.api.list=async()=>{throw new ApiRequestError('Unavailable',503,'LESSON_VIDEOS_UNAVAILABLE');};await missing.controller.refresh();assert.equal(missing.controller.getState().phase,'unavailable');assert.ok(missing.controller.getState().error);assert.equal(missing.controller.getState().videos.length,0);missing.controller.dispose();
});
test('option paging is explicit, bounded and failed page clears choices without claiming no sources exist',async()=>{
  const h=fixture(),first=Array.from({length:25},(_,n)=>option(n+1)),wait=deferred();let pages=0;
  h.api.options=async cursor=>{pages++;return cursor?wait.promise:{videos:first,next_cursor:id(25)};};await h.controller.refresh();const next=h.controller.options(true);await h.controller.options(true);assert.equal(pages,2);
  wait.resolve({videos:[option(26)],next_cursor:null});await next;assert.equal(h.controller.getState().options[0].video_id,id(26));
  h.api.options=async()=>{throw Error('options outage');};await h.controller.options();assert.equal(h.controller.getState().phase,'ready');assert.equal(h.controller.getState().options.length,0);assert.ok(h.controller.getState().optionsError);assert.equal(await h.controller.attach(id(26),'1'),false);h.controller.dispose();
});
for(const fence of ['identity','event','dispose'] as const)test(`video reads cannot apply after ${fence}`,async()=>{
  const h=fixture(),wait=deferred();let signal:AbortSignal|undefined;h.api.list=async cancel=>{signal=cancel;return wait.promise;};const reading=h.controller.refresh();
  if(fence==='identity')h.identity('other');else if(fence==='event')h.change();else h.controller.dispose();wait.resolve({videos:[video()]});await reading;
  assert.equal(h.controller.getState().videos.length,0);assert.equal(signal?.aborted,true);h.controller.dispose();
});
for(const fence of ['identity','event','dispose'] as const)test(`video writes cannot confirm after ${fence}`,async()=>{
  const h=fixture(),wait=deferred();await h.controller.refresh();h.api.attach=async()=>wait.promise;const saving=h.controller.attach(id(1),'1');
  if(fence==='identity')h.identity('other');else if(fence==='event')h.change();else h.controller.dispose();wait.resolve({content:video(),unchanged:false});assert.equal(await saving,false);assert.equal(h.controller.getState().videos.length,0);assert.equal(h.controller.getState().notice,null);h.controller.dispose();
});
test('permission loss clears private rows/options; unavailable sources can still be explicitly detached',async()=>{
  const h=fixture();h.rows.push({...video(),title:null,video_status:'unavailable'});await h.controller.refresh();assert.equal(await h.controller.detach(id(101)),true);
  h.api.list=async()=>{throw new ApiRequestError('Denied',403);};await h.controller.refresh();assert.equal(h.controller.getState().phase,'denied');assert.equal(h.controller.getState().videos.length,0);assert.equal(h.controller.getState().options.length,0);assert.equal(await h.controller.attach(id(1),'1'),false);h.controller.dispose();
});
test('canonical video APIs pin all target IDs and project only video/order with no-store bearer and abort signal',async()=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage,calls:any[]=[];(globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-token':null};
  globalThis.fetch=async(url:any,init:any)=>{calls.push({url,init});return new Response(JSON.stringify({}));};
  const cancel=new AbortController(),base=`/api/tenants/me/catalog/courses/${id(9)}/units/${id(8)}/lessons/${id(7)}`;
  try{await listLessonVideos(id(9),id(8),id(7),cancel.signal);await listLessonVideoOptions(id(9),id(8),id(7),id(25),cancel.signal);await attachLessonVideo(id(9),id(8),id(7),{video_id:id(1),display_order:3},cancel.signal);await detachLessonVideo(id(9),id(8),id(7),id(101),cancel.signal);await listLessonContents(id(9),id(8),id(7),cancel.signal);
    assert.deepEqual(calls.map(call=>call.url),[`${base}/videos`,`${base}/videos/available-videos?cursor=${id(25)}`,`${base}/videos`,`${base}/videos/${id(101)}`,`${base}/contents`]);assert.deepEqual(JSON.parse(calls[2].init.body),{video_id:id(1),display_order:3});assert.equal(calls[3].init.method,'DELETE');
    assert.ok(calls.every(call=>call.init.cache==='no-store'&&new Headers(call.init.headers).get('Authorization')==='Bearer synthetic-token'&&call.init.signal===cancel.signal));
  }finally{globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;}
});
