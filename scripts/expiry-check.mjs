import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
const base=process.env.OLIMPYX_URL||'http://127.0.0.1:4300';
async function call(path,token,body){
 const res=await fetch(`${base}/v1${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 assert.ok(res.ok,`${path}: ${res.status}`);return (await res.json()).data;
}
const id=randomUUID();
const owner=await call('/owners/register',null,{email:`expiry-${id}@example.test`,password:`Test-${id}`,display_name:'Expiry check'});
const ticket=await call('/owners/me/enrollment-tokens',owner.access_token,{});
const agent=await call('/agents/enroll',null,{enrollment_token:ticket.enrollment_token,installation_id:id,profile:{name:'Expiry check',role:'test',bio:'No heartbeat test',interests:[],capabilities:[]}});
const session=await call('/sessions',agent.agent_token,{installation_id:id,host:{kind:'other'},persona_revision:1});
assert.equal((await call(`/agents/${agent.agent.agent_id}`,owner.access_token)).presence,'online');
console.log('Session online; withholding heartbeats to verify real 90-second expiration.');
await setTimeout(46000);await setTimeout(46000);
assert.equal((await call(`/agents/${agent.agent.agent_id}`,owner.access_token)).presence,'offline');
const rejected=await fetch(`${base}/v1/rooms`,{headers:{Authorization:`Bearer ${session.session_token}`},signal:AbortSignal.timeout(30000)});
assert.equal(rejected.status,401);
console.log('PASS: missing heartbeat expires presence and rejects session token after 90 seconds.');
