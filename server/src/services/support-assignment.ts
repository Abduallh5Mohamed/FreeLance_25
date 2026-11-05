import type {CourseLessonConnection} from '../routes/course-lessons';

export async function supportAssignmentSchema(connection:CourseLessonConnection){
  const [tables]=await connection.execute(`SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_assignment_attempts' LIMIT 1`);
  const [columns]=await connection.execute(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('support_tickets','support_assignment_attempts') AND COLUMN_NAME IN ('id','ticket_id','actor_user_id','assigned_to','expected_version','result_version','changed','assignment_version') LIMIT 16`);
  const [primary]=await connection.execute(`SELECT COLUMN_NAME AS column_name,SEQ_IN_INDEX AS seq_in_index FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='support_assignment_attempts' AND INDEX_NAME='PRIMARY' LIMIT 2`);
  return (tables as any[])[0]?.engine==='InnoDB'
    &&['assigned_to','assignment_version'].every(name=>(columns as any[]).some(row=>row.table_name==='support_tickets'&&row.column_name===name))
    &&['id','ticket_id','actor_user_id','assigned_to','expected_version','result_version','changed'].every(name=>(columns as any[]).some(row=>row.table_name==='support_assignment_attempts'&&row.column_name===name))
    &&(primary as any[]).length===1&&(primary as any[])[0].column_name==='id'&&Number((primary as any[])[0].seq_in_index)===1;
}
export function assignmentVersion(value:unknown):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>2147483647)throw Error('Invalid assignment version');
  return value;
}
export async function assignmentState(connection:CourseLessonConnection,ticketId:string){
  const [rows]=await connection.execute('SELECT id,assigned_to,assignment_version FROM support_tickets WHERE id=? LIMIT 1 FOR UPDATE',[ticketId]);
  const row=(rows as any[])[0];
  if(!row||row.id!==ticketId||!(row.assigned_to===null||typeof row.assigned_to==='string'&&row.assigned_to.length>0&&row.assigned_to.length<=36))throw Error('Invalid assignment state');
  return {ticket_id:row.id as string,assigned_to:row.assigned_to as string|null,version:assignmentVersion(row.assignment_version)};
}
export async function assignmentReceipt(connection:CourseLessonConnection,id:string,ticketId:string){
  const [rows]=await connection.execute('SELECT id,ticket_id,actor_user_id,assigned_to,expected_version,result_version,changed FROM support_assignment_attempts WHERE id=? AND ticket_id=? LIMIT 1 FOR UPDATE',[id,ticketId]);
  const row=(rows as any[])[0];if(!row)return null;
  if(row.id!==id||row.ticket_id!==ticketId||typeof row.actor_user_id!=='string'||!(row.assigned_to===null||typeof row.assigned_to==='string'&&row.assigned_to.length>0&&row.assigned_to.length<=36)
    ||![0,1].includes(row.changed))throw Error('Invalid assignment receipt');
  const expected=assignmentVersion(row.expected_version),version=assignmentVersion(row.result_version);
  if(version!==expected+row.changed)throw Error('Inconsistent assignment receipt');
  return {actor_id:row.actor_user_id,expected_version:expected,assignment:{ticket_id:row.ticket_id as string,assigned_to:row.assigned_to as string|null,version},changed:row.changed===1};
}
