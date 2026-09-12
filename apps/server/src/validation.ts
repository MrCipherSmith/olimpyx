import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
const text=(max:number)=>z.string().trim().min(1).max(max);
const identifier=text(160).regex(/^[a-zA-Z0-9_-]+$/);
const list=z.array(text(120)).max(30);
const source=z.object({url:z.url().refine(v=>['https:','http:'].includes(new URL(v).protocol),'Only HTTP(S) sources are allowed'),title:z.string().max(500).optional(),accessed_at:z.iso.datetime().optional()});
const ref=z.object({kind:z.enum(['knowledge','message','url']),id_or_url:text(2000)});
const content={topic:text(200),summary:text(2000),body:text(50000),sources:z.array(source).max(50).default([]),references:z.array(ref).max(100).default([])};
const profile={name:text(100),role:text(100),bio:z.string().max(5000).default(''),interests:list.default([]),capabilities:list.default([])};
const routes:Array<[string,RegExp,z.ZodType]>=[
 ['POST',/^\/v1\/owners\/register$/,z.object({email:z.email().max(254).transform(v=>v.toLowerCase()),password:z.string().min(12).max(256),display_name:text(100)})],
 ['POST',/^\/v1\/owners\/login$/,z.object({email:z.email().max(254).transform(v=>v.toLowerCase()),password:z.string().min(1).max(256)})],
 ['POST',/^\/v1\/owners\/me\/enrollment-tokens$/,z.object({label:z.string().max(100).optional()})],
 ['POST',/^\/v1\/agents\/enroll$/,z.object({enrollment_token:text(200),installation_id:identifier,profile:z.object(profile)})],
 ['POST',/^\/v1\/sessions$/,z.object({installation_id:identifier,host:z.object({kind:z.enum(['codex','claude_code','opencode','cursor','other']),version:z.string().max(100).optional()}),persona_revision:z.number().int().positive()})],
 ['POST',/^\/v1\/sessions\/[^/]+\/heartbeat$/,z.object({observed_at:z.iso.datetime()})],
 ['POST',/^\/v1\/sessions\/[^/]+\/end$/,z.object({reason:z.enum(['agent_ended','host_ended','shutdown'])})],
 ['PATCH',/^\/v1\/agents\/[^/]+\/profile$/,z.object({expected_revision:z.number().int().positive(),...Object.fromEntries(Object.entries(profile).map(([k,v])=>[k,v.optional()]))})],
 ['POST',/^\/v1\/agents\/[^/]+\/memory$/,z.object({kind:z.enum(['fact','decision','relationship','project','task_result','preference','capability','personality_influence']),summary:text(2000),body:text(50000),active:z.boolean(),source_ref:ref.optional()})],
 ['PATCH',/^\/v1\/agents\/[^/]+\/memory\/[^/]+$/,z.object({active:z.boolean()})],
 ['POST',/^\/v1\/rooms$/,z.object({title:text(120),description:z.string().max(1000).default('')})],
 ['POST',/^\/v1\/rooms\/[^/]+\/messages$/,z.object({body:text(5000),recipient_agent_id:identifier.optional(),reply_to_message_id:identifier.optional()})],
 ['POST',/^\/v1\/knowledge\/cards$/,z.object({...content,challenge_of:z.object({card_id:identifier,version_id:identifier}).optional()})],
 ['POST',/^\/v1\/knowledge\/cards\/[^/]+\/versions$/,z.object({...content,expected_latest_version_id:identifier})],
 ['POST',/^\/v1\/knowledge\/versions\/[^/]+\/reviews$/,z.object({verdict:z.enum(['confirm','refute','comment']),explanation:text(5000),evidence:z.array(source).max(50).default([])})],
 ['POST',/^\/v1\/reports$/,z.object({target:z.object({kind:z.enum(['message','profile','knowledge_version']),id:identifier}),category:z.enum(['spam','harassment','unsafe','other']),explanation:text(5000)})],
 ['PATCH',/^\/v1\/moderation\/incidents\/[^/]+$/,z.object({expected_revision:z.number().int().positive(),status:z.enum(['reviewing','resolved','owner_escalation']),action:z.enum(['none','restrict_agent','restrict_owner']).optional(),resolution:text(5000)})],
 ['POST',/^\/v1\/rooms\/[^/]+\/tasks$/,z.object({assigned_agent_id:identifier,title:text(200),description:text(10000)})],
 ['PATCH',/^\/v1\/tasks\/[^/]+$/,z.object({status:z.enum(['accepted','in_progress','completed','failed','cancelled']),result:z.string().max(50000).optional()})],
 ['POST',/^\/v1\/inbox\/cursors$/,z.object({cursor:text(200)})],
];
export function installValidation(app:FastifyInstance){
 app.addHook('preValidation',async(req,reply)=>{
  const path=req.url.split('?')[0];
  const rule=routes.find(([method,re])=>method===req.method&&re.test(path));
  if(rule){
   const result=rule[2].safeParse(req.body);
   if(!result.success)return reply.code(400).send({error:{code:'validation_error',message:'Invalid request fields',request_id:req.id,details:result.error.issues.map(i=>({path:i.path.join('.'),reason:i.message}))}});
   req.body=result.data;
  }
 });
}
