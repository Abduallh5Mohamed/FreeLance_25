import { createHash, randomBytes, randomUUID } from 'crypto';
import type { CourseLessonConnection } from '../routes/course-lessons';
import { ACTIVE_SUSPENSION_PREDICATE_SQL } from '../security/suspension-predicate';
import {parseLessonContextInput,supportContextSchema,storedLessonContext,proveLessonSupportContext,type StoredLessonContext} from './support-lesson-context';

type Actor = { id: string; tokenVersion?: number; identitySource?: 'users' | 'staff'; role?:string;tenantId?:string;studentEnrollmentId?:string };
type Result = { status: number; body: any };
type Work = Result & { write: boolean };
const categories = new Set(['technical','account','billing','content','exam','video','other']);
const statuses = new Set(['open','waiting_on_support','waiting_on_user','resolved','closed']);
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
class Stop extends Error { constructor(readonly result: Result) { super('Support write refused'); } }
const stop = (status: number, error: string, code: string): never => { throw new Stop({ status, body: { error, code } }); };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const ticketFields = 'id,ticket_number,user_id,category,subject,description,status,priority,created_at,updated_at';
const ticketDto = (row: any) => ({ id:row.id,ticket_number:row.ticket_number,user_id:row.user_id,category:row.category,subject:row.subject,
  description:row.description,status:row.status,priority:row.priority,created_at:row.created_at,updated_at:row.updated_at });
const replyDto = (row: any) => ({ id:row.id,body:row.body,created_at:row.created_at,sender_id:row.sender_id,sender_name:row.sender_name,sender_role:row.sender_role });

// UUIDv8 namespace: stable per actor/operation/key. The random request key is
// not an authority token; every replay still proves live user/ticket access.
export function supportWriteId(actorId: string, operation: 'create' | 'reply', requestId: string) {
  const bytes = createHash('sha256').update(JSON.stringify(['tabweb-support-v1',actorId,operation,requestId.toLowerCase()])).digest().subarray(0,16);
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function createSupportWriteService(deps: { getConnection(): Promise<CourseLessonConnection> }) {
  const run = async (actor: Actor, work: (connection: CourseLessonConnection, verifiedActor: Actor) => Promise<Work>): Promise<Result> => {
    let connection: CourseLessonConnection | null=null, open=false, committing=false, destroyed=false;
    const rollback=async()=>{open=false;try{await connection!.rollback();}catch{destroyed=true;throw Error('Support rollback failed');}};
    try {
      if (actor.identitySource === 'staff') stop(403,'Support requires a user account','SUPPORT_IDENTITY_UNSUPPORTED');
      connection=await deps.getConnection();await connection.beginTransaction();open=true;
      const [tables]=await connection.execute(`SELECT TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','support_tickets','support_ticket_replies','audit_events','admin_user_roles','admin_role_permissions') LIMIT 6`);
      const names=['users','support_tickets','support_ticket_replies','audit_events'];
      if (![...names,'admin_user_roles','admin_role_permissions'].every(name=>(tables as any[]).some(row=>row.table_name===name&&row.engine==='InnoDB'))) stop(503,'Support storage unavailable','SUPPORT_WRITE_UNAVAILABLE');
      const [indexes]=await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','support_tickets','support_ticket_replies','audit_events') AND INDEX_NAME='PRIMARY' LIMIT 8`);
      if (!names.every(name=>{const rows=(indexes as any[]).filter(row=>row.table_name===name);return rows.length===1&&rows[0].column_name==='id'&&Number(rows[0].seq_in_index)===1;})) stop(503,'Support storage unavailable','SUPPORT_WRITE_UNAVAILABLE');
      const [users]=await connection.execute(`SELECT id,is_active,token_version,${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1 FOR UPDATE`,[actor.id]);
      const user=(users as any[])[0];
      if(!user||Number(user.is_active)!==1||Number(user.suspension_active)!==0||Number(user.token_version??0)!==Number(actor.tokenVersion??0)) stop(401,'Session is no longer active','AUTH_REVOKED');
      const result=await work(connection,{...actor,id:String(user.id)});
      if(result.write){committing=true;await connection.commit();open=false;}else await rollback();
      return {status:result.status,body:result.body};
    } catch(error) {
      if(committing){destroyed=true;return {status:503,body:{error:'Support save outcome uncertain; retry the same request',code:'PERSISTENCE_UNCERTAIN'}};}
      if(connection&&!open)destroyed=true;
      if(open){try{await rollback();}catch{destroyed=true;}}
      if(error instanceof Stop)return error.result;
      if(error&&typeof error==='object'&&'code'in error&&error.code==='ER_DUP_ENTRY')return {status:409,body:{error:'Support request conflicts; retry the same request',code:'SUPPORT_WRITE_CONFLICT'}};
      return {status:503,body:{error:'Support write unavailable; retry the same request',code:'SUPPORT_WRITE_UNAVAILABLE'}};
    } finally {if(connection){try{if(destroyed)connection.destroy();else connection.release();}catch{/* retain outcome */}}}
  };
  const authorizeTicket=async(connection:CourseLessonConnection,actor:Actor,ticketId:string)=>{
    const [tickets]=await connection.execute(`SELECT ${ticketFields} FROM support_tickets WHERE id=? LIMIT 1 FOR UPDATE`,[ticketId]);
    const ticket=(tickets as any[])[0];if(!ticket)stop(404,'Support ticket not found','SUPPORT_TICKET_NOT_FOUND');
    const [grants]=await connection.execute(`SELECT ur.user_id,rp.permission_key FROM admin_user_roles ur
      LEFT JOIN admin_role_permissions rp ON rp.role_code=ur.role_code AND rp.permission_key='support.read'
      WHERE ur.user_id=? AND (ur.role_code='super_admin' OR rp.permission_key='support.read') LIMIT 101 FOR UPDATE`,[actor.id]);
    if((grants as any[]).length>100)stop(503,'Support authorization unavailable','SUPPORT_WRITE_UNAVAILABLE');
    const admin=(grants as any[]).length>0;
    if(ticket.user_id!==actor.id&&!admin)stop(404,'Support ticket not found','SUPPORT_TICKET_NOT_FOUND');
    return {ticket,admin};
  };
  const audit=async(connection:CourseLessonConnection,actor:Actor,action:string,ticketId:string,oldStatus:string|null,newStatus:string,replyId?:string,context?:StoredLessonContext)=>{
    const [result]=await connection.execute(`INSERT INTO audit_events (id,actor_user_id,tenant_id,action,resource_type,resource_id,old_value,new_value)
      VALUES (?,?,NULL,?,'support_ticket',?,?,?)`,[randomUUID(),actor.id,action,ticketId,oldStatus===null?null:JSON.stringify({status:oldStatus}),JSON.stringify({status:newStatus,...(replyId?{reply_id:replyId}:{}),...(context?{context:{kind:context.kind,course_id:context.course_id,lesson_id:context.lesson_id}}:{})})]);
    if(Number(result.affectedRows)!==1)throw Error('Support audit not recorded');
  };
  return {
    async context(actor:Actor,ticketId:string):Promise<Result>{
      return run(actor,async(connection,actor)=>{
        const {ticket,admin}=await authorizeTicket(connection,actor,ticketId);
        if(!await supportContextSchema(connection))return {status:200,body:{state:'unconfigured',context:null},write:false};
        const stored=await storedLessonContext(connection,ticket.id);
        if(!stored)return {status:200,body:{state:'none',context:null},write:false};
        const unavailable=()=>({status:200,body:{state:'unavailable',context:null},write:false});
        if(!admin&&(actor.role!=='student'||actor.tenantId?.toLowerCase()!==stored.tenant_id.toLowerCase()||actor.studentEnrollmentId?.toLowerCase()!==stored.enrollment_id.toLowerCase()))return unavailable();
        if(ticket.user_id!==actor.id){
          const [owners]=await connection.execute(`SELECT id,is_active,${ACTIVE_SUSPENSION_PREDICATE_SQL} AS suspension_active FROM users WHERE id=? LIMIT 1`,[ticket.user_id]);
          const owner=(owners as any[])[0];if(!owner||Number(owner.is_active)!==1||Number(owner.suspension_active)!==0)return unavailable();
        }
        const proof=await proveLessonSupportContext(connection,{userId:ticket.user_id,tenantId:stored.tenant_id,enrollmentId:stored.enrollment_id},stored);
        return proof.ok?{status:200,body:{state:'available',context:proof.context},write:false}:unavailable();
      });
    },
    async reconcile(actor:Actor,operation:string,requestId:unknown):Promise<Result>{
      if(!['create','reply'].includes(operation)||typeof requestId!=='string'||!uuid.test(requestId))return {status:400,body:{error:'Invalid support attempt',code:'SUPPORT_REQUEST_KEY'}};
      return run(actor,async (connection,actor)=>{
        const id=supportWriteId(actor.id,operation as 'create'|'reply',requestId);
        if(operation==='create'){
          const [rows]=await connection.execute(`SELECT ${ticketFields} FROM support_tickets WHERE id=? LIMIT 1`,[id]);
          const ticket=(rows as any[])[0];
          if(!ticket||ticket.user_id!==actor.id)stop(404,'No confirmed support attempt found; retry with the same key','SUPPORT_ATTEMPT_NOT_FOUND');
          return {status:200,body:{ticket:ticketDto(ticket),unchanged:true},write:false};
        }
        const [rows]=await connection.execute('SELECT id,ticket_id,sender_id,body FROM support_ticket_replies WHERE id=? LIMIT 1',[id]);
        const row=(rows as any[])[0];
        if(!row||row.sender_id!==actor.id)stop(404,'No confirmed support attempt found; retry with the same key','SUPPORT_ATTEMPT_NOT_FOUND');
        const {ticket}=await authorizeTicket(connection,actor,row.ticket_id);
        const [replies]=await connection.execute(`SELECT r.id,r.body,r.created_at,r.sender_id,u.name AS sender_name,u.role AS sender_role
          FROM support_ticket_replies r INNER JOIN users u ON u.id=r.sender_id WHERE r.id=? AND r.ticket_id=? LIMIT 1`,[id,row.ticket_id]);
        if(!(replies as any[])[0])throw Error('Reply missing');
        return {status:200,body:{reply:replyDto((replies as any[])[0]),ticket_id:ticket.id,ticket_status:ticket.status,unchanged:true},write:false};
      });
    },
    async create(actor:Actor,requestId:unknown,input:any):Promise<Result>{
      if(typeof requestId!=='string'||!uuid.test(requestId))return {status:400,body:{error:'UUID Idempotency-Key required',code:'SUPPORT_REQUEST_KEY'}};
      const category=text(input?.category),subject=text(input?.subject),description=text(input?.description);
      if(!categories.has(category)||subject.length<3||subject.length>200||description.length<10||description.length>10000)return {status:400,body:{error:'Invalid support ticket fields',code:'SUPPORT_INPUT'}};
      let requested:ReturnType<typeof parseLessonContextInput>;
      try{requested=parseLessonContextInput(input?.context);}catch{return {status:400,body:{error:'Invalid lesson context selectors',code:'SUPPORT_CONTEXT_INPUT'}};}
      if(requested&&(actor.role!=='student'||!actor.tenantId||!actor.studentEnrollmentId))return {status:403,body:{error:'A selected student workspace is required',code:'SUPPORT_CONTEXT_FORBIDDEN'}};
      return run(actor,async (connection,actor)=>{
        const contextReady=await supportContextSchema(connection);
        if(requested&&!contextReady)stop(503,'Lesson support context unavailable','SUPPORT_CONTEXT_UNAVAILABLE');
        const id=supportWriteId(actor.id,'create',requestId);
        const [existing]=await connection.execute(`SELECT ${ticketFields} FROM support_tickets WHERE id=? LIMIT 1 FOR UPDATE`,[id]);
        const previous=(existing as any[])[0];
        if(previous){
          if(previous.user_id!==actor.id||previous.category!==category||previous.subject!==subject||previous.description!==description)stop(409,'Request key already used with different data','SUPPORT_WRITE_CONFLICT');
          const stored=contextReady?await storedLessonContext(connection,previous.id):null;
          const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
          if(!!stored!==!!requested||stored&&requested&&(!same(stored.course_id,requested.course_id)||!same(stored.lesson_id,requested.lesson_id)||!same(stored.tenant_id,actor.tenantId!)||!same(stored.enrollment_id,actor.studentEnrollmentId!)))stop(409,'Request key already used with different lesson context','SUPPORT_WRITE_CONFLICT');
          return {status:200,body:{ticket:ticketDto(previous),unchanged:true},write:false};
        }
        let context:StoredLessonContext|undefined;
        if(requested){
          const proof=await proveLessonSupportContext(connection,{userId:actor.id,tenantId:actor.tenantId!,enrollmentId:actor.studentEnrollmentId!},requested,true);
          if(!proof.ok)throw new Stop({status:proof.status,body:proof.body});
          context={kind:'catalog_lesson',tenant_id:proof.scope.tenantId,enrollment_id:proof.scope.enrollmentId,course_id:proof.context.course_id,lesson_id:proof.context.lesson_id};
        }
        const number=`SUP-${new Date().toISOString().slice(0,7).replace('-','')}-${randomBytes(3).toString('hex').toUpperCase()}`;
        const [insert]=await connection.execute(`INSERT INTO support_tickets (id,ticket_number,user_id,category,subject,description,status,priority)
          VALUES (?,?,?,?,?,?,'open','normal')`,[id,number,actor.id,category,subject,description]);
        if(Number(insert.affectedRows)!==1)throw Error('Support insert failed');
        if(context){
          const [bound]=await connection.execute(`UPDATE support_tickets SET context_kind='catalog_lesson',context_tenant_id=?,context_enrollment_id=?,context_course_id=?,context_lesson_id=? WHERE id=? AND user_id=?`,[context.tenant_id,context.enrollment_id,context.course_id,context.lesson_id,id,actor.id]);
          if(Number(bound.affectedRows)!==1)throw Error('Support context binding failed');
        }
        await audit(connection,actor,'support_ticket.create',id,null,'open',undefined,context);
        const [rows]=await connection.execute(`SELECT ${ticketFields} FROM support_tickets WHERE id=? LIMIT 1`,[id]);
        if(!(rows as any[])[0])throw Error('Created ticket missing');
        return {status:201,body:{ticket:ticketDto((rows as any[])[0]),unchanged:false},write:true};
      });
    },
    async reply(actor:Actor,ticketId:string,requestId:unknown,input:any):Promise<Result>{
      if(typeof requestId!=='string'||!uuid.test(requestId))return {status:400,body:{error:'UUID Idempotency-Key required',code:'SUPPORT_REQUEST_KEY'}};
      const body=text(input?.body);
      if(!body.length||body.length>10000)return {status:400,body:{error:'Invalid reply body',code:'SUPPORT_INPUT'}};
      return run(actor,async (connection,actor)=>{
        const id=supportWriteId(actor.id,'reply',requestId);
        const {ticket,admin}=await authorizeTicket(connection,actor,ticketId);
        const [prior]=await connection.execute('SELECT id,ticket_id,sender_id,body FROM support_ticket_replies WHERE id=? LIMIT 1 FOR UPDATE',[id]);
        const previous=(prior as any[])[0];
        if(previous&&(previous.ticket_id!==ticketId||previous.sender_id!==actor.id||previous.body!==body))stop(409,'Request key already used with different data','SUPPORT_WRITE_CONFLICT');
        if(!previous){
          if(ticket.status==='closed')stop(409,'Closed tickets cannot receive replies','SUPPORT_TICKET_CLOSED');
          const [insert]=await connection.execute('INSERT INTO support_ticket_replies (id,ticket_id,sender_id,body) VALUES (?,?,?,?)',[id,ticketId,actor.id,body]);
          if(Number(insert.affectedRows)!==1)throw Error('Reply insert failed');
          const status=admin?'waiting_on_user':'waiting_on_support';
          const [update]=await connection.execute('UPDATE support_tickets SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[status,ticketId]);
          if(Number(update.affectedRows)!==1&&!(Number(update.affectedRows)===0&&ticket.status===status))throw Error('Reply status failed');
          await audit(connection,actor,'support_ticket.reply',ticketId,ticket.status,status,id);ticket.status=status;
        }
        const [rows]=await connection.execute(`SELECT r.id,r.body,r.created_at,r.sender_id,u.name AS sender_name,u.role AS sender_role
          FROM support_ticket_replies r INNER JOIN users u ON u.id=r.sender_id WHERE r.id=? AND r.ticket_id=? LIMIT 1`,[id,ticketId]);
        if(!(rows as any[])[0])throw Error('Reply missing');
        return {status:previous?200:201,body:{reply:replyDto((rows as any[])[0]),ticket_id:ticketId,ticket_status:ticket.status,unchanged:!!previous},write:!previous};
      });
    },
    async status(actor:Actor,ticketId:string,input:any):Promise<Result>{
      const next=text(input?.status);if(!statuses.has(next))return {status:400,body:{error:'Invalid support status',code:'SUPPORT_INPUT'}};
      return run(actor,async (connection,actor)=>{
        const {ticket,admin}=await authorizeTicket(connection,actor,ticketId);
        if(!admin&&!['resolved','closed'].includes(next))stop(403,'Users can only resolve or close their own tickets','SUPPORT_STATUS_FORBIDDEN');
        if(ticket.status===next)return {status:200,body:{success:true,status:next,unchanged:true},write:false};
        const [update]=await connection.execute(`UPDATE support_tickets SET status = ?,
          resolved_at = CASE WHEN ? = 'resolved' THEN CURRENT_TIMESTAMP ELSE resolved_at END,
          closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE closed_at END WHERE id = ?`,[next,next,next,ticketId]);
        if(Number(update.affectedRows)!==1)throw Error('Status update failed');
        await audit(connection,actor,'support_ticket.status',ticketId,ticket.status,next);
        return {status:200,body:{success:true,status:next,unchanged:false},write:true};
      });
    },
  };
}
