import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {installValidation} from '../src/validation.js';
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
