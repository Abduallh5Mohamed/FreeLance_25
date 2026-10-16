'use strict';
const readline=require('node:readline');
const {createMailbox,TEAMS}=require('./mailbox-core.cjs');
const mailbox=createMailbox(__dirname);
const string={type:'string'};
const tools=[
 {name:'next_approved_task',description:'Claim ONE approved runnable task with exclusive path reservations. Optional worker/session/team and task selectors. Empty means stop. Do not claim on behalf of children.',inputSchema:{type:'object',properties:{workerId:string,sessionId:string,team:{type:'string',enum:TEAMS},taskId:string},additionalProperties:false}},
 {name:'submit_task_report',description:'Report only AFTER all work and child activity on this claim stop. Report releases reservations, never accepts implementation or authorizes next phase. Exact retry is idempotent.',inputSchema:{type:'object',properties:{taskId:string,claimToken:string,status:{type:'string',enum:['reported','blocked']},summary:{type:'string',maxLength:20000},evidence:{type:'array',items:string,maxItems:50},questions:{type:'array',items:string,maxItems:20}},required:['taskId','claimToken','status','summary','evidence','questions'],additionalProperties:false}},
 {name:'task_status',description:'Sanitized task status. Claimed/heartbeat are self-reports, not model liveness proof.',inputSchema:{type:'object',properties:{taskId:string},required:['taskId'],additionalProperties:false}},
 {name:'dispatch_plan',description:'Read an advisory non-reserving plan of independent approved tasks, conflicts and unmet dependencies. Never creates or approves work.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'queue_status',description:'Read capacity, active claims, overdue leases and blocked tasks. Never returns claim tokens. Expiry never reassigns work.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
 {name:'task_heartbeat',description:'Renew own active claim at work checkpoints. Do not poll continuously. No scope change or automatic reclaim.',inputSchema:{type:'object',properties:{taskId:string,claimToken:string},required:['taskId','claimToken'],additionalProperties:false}},
 {name:'task_checkpoint',description:'Save a short redacted progress note and renew own claim. Never include credentials, signed URLs or claim token in note.',inputSchema:{type:'object',properties:{taskId:string,claimToken:string,note:{type:'string',maxLength:3000}},required:['taskId','claimToken','note'],additionalProperties:false}},
];
function send(x){process.stdout.write(JSON.stringify(x)+'\n');}
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
let chain=Promise.resolve();
rl.on('line',line=>{chain=chain.then(()=>{
 let req;try{req=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
 if(req.id===undefined)return;
 let result;
 if(req.method==='initialize')result={protocolVersion:req.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'workbuddy-supervisor-mailbox',version:'0.2.0'}};
 else if(req.method==='ping')result={};
 else if(req.method==='tools/list')result={tools};
 else if(req.method==='tools/call'){
  try{if(!tools.some(t=>t.name===req.params?.name))throw Error('Unknown tool');result={content:[{type:'text',text:JSON.stringify(mailbox.call(req.params.name,req.params.arguments||{}))}]};}
  catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}
 }else{send({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Method not found'}});return;}
 send({jsonrpc:'2.0',id:req.id,result});
}).catch(()=>send({jsonrpc:'2.0',id:null,error:{code:-32603,message:'Internal error'}}));});
rl.on('close',()=>chain.then(()=>process.exit(0)));
