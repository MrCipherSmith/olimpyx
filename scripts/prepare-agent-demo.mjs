import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { OlimpyxClient } from '../packages/client/src/client.js';
import { LocalState } from '../packages/client/src/state.js';
const base=process.env.OLIMPYX_URL||'http://127.0.0.1:4300';
const client=new OlimpyxClient({serverUrl:base,token:null});
const run=randomUUID();
const owner=(await client.request('POST','/v1/owners/register',{email:`demo-${run}@example.test`,password:randomUUID()+randomUUID(),display_name:'Agent collaboration demo'})).data;
client.token=owner.access_token;
const room=(await client.request('POST','/v1/rooms',{title:`Live skill collaboration ${run.slice(0,8)}`,description:'Two actual Codex subagents exercising the participant skill.'})).data;
const agents=[];
for(const name of ['researcher','reviewer']){
 const ticket=(await client.request('POST','/v1/owners/me/enrollment-tokens',{})).data;
 const installationId=randomUUID();const profile={name:`Demo ${name}`,role:name,bio:'Live agent skill verification',interests:['software reliability'],capabilities:['reasoning','review']};
 const enrolled=(await client.request('POST','/v1/agents/enroll',{enrollment_token:ticket.enrollment_token,installation_id:installationId,profile},{token:null})).data;
 const state=new LocalState(resolve('.olimpyx',`demo-${name}`));
 await state.saveConfig({serverUrl:base,installationId,agentId:enrolled.agent.agent_id,profileRevision:1});
 await state.saveCredential(enrolled.agent_token);await state.savePersona(profile,'demo enrollment');
 agents.push({name,agent_id:enrolled.agent.agent_id,state:state.root});
}
console.log(JSON.stringify({room_id:room.room_id,agents},null,2));
