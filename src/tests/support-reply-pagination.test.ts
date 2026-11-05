import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSupportReplyPage } from '../features/support/reply-page';
import { getSupportTicket, getOlderSupportReplies, ApiRequestError } from '../lib/api-http';

const reply=(id:string)=>({id,body:'synthetic support reply',sender_id:'owner',sender_name:'Owner',sender_role:'student',created_at:'2026-11-05T10:00:00Z'});
test('reply pages reject extra private fields, duplicate rows, overflow and nonadvancing cursors',()=>{
  const hundred=Array.from({length:100},(_,n)=>reply(`row-${n}`));
  assert.equal(parseSupportReplyPage({replies:hundred,next_cursor:'row-0'}).replies.length,100);
  for(const value of [
    {replies:[],next_cursor:null,phone:'private'}, {replies:[{...reply('one'),ticket_id:'private'}],next_cursor:null},
    {replies:[reply('one'),reply('one')],next_cursor:null}, {replies:[...hundred,reply('overflow')],next_cursor:null},
    {replies:[reply('one')],next_cursor:'one'}, {replies:hundred,next_cursor:'different'},
    {replies:[{...reply('one'),created_at:'invalid'}],next_cursor:null}, {replies:[],next_cursor:['cursor']},
  ])assert.throws(()=>parseSupportReplyPage(value));
});
test('real support transport fetches bounded reply pages on relative authenticated routes',async()=>{
  const oldFetch=globalThis.fetch,oldStorage=globalThis.localStorage,calls:any[]=[];
  (globalThis as any).localStorage={getItem:(key:string)=>key==='authToken'?'synthetic-token':null};
  globalThis.fetch=async(url:any,init:any)=>{calls.push([url,init]);return new Response(JSON.stringify(String(url).includes('/replies?')
    ?{replies:[reply('older')],next_cursor:null}
    :{ticket:{id:'ticket'},replies:[reply('latest')],next_cursor:null,has_more_replies:false}));};
  const abort=new AbortController();
  try {
    assert.equal((await getSupportTicket('ticket',abort.signal)).replies[0].id,'latest');
    assert.equal((await getOlderSupportReplies('ticket','previous',abort.signal)).replies[0].id,'older');
    assert.deepEqual(calls.map(row=>row[0]),['/api/support-tickets/ticket','/api/support-tickets/ticket/replies?before=previous']);
    assert.ok(calls.every(row=>new Headers(row[1].headers).get('Authorization')==='Bearer synthetic-token'&&row[1].cache==='no-store'&&row[1].signal===abort.signal));
    globalThis.fetch=async()=>new Response(JSON.stringify({error:'Not found'}),{status:404});
    await assert.rejects(()=>getOlderSupportReplies('ticket','previous'),error=>error instanceof ApiRequestError&&error.status===404);
  } finally {globalThis.fetch=oldFetch;(globalThis as any).localStorage=oldStorage;}
});
