import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {installValidation,memoryEventsQuery,memoryKinds,memoryListQuery} from '../src/validation.js';
test('rejects malformed messages and dangerous source schemes without reflecting content',async()=>{
 const app=Fastify();installValidation(app);
 app.post('/v1/rooms/:id/messages',async req=>req.body);
 app.post('/v1/knowledge/cards',async req=>req.body);
 const blank=await app.inject({method:'POST',url:'/v1/rooms/a/messages',payload:{body:'   '}});
 assert.equal(blank.statusCode,400);
 const source=await app.inject({method:'POST',url:'/v1/knowledge/cards',payload:{topic:'x',summary:'x',body:'x',sources:[{url:'javascript:alert(1)'}]}});
 assert.equal(source.statusCode,400);
 const good=await app.inject({method:'POST',url:'/v1/rooms/a/messages',payload:{body:'hello'}});
 assert.equal(good.statusCode,200);assert.equal(good.json().body,'hello');
 await app.close();
});
test('memory write schemas normalize defaults and tie persona_revision to influences',async()=>{
 const app=Fastify();installValidation(app);
 for(const path of ['/v1/agents/:id/memory','/v1/agents/:id/memory/consolidate','/v1/agents/:id/memory/rollback'])app.post(path,async req=>req.body);
 app.get('/v1/agents/:id/memory',async req=>req.query);
 const post=(url:string,payload:unknown)=>app.inject({method:'POST',url,payload});
 const rev='1789000000000-0f6e2a4c-1b2d-4e5f-8a9b-0c1d2e3f4a5b';
 assert.equal(memoryKinds.length,9);
 for(const kind of memoryKinds){const r=await post('/v1/agents/a/memory',{kind,summary:'s',...(kind==='personality_influence'?{persona_revision:rev}:{})});assert.equal(r.statusCode,200,kind);}
 const minimal=await post('/v1/agents/a/memory',{kind:'fact',summary:'  s  ',tags:['Postgres']});
 assert.deepEqual(minimal.json(),{kind:'fact',summary:'s',body:'',tags:['postgres']});
 assert.equal((await post('/v1/agents/a/memory',{kind:'capability_observation',summary:'s'})).statusCode,400);
 assert.equal((await post('/v1/agents/a/memory',{kind:'personality_influence',summary:'s'})).statusCode,400);
 assert.equal((await post('/v1/agents/a/memory',{kind:'fact',summary:'s',persona_revision:rev})).statusCode,400);
 assert.equal((await post('/v1/agents/a/memory',{kind:'personality_influence',summary:'s',persona_revision:'not-a-revision'})).statusCode,400);
 assert.equal((await post('/v1/agents/a/memory',{kind:'fact',summary:'s',tags:Array.from({length:11},(_,i)=>`t${i}`)})).statusCode,400);
 assert.equal((await post('/v1/agents/a/memory',{kind:'fact',summary:'s',body:'x'.repeat(50001)})).statusCode,400);
 assert.equal((await post('/v1/agents/a/memory/consolidate',{summary:'digest'})).statusCode,200);
 assert.equal((await post('/v1/agents/a/memory/consolidate',{summary:'digest',covered_until:'yesterday'})).statusCode,400);
 assert.equal((await post('/v1/agents/a/memory/rollback',{to_persona_revision:rev,reverted_persona_revisions:[rev],target_created_at:'2026-09-18T12:00:00.000Z'})).statusCode,200);
 assert.equal((await post('/v1/agents/a/memory/rollback',{to_persona_revision:rev,reverted_persona_revisions:[rev]})).statusCode,400);
 // GET query parameters are validated by the handlers, not by the body-only hook.
 assert.equal((await app.inject({method:'GET',url:'/v1/agents/a/memory?limit=500&status=bogus'})).statusCode,200);
 await app.close();
});
test('memory query schemas default to active records and bound the page size',()=>{
 assert.deepEqual(memoryListQuery.parse({}),{status:'active',limit:20});
 assert.deepEqual(memoryListQuery.parse({status:'all',kind:'decision',tag:'Search',q:' fts ',cursor:'mem_1',limit:'100'}),{status:'all',kind:'decision',tag:'search',q:'fts',cursor:'mem_1',limit:100});
 for(const bad of [{limit:'0'},{limit:'101'},{limit:'2.5'},{status:'false'},{kind:'capability_observation'},{q:'   '},{cursor:'mem 1'}])assert.equal(memoryListQuery.safeParse(bad).success,false,JSON.stringify(bad));
 assert.deepEqual(memoryEventsQuery.parse({}),{limit:20});
 assert.equal(memoryEventsQuery.safeParse({limit:'101'}).success,false);
});
