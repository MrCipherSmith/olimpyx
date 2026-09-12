import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base=process.env.OLIMPYX_URL||'http://127.0.0.1:4300';
async function call(path,token,body){
 const r=await fetch(`${base}/v1${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','Idempotency-Key':randomUUID(),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 assert.ok(r.ok,`${path}: ${r.status}`);return (await r.json()).data;
}
// A cold CPU model can become ready after the API starts.
let ready=false;
for(let attempt=0;attempt<60;attempt++){
 const health=await fetch(`${base}/health/ready`,{signal:AbortSignal.timeout(10000)});
 if(health.ok&&(await health.json()).embedding==='available'){ready=true;break;}
 await new Promise(resolve=>setTimeout(resolve,2000));
}
assert.ok(ready,'Real embedding provider did not become ready within two minutes');
const id=randomUUID();
const owner=await call('/owners/register',null,{email:`semantic-${id}@example.test`,password:`Test-${id}`,display_name:'Semantic verifier'});
const ticket=await call('/owners/me/enrollment-tokens',owner.access_token,{});
const agent=await call('/agents/enroll',null,{enrollment_token:ticket.enrollment_token,installation_id:id,profile:{name:'Semantic verifier',role:'research',bio:'Multilingual search test',interests:[],capabilities:[]}});
const session=await call('/sessions',agent.agent_token,{installation_id:id,host:{kind:'other'},persona_revision:1});
try{
 const bootstrap=await call('/bootstrap',session.session_token);
 assert.equal(bootstrap.embedding.status,'available','Start the real embeddings profile first');
 const relevant=await call('/knowledge/cards',session.session_token,{topic:'Кошки',summary:'Домашние животные',body:'Кошки — домашние животные. Они мурлыкают, играют и ловят мышей.',sources:[],references:[]});
 await call('/knowledge/cards',session.session_token,{topic:'Реляционная база данных',summary:'Индексы SQL',body:'Индексы PostgreSQL ускоряют выполнение SQL запросов к таблицам базы данных.',sources:[],references:[]});
 const matches=await call('/knowledge/cards?search=semantic&q='+encodeURIComponent('Какое домашнее животное мурлычет и охотится на мышей?'),session.session_token);
 assert.equal(matches[0].card_id,relevant.card_id,'Real semantic ranking should rank the related Russian card first');
 console.log('PASS: real multilingual embeddings stored in pgvector and Russian semantic query ranks the related card first.');
}finally{await call(`/sessions/${session.session_id}/end`,session.session_token,{reason:'shutdown'});}
