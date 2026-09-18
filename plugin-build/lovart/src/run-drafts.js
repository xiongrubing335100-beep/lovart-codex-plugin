import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { decodePresentation } from './presentation.js';
import { agentRequest } from './generation-input.js';

const text = z.string().min(1).max(20000);
const reference = z.object({asset_id:z.string().min(1).max(200),order:z.number().int().min(0),
 role:z.enum(['reference','source_image']),
 src:z.string().max(12_000_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/),
}).strict();
export const RunInput = z.object({
 prompt:text,project_id:z.string().min(1).max(200),media_type:z.enum(['image','video']),
 requested_model:z.string().min(1).max(200).nullable().default(null),
 execution_instructions:z.string().min(1).max(5000).optional(),
 requested_params:z.object({aspect_ratio:z.string().regex(/^\d{1,3}:\d{1,3}$/).optional(),
  resolution:z.string().min(1).max(40).optional(),duration_seconds:z.number().positive().max(300).optional()}).strict().default({}),
 reasoning_mode:z.enum(['fast','thinking']).nullable().default(null),
 prefer_models:z.object({IMAGE:z.array(z.string().min(1).max(200)).max(5).optional(),VIDEO:z.array(z.string().min(1).max(200)).max(5).optional()}).strict().default({}),
 include_tools:z.array(z.string().min(1).max(200)).max(16).default([]),
 attachment_urls:z.array(z.string().url()).max(12).default([]),
 references:z.array(reference).max(12).default([]),
}).strict().superRefine((v,ctx)=>{
 if(v.references.some((r,i)=>r.order!==i))ctx.addIssue({code:'custom',message:'References must have consecutive order starting at zero'});
 if(v.references.reduce((n,r)=>n+r.src.length,0)>16_000_000)ctx.addIssue({code:'custom',message:'Reference snapshot exceeds 16 MB'});
});
export function canonical(value) {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
const hash = value=>createHash('sha256').update(canonical(value)).digest('hex');
export const RunView = z.object({
 run_id:z.string().uuid(),action:z.enum(['generate','recreate','edit','animate']),status:z.literal('draft'),
 revision:z.number().int().nonnegative(),source_card_id:z.string().uuid().nullable(),parent_run_id:z.string().uuid().nullable(),
 input_hash:z.string(),created_at:z.string(),context_strategy:z.literal('fresh'),generated:z.literal(false),
 input:RunInput.innerType().extend({original_prompt:text,submitted_prompt:z.string().min(1).max(26000),
  references:z.array(reference.omit({src:true}).extend({sha256:z.string()}))}),
}).strict();

export class RunDrafts {
 constructor(store){
  this.store=store;this.db=store.db;
  this.db.exec('BEGIN IMMEDIATE');
  try {
   this.db.exec('CREATE TABLE IF NOT EXISTS run_schema(version INTEGER NOT NULL)');
   const version=this.db.prepare('SELECT version FROM run_schema').get();
   if(version && version.version!==1)throw new Error('UNSUPPORTED_RUN_SCHEMA');
   if(!version)this.db.exec('INSERT INTO run_schema VALUES(1)');
   this.db.exec(`CREATE TABLE IF NOT EXISTS run_drafts(
    run_id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, input_hash TEXT NOT NULL,
    action TEXT NOT NULL, source_card_id TEXT, parent_run_id TEXT,
    input_json TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS card_runs(card_id TEXT PRIMARY KEY,run_id TEXT NOT NULL);`);
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 get(id){const r=this.db.prepare('SELECT * FROM run_drafts WHERE run_id=?').get(id);if(!r)throw new Error('RUN_NOT_FOUND');return {...r,input:JSON.parse(r.input_json)};}
 view(id){
  const r=this.get(id), {references,...input}=r.input;
  return {run_id:r.run_id,action:r.action,status:r.status,revision:r.revision,source_card_id:r.source_card_id,
   parent_run_id:r.parent_run_id,input_hash:r.input_hash,created_at:r.created_at,context_strategy:'fresh',
   input:{...input,original_prompt:input.prompt,submitted_prompt:agentRequest(input),references:references.map(({src,...ref})=>({...ref,sha256:createHash('sha256').update(Buffer.from(src.split(',')[1],'base64')).digest('hex')}))},
   generated:false};
 }
 save(requestId,input,{action='generate',sourceCardId=null,parentRunId=null}={}){
  z.string().uuid().parse(requestId);const parsed=RunInput.parse(input);
  const digest=hash({input:parsed,action,sourceCardId,parentRunId});
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const old=this.db.prepare('SELECT run_id,input_hash FROM run_drafts WHERE request_id=?').get(requestId);
   if(old && old.input_hash!==digest)throw new Error('IDEMPOTENCY_CONFLICT');
   const runId=old?.run_id??randomUUID();
   if(!old)this.db.prepare('INSERT INTO run_drafts VALUES(?,?,?,?,?,?,?, ?,0,?)').run(runId,requestId,digest,action,sourceCardId,parentRunId,JSON.stringify(parsed),'draft',new Date().toISOString());
   this.db.exec('COMMIT');return this.view(runId);
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 prepare({request_id,probe_id,action,prompt,project_id,requested_model=null}){
  const card=this.store.get(probe_id),p=decodePresentation(card.presentation_json);
  if(!p)throw new Error('CARD_HAS_NO_REAL_IMAGE');
  const parent=this.db.prepare('SELECT run_id FROM card_runs WHERE card_id=?').get(probe_id)?.run_id??null;
  if(action==='recreate'){
   if(!parent)throw new Error('ORIGINAL_INPUT_MISSING');
   return this.save(request_id,this.get(parent).input,{action,sourceCardId:probe_id,parentRunId:parent});
  }
  if(p.video)throw new Error('VIDEO_ACTION_NOT_SUPPORTED');
  if(!['edit','animate'].includes(action))throw new Error('INVALID_ACTION');
  return this.save(request_id,{prompt,project_id,requested_model,media_type:action==='animate'?'video':'image',
   references:[{asset_id:probe_id,order:0,role:'source_image',src:p.image.src}]},
   {action,sourceCardId:probe_id,parentRunId:parent});
 }
 cardActions(id){return {version:1,recreate:!!this.db.prepare('SELECT 1 FROM card_runs WHERE card_id=?').get(id),mode:'draft_only'};}
 // Internal association only. A provider result adapter must establish ownership
 // before linking; the browser cannot assert that an arbitrary image belongs to a run.
 linkVerifiedResult(cardId,runId){this.store.get(cardId);this.get(runId);this.db.prepare('INSERT INTO card_runs VALUES(?,?)').run(cardId,runId);}
}

// Test-only adapter: never registered as a generation tool and never emits images.
export class FakeProvider {
 constructor(){this.received=[];}
 submit(input){this.received.push(structuredClone(input));return {accepted:true,simulated:true};}
}
