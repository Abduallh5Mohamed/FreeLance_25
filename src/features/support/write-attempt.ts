export interface SupportAttemptState { busy:boolean; uncertain:boolean; locked:boolean; error:string|null; blocked:boolean }
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
/** Persist only an opaque request UUID. Private form text stays in memory. */
export function createSupportAttempt<P,T>(deps:{
  readKey():string|null;saveKey(key:string):void;clearKey():void;makeKey():string;readIdentity():string|null;
  send(payload:P,key:string,signal:AbortSignal):Promise<T>;reconcile(key:string,signal:AbortSignal):Promise<T>;timeoutMs?:number;
  onDenied?:()=>void;
  isDefinitiveRejection?:(error:unknown)=>boolean;
}){
  let key:string|null=null,payloadSignature:string|null=null,ended=false,epoch=0,active:AbortController|null=null;
  let state:SupportAttemptState={busy:false,uncertain:false,locked:false,error:null,blocked:false};
  const identity=deps.readIdentity(),listeners=new Set<(value:SupportAttemptState)=>void>();
  const set=(patch:Partial<SupportAttemptState>)=>{state={...state,...patch};listeners.forEach(fn=>fn(state));};
  try{key=deps.readKey();if(key&&!uuid.test(key))throw Error('invalid key');if(key)state={...state,uncertain:true};}
  catch{state={...state,blocked:true,error:'تعذّر قراءة معرّف المحاولة السابقة. أعد فتح الصفحة بعد إتاحة تخزين الجلسة.'};}
  const invalidate=()=>{ended=true;epoch++;active?.abort();payloadSignature=null;set({busy:false,locked:false,blocked:true,error:null});};
  const current=(ticket:number)=>{
    if(ended||ticket!==epoch)return false;
    if(!identity||identity!==deps.readIdentity()){invalidate();return false;}return true;
  };
  const execute=async(payload?:P):Promise<T|null>=>{
    if(ended||state.busy||state.blocked)return null;
    const ticket=++epoch;if(!current(ticket))return null;
    let sent=false;active=new AbortController();const cancel=active;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      const signature=payload===undefined?null:JSON.stringify(payload);
      if(signature!==null&&payloadSignature!==null&&signature!==payloadSignature){set({error:'المحاولة غير مؤكدة. استخدم نفس البيانات أو تحقق من نتيجتها أولًا.'});return null;}
      if(payload===undefined&&!key)return null;
      if(!key){const next=deps.makeKey();if(!uuid.test(next))throw Error('invalid request key');deps.saveKey(next);key=next;}
      if(signature!==null)payloadSignature=signature;
      set({busy:true,error:null,locked:payloadSignature!==null});
      const expired=new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{cancel.abort();reject(Error('Support attempt timed out'));},deps.timeoutMs??60000);});
      sent=true;
      const result=await Promise.race([payload===undefined?deps.reconcile(key,cancel.signal):deps.send(JSON.parse(signature!) as P,key,cancel.signal),expired]);
      if(!current(ticket))return null;
      try{deps.clearKey();key=null;payloadSignature=null;set({uncertain:false,locked:false,error:null});}
      catch{set({uncertain:false,blocked:true,error:'تم تأكيد الحفظ، لكن تعذّر تنظيف معرّف المحاولة محليًا. أعد فتح الصفحة قبل طلب جديد.'});}
      return result;
    }catch(error){
      if(current(ticket)&&payload!==undefined&&deps.isDefinitiveRejection?.(error)){
        try{deps.clearKey();key=null;payloadSignature=null;set({uncertain:false,locked:false,error:'لم يُنفذ القرار لأن الحالة أو صلاحية المسؤول تغيّرت. حدّث البيانات قبل قرار جديد.'});}
        catch{set({uncertain:false,locked:false,blocked:true,error:'لم يُنفذ القرار، وتعذّر تنظيف معرّف المحاولة. أعد فتح اللوحة بعد إتاحة تخزين الجلسة.'});}
        return null;
      }
      if(current(ticket)&&error&&typeof error==='object'&&'status'in error&&typeof error.status==='number'
        &&[401,403,404].includes(error.status)&&!('code'in error&&error.code==='SUPPORT_ATTEMPT_NOT_FOUND')){
        invalidate();deps.onDenied?.();return null;
      }
      if(current(ticket))set({uncertain:sent||state.uncertain,locked:payloadSignature!==null,error:sent
        ?'النتيجة غير مؤكدة. تحقق من نتيجة المحاولة أو أعد إرسال نفس البيانات بنفس المعرّف.'
        :'تعذّر تجهيز معرّف المحاولة قبل الإرسال. لم يُرسل طلب حفظ.'});
      return null;
    }finally{if(timeout)clearTimeout(timeout);cancel.abort();if(current(ticket))set({busy:false});}
  };
  return {getState:()=>state,subscribe(fn:(value:SupportAttemptState)=>void){listeners.add(fn);fn(state);return()=>{listeners.delete(fn);};},
    send:(payload:P)=>execute(payload),reconcile:()=>execute(),invalidate,
    dispose(){invalidate();listeners.clear();},
  };
}
