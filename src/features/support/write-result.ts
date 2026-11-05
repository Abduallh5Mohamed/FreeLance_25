import type {SupportTicket,SupportStatus} from '../../lib/api-http';
import {parseSupportReplyPage} from './reply-page';
const statuses=['open','waiting_on_support','waiting_on_user','resolved','closed'];
const exact=(x:unknown,keys:string[]):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===keys.length&&keys.every(key=>Object.prototype.hasOwnProperty.call(x,key));
export function parseSupportTicketWrite(value:unknown):{ticket:SupportTicket;unchanged:boolean}{
  const fail=()=>new Error('Invalid support ticket acknowledgement');
  if(!exact(value,['ticket','unchanged'])||typeof value.unchanged!=='boolean'||!exact(value.ticket,['id','ticket_number','user_id','category','subject','description','status','priority','created_at','updated_at']))throw fail();
  const row=value.ticket;
  if(!Object.values(row).every(x=>typeof x==='string')||!/^[a-f\d-]{36}$/i.test(row.id as string)
    ||!statuses.includes(row.status as string)||!['technical','account','billing','content','exam','video','other'].includes(row.category as string)
    ||!['low','normal','high','urgent'].includes(row.priority as string)||!Number.isFinite(Date.parse(row.created_at as string))||!Number.isFinite(Date.parse(row.updated_at as string)))throw fail();
  return {ticket:row as unknown as SupportTicket,unchanged:value.unchanged};
}
export function parseSupportReplyWrite(value:unknown,ticketId:string){
  if(!exact(value,['reply','ticket_id','ticket_status','unchanged'])||value.ticket_id!==ticketId||typeof value.unchanged!=='boolean'||typeof value.ticket_status!=='string'||!statuses.includes(value.ticket_status))throw Error('Invalid support reply acknowledgement');
  return {reply:parseSupportReplyPage({replies:[value.reply],next_cursor:null}).replies[0],ticket_id:ticketId,ticket_status:value.ticket_status as SupportStatus,unchanged:value.unchanged};
}
