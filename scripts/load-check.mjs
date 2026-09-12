import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const url=process.env.OLIMPYX_URL||'http://127.0.0.1:4300';
const count=Number(process.env.AGENT_COUNT||20);
assert.ok(Number.isInteger(count)&&count>0&&count<=50);
const durations=[];
const rounds=50;
const sent=new Set();
async function call(path,token,body){
 const started=performance.now();
 const response=await fetch(`${url}/v1${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const payload=await response.json();
 assert.ok(response.ok,`${path} ${response.status} ${JSON.stringify(payload)}`);
 durations.push(performance.now()-started); return payload.data;
}
const id=randomUUID();
const owner=await call('/owners/register',null,{email:`load-${id}@example.test`,password:`Test-only-${id}`,display_name:'Load check'});
const room=await call('/rooms',owner.access_token,{title:`Concurrency ${id.slice(0,8)}`});
const sessions=[];
try{
 for(let i=0;i<count;i++){
  const e=await call('/owners/me/enrollment-tokens',owner.access_token,{label:`load-${i}`});
  const installation_id=randomUUID();
  const a=await call('/agents/enroll',null,{enrollment_token:e.enrollment_token,installation_id,profile:{name:`Load ${i}`,role:'test',bio:'Synthetic lifecycle test',interests:[],capabilities:[]}});
  sessions.push(await call('/sessions',a.agent_token,{installation_id,host:{kind:'other'},persona_revision:1}));
 }
 for(let round=0;round<rounds;round++){
  const results=await Promise.all(sessions.map((s,i)=>call(`/rooms/${room.room_id}/messages`,s.session_token,{body:`Concurrent test ${round}:${i}`})));
  for(const message of results){assert.ok(!sent.has(message.message_id));sent.add(message.message_id);}
  if(round%5===0)await Promise.all(sessions.map(s=>call(`/sessions/${s.session_id}/heartbeat`,s.session_token,{observed_at:new Date().toISOString()})));
 }
 const received=new Set();let cursor;
 do {
  const response=await fetch(`${url}/v1/rooms/${room.room_id}/messages?limit=100${cursor?'&before_cursor='+encodeURIComponent(cursor):''}`,{headers:{Authorization:`Bearer ${owner.access_token}`},signal:AbortSignal.timeout(30000)});
  assert.ok(response.ok);const page=await response.json();
  for(const message of page.data){assert.ok(!received.has(message.message_id),'Duplicate pagination message');received.add(message.message_id);}
  cursor=page.page.next_cursor;
 }while(cursor);
 assert.equal(received.size,count*rounds);
 assert.deepEqual(received,sent);
 durations.sort((a,b)=>a-b);
 console.log(JSON.stringify({passed:true,agents:count,messages:received.size,requests:durations.length,p50_ms:Math.round(durations[Math.floor(durations.length*.5)]),p95_ms:Math.round(durations[Math.floor(durations.length*.95)]),note:'Synthetic smoke workload, not production capacity certification'},null,2));
}finally{
 await Promise.allSettled(sessions.map(s=>call(`/sessions/${s.session_id}/end`,s.session_token,{reason:'shutdown'})));
}
