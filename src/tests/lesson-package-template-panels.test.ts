import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = Module.createRequire(import.meta.url);
const id = (n:number) => `b3500000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const template = {id:id(10),name:'Private owner template',status:'active',head_revision:30};
const revision = (n:number) => ({revision_number:n,source_lesson_id:id(4),reference_count:1,media_count:1});
const deferred = () => {let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>resolve=r);return{promise,resolve};};
function find(node:any,predicate:(node:any)=>boolean):any {
  if(!node||typeof node!=='object')return null;if(predicate(node))return node;
  for(const child of [node.props?.children].flat(Infinity)){const found=find(child,predicate);if(found)return found;}return null;
}
const button=(tree:any,text:string)=>{const found=find(tree,n=>n.props?.children===text);assert.ok(found,`Missing control ${text}`);return found;};

// Execute actual components, effects and callbacks. Network stays at the real
// canonical transport boundary; no replacement product controller is injected.
function mount(name:string,props:any,page=false) {
  const React=require('react'),module=Module as any,original=module._load;
  const file=require.resolve(page?'../pages/Courses.tsx':'../features/catalog/LessonPackageTemplates.tsx');
  const hooks:any[]=[],effects:Function[]=[],cleanups:Function[]=[];let index=0,dirty=true,tree:any;
  const changed=(a:any[],b:any[])=>!a||!b||a.length!==b.length||a.some((x,i)=>x!==b[i]);
  let component:any;
  try {
    delete require.cache[file];module._load=function(request:string,parent:any,main:boolean){
      if(page && request==='@/components/ui/use-toast')return {useToast:()=>({toast:()=>{}})};
      if(page && request==='@/components/Header')return {__esModule:true,default:()=>null};
      if(page && request==='@/lib/api')return {getCourses:async()=>[{id:id(1),name:'course'}],getGrades:async()=>[],getSubscriptions:async()=>[]};
      if(request==='react'&&parent?.filename===file)return {...React,
        useState:(initial:any)=>{const i=index++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],(value:any)=>{const next=typeof value==='function'?value(hooks[i]):value;if(next!==hooks[i]){hooks[i]=next;dirty=true;}}];},
        useRef:(initial:any)=>{const i=index++;return hooks[i]??(hooks[i]={current:initial});},
        useCallback:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||changed(hooks[i].deps,deps))hooks[i]={deps,fn};return hooks[i].fn;},
        useEffect:(fn:Function,deps:any[])=>{const i=index++;if(!hooks[i]||changed(hooks[i],deps)){hooks[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}},
      };
      if(request.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);
      return original.call(this,request,parent,main);
    };component=require(file)[name];
  }finally{module._load=original;delete require.cache[file];}
  const render=()=>{index=0;dirty=false;tree=component(props);effects.splice(0).forEach(fn=>fn());return tree;};
  const settle=async()=>{for(let n=0;n<12;n++){if(dirty)render();await new Promise(r=>setImmediate(r));if(!dirty&&!effects.length)break;}return tree;};
  return {render,settle,tree:()=>tree,unmount:()=>cleanups.forEach(fn=>fn?.()),React};
}
async function environment(work:(state:{identity:string;storage:Function[]})=>Promise<void>) {
  const previous={fetch:globalThis.fetch,storage:globalThis.localStorage,session:globalThis.sessionStorage,window:globalThis.window,React:(globalThis as any).React};
  const state={identity:'owner-A',storage:[] as Function[]};
  const markers=new Map<string,string>();(globalThis as any).sessionStorage={getItem:(k:string)=>markers.get(k)??null,setItem:(k:string,v:string)=>{markers.set(k,v);},removeItem:(k:string)=>{markers.delete(k);}};
  (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic':key==='currentUser'?JSON.stringify({id:state.identity,role:'instructor'}):null};
  (globalThis as any).window={addEventListener:(kind:string,fn:Function)=>{if(kind==='storage')state.storage.push(fn);},removeEventListener:(kind:string,fn:Function)=>{if(kind==='storage')state.storage=state.storage.filter(x=>x!==fn);},confirm:()=>true};
  try{await work(state);}finally{globalThis.fetch=previous.fetch;(globalThis as any).localStorage=previous.storage;(globalThis as any).sessionStorage=previous.session;(globalThis as any).window=previous.window;(globalThis as any).React=previous.React;}
}

test('actual parent preserves uncertain child and guards create/revise/archive/refresh/page callbacks',async()=>environment(async()=>{
  const calls:string[]=[];globalThis.fetch=async url=>{calls.push(String(url));return new Response(JSON.stringify({templates:[template],next_cursor:'next'}));};
  const h=mount('LessonPackageTemplates',{courseId:id(1)});(globalThis as any).React=h.React;
  try {
    h.render();let tree=await h.settle();button(tree,'تطبيق على حصة').props.onClick();tree=await h.settle();
    const picker=find(tree,n=>n.type?.name==='LessonPackageSources');assert.ok(picker);
    const chosen=picker.props.renderSource({unitId:id(2),lessonId:id(3),title:'Private destination'},()=>{});
    button(chosen,'استخدام هذه الحصة كوجهة').props.onClick();tree=await h.settle();
    const child=find(tree,n=>n.type?.name==='TemplateApplication');assert.ok(child);child.props.onLockChange(true);tree=await h.settle();
    const count=calls.length;
    for(const text of ['حفظ قالب من حصة','إضافة مراجعة من مصدر','أرشفة','تحديث القوالب','الصفحة التالية']){const control=button(tree,text);assert.equal(control.props.disabled,true);control.props.onClick();}
    child.props.onClose();tree=await h.settle();assert.ok(find(tree,n=>n.type?.name==='TemplateApplication'));assert.equal(calls.length,count);
    child.props.onLockChange(false);tree=await h.settle();child.props.onClose();await h.settle();assert.equal(find(h.tree(),n=>n.type?.name==='TemplateApplication'),null);
  }finally{h.unmount();}
}));

test('actual application pages revisions explicitly, clears approval, locks close and recovers only by GET',async()=>environment(async()=>{
  const calls:any[]=[];let applied=0,lost=true;
  const context={template_id:template.id,revision_number:26,lesson_id:id(3)};
  globalThis.fetch=async (url,init)=>{
    calls.push({url:String(url),init});const body=init?.body?JSON.parse(String(init.body)):null;
    if(String(url).includes('/revisions?'))return new Response(JSON.stringify({revisions:String(url).includes('cursor=next')?[revision(26)]:[revision(1)],next_cursor:String(url).includes('cursor=next')?null:'next'}));
    if(String(url).endsWith('lesson-template-review'))return new Response(JSON.stringify({context:{...context,revision_number:body.revision_number},review_token:'a'.repeat(64),can_apply:true,items:[{kind:'material',source_id:id(20),title:'material',display_order:0,audience:'course',source_state:'published',outcome:'add',conflict:null}],projected_media_count:1,timing:{mode:'keep',current_release_at:null,proposed_release_at:null}}));
    if(String(url).endsWith('lesson-template-apply')){applied++;if(lost)throw Error('Lost ACK');}
    return new Response(JSON.stringify({operation:{context,operation_id:body?.operation_id??JSON.parse(String(calls.find(c=>c.url.endsWith('lesson-template-apply')).init.body)).operation_id,created:1,existing:0,timing:{mode:'keep',release_at:null}}}));
  };
  let closed=0;const locks:boolean[]=[];const h=mount('TemplateApplication',{courseId:id(1),destination:{unitId:id(2),lessonId:id(3),title:'Destination'},templates:[template],onClose:()=>closed++,onLockChange:(value:boolean)=>locks.push(value)});(globalThis as any).React=h.React;
  try {
    h.render();let tree=await h.settle();const selects=()=>{const all:any[]=[];function walk(n:any){if(!n||typeof n!=='object')return;if(n.type==='select')all.push(n);[n.props?.children].flat(Infinity).forEach(walk);}walk(h.tree());return all;};
    assert.equal(selects()[1].props.value,'');assert.equal(button(tree,'مراجعة التطبيق والتوقيت').props.disabled,true);
    selects()[1].props.onChange({target:{value:'1'}});tree=await h.settle();button(tree,'مراجعة التطبيق والتوقيت').props.onClick();tree=await h.settle();
    assert.ok(find(tree,n=>n.type==='input'&&n.props.type==='checkbox'));
    button(tree,'المراجعات التالية').props.onClick();tree=await h.settle();assert.equal(selects()[1].props.value,'');assert.equal(find(tree,n=>n.type==='input'&&n.props.type==='checkbox'),null);
    selects()[1].props.onChange({target:{value:'26'}});tree=await h.settle();button(tree,'مراجعة التطبيق والتوقيت').props.onClick();tree=await h.settle();
    find(tree,n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});tree=await h.settle();button(tree,'تأكيد التطبيق والتوقيت').props.onClick();tree=await h.settle();assert.equal(applied,1);assert.equal(locks.at(-1),true);
    const close=button(tree,'إغلاق');assert.equal(close.props.disabled,true);close.props.onClick();assert.equal(closed,0);
    button(tree,'التحقق من نتيجة العملية دون إعادة الحفظ').props.onClick();tree=await h.settle();assert.equal(locks.at(-1),false);assert.equal(applied,1);assert.equal(calls.at(-1).init.method,'GET');assert.equal(calls.at(-1).init.body,undefined);
  }finally{h.unmount();}
}));

test('actual history late response after silent principal change clears private context',async()=>environment(async state=>{
  const pending=deferred();globalThis.fetch=async()=>pending.promise;
  const h=mount('TemplateApplication',{courseId:id(1),destination:{unitId:id(2),lessonId:id(3),title:'Private lesson'},templates:[template],onClose:()=>{},onLockChange:()=>{}});(globalThis as any).React=h.React;
  try{h.render();state.identity='owner-B';pending.resolve(new Response(JSON.stringify({revisions:[revision(1)],next_cursor:null})));const tree=await h.settle();const html=require('react-dom/server').renderToStaticMarkup(tree);assert.doesNotMatch(html,/Private/);assert.match(html,/أُخفيت/);}finally{h.unmount();}
}));

test('actual parent storage invalidation hides source/destination/template names',async()=>environment(async state=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({templates:[template],next_cursor:null}));
  const h=mount('LessonPackageTemplates',{courseId:id(1)});(globalThis as any).React=h.React;
  try{h.render();await h.settle();state.storage.forEach(fn=>fn({key:'currentUser'}));const html=require('react-dom/server').renderToStaticMarkup(await h.settle());assert.doesNotMatch(html,/Private/);assert.match(html,/أُخفيت/);}finally{h.unmount();}assert.equal(state.storage.length,0);
}));

for(const mode of ['create','revise','archive'])test(`actual parent ${mode} write keeps recovery mounted and propagates the outer dialog lock`,async()=>environment(async()=>{
  const calls:any[]=[],locks:boolean[]=[];let operationId='';
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    if(init?.method==='POST'||init?.method==='PATCH'){operationId=JSON.parse(String(init.body)).operation_id;throw Error('Lost reply after durable write');}
    if(String(url).includes('/operations/'))return new Response(JSON.stringify({operation:{operation_id:operationId,operation_kind:mode,template:{...template,status:mode==='archive'?'archived':'active',head_revision:mode==='revise'?31:1},...(mode==='archive'?{unchanged:false}:mode==='revise'?{template_id:template.id,revision:{revision_number:31,reference_count:1,media_count:1}}:{revision:{revision_number:1,reference_count:1,media_count:1}})}}));
    return new Response(JSON.stringify({templates:[template],next_cursor:'next'}));
  };
  const h=mount('LessonPackageTemplates',{courseId:id(1),onLockChange:(locked:boolean)=>locks.push(locked)});(globalThis as any).React=h.React;
  try {
    h.render();let tree=await h.settle();
    if(mode==='archive')button(tree,'أرشفة').props.onClick();
    else {
      button(tree,mode==='create'?'حفظ قالب من حصة':'إضافة مراجعة من مصدر').props.onClick();tree=await h.settle();
      const picker=find(tree,n=>n.type?.name==='LessonPackageSources'),editor=picker.props.renderSource({unitId:id(2),lessonId:id(4),title:'source'},()=>{});
      editor.props.onSave(template.name,[{kind:'material',source_id:id(20)}]);
    }
    tree=await h.settle();assert.ok(operationId);assert.equal(locks.at(-1),true);assert.equal(button(tree,'حفظ قالب من حصة').props.disabled,true);
    const before=calls.length;button(tree,'حفظ قالب من حصة').props.onClick();button(tree,'تحديث القوالب').props.onClick();await h.settle();assert.equal(calls.length,before);
    button(tree,'التحقق من عملية الحفظ').props.onClick();await h.settle();assert.equal(locks.at(-1),false);assert.equal(calls.at(-1).init.method,'GET');assert.equal(calls.filter(x=>['POST','PATCH'].includes(x.init?.method)).length,1);
  }finally{h.unmount();}
}));

for(const outcome of ['success','error'])test(`actual source ${outcome} after silent identity change cannot restore private metadata`,async()=>environment(async state=>{
  const pending=deferred();let invalid=0;
  globalThis.fetch=async url=>{await pending.promise;return new Response(JSON.stringify(outcome==='error'?{error:'denied'}:String(url).endsWith('/contents')?{contents:[]}:String(url).endsWith('/videos')?{videos:[]}:String(url).endsWith('/activities')?{activities:[]}:{announcement:null}),{status:outcome==='error'?403:200});};
  const h=mount('TemplateSourceEditor',{courseId:id(1),source:{unitId:id(2),lessonId:id(4),title:'source'},saving:false,onSave:()=>{},onLockChange:()=>{},onInvalidSession:()=>invalid++});(globalThis as any).React=h.React;
  try{h.render();state.identity='owner-B';pending.resolve(true);await h.settle();assert.ok(invalid>0);assert.equal(find(h.tree(),n=>n.type==='input'&&n.props.type==='checkbox'),null);}finally{h.unmount();}
}));

test('actual course details dialog refuses close while its template child is pending',async()=>environment(async()=>{
  const h=mount('default',{},true);(globalThis as any).React=h.React;
  try {
    h.render();let tree=await h.settle();button(tree,'عرض التفاصيل').props.onClick();tree=await h.settle();
    const panel=find(tree,n=>n.type?.name==='LessonPackageTemplates');assert.ok(panel);panel.props.onLockChange(true);tree=await h.settle();
    const details=find(tree,n=>n.props?.open===true&&n.props?.onOpenChange);assert.ok(details);
    details.props.onOpenChange(false);tree=await h.settle();assert.ok(find(tree,n=>n.type?.name==='LessonPackageTemplates'));
    const close=find(tree,n=>n.props?.children==='إغلاق'&&n.props?.className==='w-full');assert.ok(close);assert.equal(close.props.disabled,true);close.props.onClick();await h.settle();assert.ok(find(h.tree(),n=>n.type?.name==='LessonPackageTemplates'));
    const returnPanel=find(tree,n=>n.type?.name==='CourseReturnPlan');assert.ok(returnPanel);returnPanel.props.onLockChange(true);panel.props.onLockChange(false);await h.settle();details.props.onOpenChange(false);await h.settle();assert.ok(find(h.tree(),n=>n.type?.name==='CourseReturnPlan'));
    returnPanel.props.onLockChange(false);await h.settle();details.props.onOpenChange(false);await h.settle();assert.equal(find(h.tree(),n=>n.type?.name==='LessonPackageTemplates'),null);
  }finally{h.unmount();}
}));
