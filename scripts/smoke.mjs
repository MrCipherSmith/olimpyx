import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base=process.env.OLIMPYX_URL || 'http://127.0.0.1:4300';
async function req(path,{token,method='GET',body,key=randomUUID(),status}={}){
 const res=await fetch(`${base}/v1${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{}),'Idempotency-Key':key},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const json=await res.json();
 if(status) assert.equal(res.status,status,JSON.stringify(json));
 else assert.ok(res.ok,`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
 return json;
}
const run=randomUUID().slice(0,8);
await req('/rooms',{status:401});
const owner=(await req('/owners/register',{method:'POST',body:{email:`test-${run}@example.test`,password:`Local-test-only-${run}!`,display_name:'Integration test'}})).data;
assert.ok(owner.access_token);
async function enroll(name){
 const ticket=(await req('/owners/me/enrollment-tokens',{token:owner.access_token,method:'POST',body:{label:name}})).data;
 const installation_id=randomUUID();
 const agent=(await req('/agents/enroll',{method:'POST',body:{enrollment_token:ticket.enrollment_token,installation_id,profile:{name,role:'tester',bio:'Integration-test agent',interests:['testing'],capabilities:['checks']}}})).data;
 return {...agent,installation_id};
}
async function session(agent){return (await req('/sessions',{token:agent.agent_token,method:'POST',body:{installation_id:agent.installation_id,host:{kind:'other'},persona_revision:1}})).data;}
const a=await enroll('Verifier A'), b=await enroll('Verifier B');
const sa=await session(a);
const room=(await req('/rooms',{token:sa.session_token,method:'POST',body:{title:`Smoke ${run}`,description:'Public integration scenario'}})).data;
const key=randomUUID();
const messageBody={body:'An offline message survives reconnection',recipient_agent_id:b.agent.agent_id};
const first=await req(`/rooms/${room.room_id}/messages`,{token:sa.session_token,method:'POST',body:messageBody,key});
const again=await req(`/rooms/${room.room_id}/messages`,{token:sa.session_token,method:'POST',body:messageBody,key});
assert.equal(first.data.message_id,again.data.message_id);
const sb=await session(b);
const inbox=await req('/inbox/events',{token:sb.session_token});
assert.ok(inbox.data.some(e=>e.resource.id===first.data.message_id),'Offline recipient missing event');
const card=(await req('/knowledge/cards',{token:sa.session_token,method:'POST',body:{topic:'Testing',summary:'Offline persistence',body:'Observed offline delivery',sources:[],references:[]}})).data;
assert.equal(card.latest.status,'unconfirmed');
await req(`/knowledge/versions/${card.latest_version_id}/reviews`,{token:sb.session_token,method:'POST',body:{verdict:'confirm',explanation:'Reproduced offline delivery'}});
const revisions=await req(`/knowledge/cards/${card.card_id}/versions`,{token:sa.session_token});
assert.equal(revisions.data[0].review_counts.confirm,1);
await req(`/agents/${a.agent.agent_id}/memory`,{token:sb.session_token,status:403});
await req(`/sessions/${sb.session_id}/end`,{token:sb.session_token,method:'POST',body:{reason:'shutdown'}});
await req('/rooms',{token:sb.session_token,status:401});
await req(`/sessions/${sa.session_id}/end`,{token:sa.session_token,method:'POST',body:{reason:'shutdown'}});
console.log('PASS: owner enrollment, public auth, offline inbox, idempotency, knowledge reviews, private memory ACL and session shutdown');
