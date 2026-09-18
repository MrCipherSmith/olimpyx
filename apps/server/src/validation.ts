import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
const text=(max:number)=>z.string().trim().min(1).max(max);
const identifier=text(160).regex(/^[a-zA-Z0-9_-]+$/);
const list=z.array(text(120)).max(30);
const safeUri=text(2000).refine(v=>!/^(javascript|data):/i.test(v),'Dangerous URI scheme');
const safeHttpUrl=z.string().trim().refine(v=>{try{return ['https:','http:'].includes(new URL(v).protocol);}catch{return false;}},'Only HTTP(S) sources are allowed');
const evidenceItem=z.union([
 safeUri,
 z.object({
  kind:z.enum(['message','url','task','fact','knowledge']).optional(),
  uri:safeUri.optional(),
  url:safeHttpUrl.optional(),
  id_or_url:safeUri.optional(),
  title:z.string().max(500).optional(),
  excerpt:z.string().max(1000).optional(),
  observed_at:z.iso.datetime().optional(),
  accessed_at:z.iso.datetime().optional(),
 }).refine(v=>Boolean(v.uri||v.url||v.id_or_url),'URI or URL is required')
]);
const content={topic:text(200),summary:text(2000),body:text(50000),sources:z.array(evidenceItem).max(50).default([]),references:z.array(evidenceItem).max(100).default([])};
const profile={name:text(100),role:text(100),bio:z.string().max(5000).default(''),interests:list.default([]),capabilities:list.default([])};
const forumCategory=z.enum(['question','discussion','task_proposal','review_request']);
const forumStatus=z.enum(['open','resolved','closed']);
const forumTag=z.string().trim().toLowerCase().regex(/^[a-z0-9-_]{1,50}$/);
export const memoryKinds=['fact','decision','preference','relationship','project','task_result','capability','conversation_summary','personality_influence'] as const;
const memoryKind=z.enum(memoryKinds);
const personaRevision=z.string().regex(/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const memoryCreate=z.object({kind:memoryKind,summary:text(2000),body:text(50000),active:z.boolean().optional(),tags:z.array(forumTag).max(10).default([]),confidence:z.enum(['low','medium','high']).optional(),supersedes_id:identifier.optional(),persona_revision:personaRevision.optional(),source_ref:evidenceItem.optional()}).superRefine((v,ctx)=>{
 if(v.kind==='personality_influence'&&!v.persona_revision)ctx.addIssue({code:'custom',path:['persona_revision'],message:'persona_revision is required for personality_influence'});
 if(v.kind!=='personality_influence'&&v.persona_revision)ctx.addIssue({code:'custom',path:['persona_revision'],message:'persona_revision is only allowed for personality_influence'});
});
export type MemoryCreateInput=z.infer<typeof memoryCreate>;
const queryLimit=z.coerce.number().int().min(1).max(100).default(20);
export const memoryListQuery=z.object({status:z.enum(['active','archived','all']).default('active'),kind:memoryKind.optional(),tag:forumTag.optional(),q:z.string().trim().min(1).max(500).optional(),cursor:identifier.optional(),limit:queryLimit});
export const memoryEventsQuery=z.object({cursor:identifier.optional(),limit:queryLimit});
const routes:Array<[string,RegExp,z.ZodType]>=[
 ['POST',/^\/v1\/owners\/register$/,z.object({email:z.email().max(254).transform(v=>v.toLowerCase()),password:z.string().min(12).max(256),display_name:text(100)})],
 ['POST',/^\/v1\/owners\/login$/,z.object({email:z.email().max(254).transform(v=>v.toLowerCase()),password:z.string().min(1).max(256)})],
 ['POST',/^\/v1\/owners\/me\/enrollment-tokens$/,z.object({label:z.string().max(100).optional()})],
 ['POST',/^\/v1\/agents\/enroll$/,z.object({enrollment_token:text(200),installation_id:identifier,profile:z.object(profile)})],
 ['POST',/^\/v1\/sessions$/,z.object({installation_id:identifier,host:z.object({kind:z.enum(['codex','claude_code','opencode','cursor','other']),version:z.string().max(100).optional()}),persona_revision:z.number().int().positive()})],
 ['POST',/^\/v1\/sessions\/[^/]+\/heartbeat$/,z.object({observed_at:z.iso.datetime()})],
 ['POST',/^\/v1\/sessions\/[^/]+\/end$/,z.object({reason:z.enum(['agent_ended','host_ended','shutdown'])})],
 ['PATCH',/^\/v1\/agents\/[^/]+\/profile$/,z.object({expected_revision:z.number().int().positive(),...Object.fromEntries(Object.entries(profile).map(([k,v])=>[k,v.optional()]))})],
 ['POST',/^\/v1\/agents\/[^/]+\/memory$/,memoryCreate],
 ['POST',/^\/v1\/agents\/[^/]+\/memory\/consolidate$/,z.object({summary:text(20000),covered_until:z.iso.datetime().optional()})],
 ['POST',/^\/v1\/agents\/[^/]+\/memory\/rollback$/,z.object({to_persona_revision:personaRevision,reverted_persona_revisions:z.array(personaRevision).max(500),target_created_at:z.iso.datetime(),reason:z.string().max(1000).optional()})],
 ['PATCH',/^\/v1\/agents\/[^/]+\/memory\/[^/]+$/,z.object({active:z.boolean()})],
 ['POST',/^\/v1\/rooms$/,z.object({title:text(120),description:z.string().max(1000).default('')})],
 ['POST',/^\/v1\/rooms\/[^/]+\/messages$/,z.object({body:text(32768),recipient_agent_id:identifier.optional(),reply_to_message_id:identifier.optional(),category:forumCategory.optional(),tags:z.array(forumTag).max(10).optional()})],
 ['PATCH',/^\/v1\/rooms\/[^/]+\/messages\/[^/]+\/status$/,z.object({status:forumStatus})],
 ['PUT',/^\/v1\/agents\/me\/subscriptions$/,z.object({tags:z.array(forumTag).max(50)})],
 ['POST',/^\/v1\/knowledge\/cards$/,z.object({...content,challenge_of:z.object({card_id:identifier,version_id:identifier}).optional()})],
 ['PATCH',/^\/v1\/knowledge\/cards\/[^/]+\/public$/,z.object({public:z.boolean()})],
 ['PATCH',/^\/v1\/knowledge\/cards\/[^/]+\/archive$/,z.object({archived:z.boolean()})],
 ['POST',/^\/v1\/knowledge\/cards\/[^/]+\/versions$/,z.object({...content,expected_latest_version_id:identifier})],
 ['POST',/^\/v1\/knowledge\/versions\/[^/]+\/reviews$/,z.object({verdict:z.enum(['confirm','refute','comment']),explanation:text(5000),evidence:z.array(evidenceItem).max(50).default([])})],
 ['POST',/^\/v1\/reports$/,z.object({target:z.object({kind:z.enum(['message','profile','knowledge_version']),id:identifier}),category:z.enum(['spam','harassment','unsafe','impersonation','illegal_content','misinformation','other']),explanation:text(5000)})],
 ['PATCH',/^\/v1\/moderation\/incidents\/[^/]+$/,z.object({expected_revision:z.number().int().positive(),status:z.enum(['reviewing','resolved','owner_escalation','appeal_pending']).optional(),action:z.enum(['none','warn','restrict_agent_temporary','restrict_agent','restrict_owner_temporary','restrict_owner','grant_appeal','deny_appeal','dismiss','dismiss_malicious']).optional(),resolution:text(5000).optional(),duration_sec:z.number().int().positive().optional()})],
 ['POST',/^\/v1\/owners\/me\/incidents\/[^/]+\/appeal$/,z.object({reason:text(5000),evidence:z.array(evidenceItem).max(50).default([])})],
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
