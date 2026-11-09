import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=Module.createRequire(import.meta.url);

test('actual StudentSpaces completes verified rotation across guard disposal; stale or rejected rotation never navigates',async()=>{
 const React=require('react'),loader=Module as any,original=loader._load;
 const previous={storage:globalThis.localStorage,React:(globalThis as any).React};
 const file=require.resolve('../pages/StudentSpaces.tsx');
 const space={student_enrollment_id:'enrollment',tenant_id:'tenant',business_name:'synthetic',group_id:null,grade_id:null};
 try{for(const outcome of ['verified','stale','rejected']){
  let controller:any;const navigations:string[]=[];
  (globalThis as any).localStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
  (globalThis as any).React=React;
  delete require.cache[file];loader._load=function(request:string,parent:any,main:boolean){
   if(request==='react'&&parent?.filename===file)return{...React,useMemo:(factory:Function)=>(controller=factory()),useEffect:()=>{},useSyncExternalStore:(_:any,get:Function)=>get()};
   if(request==='react-router-dom'&&parent?.filename===file)return{useNavigate:()=>((to:string)=>navigations.push(to))};
   if(request==='@/lib/api'&&parent?.filename===file)return{
    getStudentSpaces:async()=>[space],getCurrentStudentEnrollment:async()=>{throw new Error('Disposed selection must not read a second profile');},
    selectStudentSpace:async()=>{controller.dispose();if(outcome==='rejected')throw new Error('Candidate profile failed');return{token:'synthetic',tenant_id:'tenant',student_enrollment_id:'enrollment',isCurrentSession:()=>outcome==='verified'};},
   };
   if(request.startsWith('@/'))return original.call(this,path.join(fileURLToPath(new URL('..',import.meta.url)),request.slice(2)),parent,main);
   return original.call(this,request,parent,main);
  };
  const Page=require(file).default;loader._load=original;Page();await controller.loadSpaces();await controller.select(space);
  assert.deepEqual(navigations,outcome==='verified'?['/student']:[],outcome);
 }}finally{loader._load=original;delete require.cache[file];(globalThis as any).localStorage=previous.storage;(globalThis as any).React=previous.React;}
});
