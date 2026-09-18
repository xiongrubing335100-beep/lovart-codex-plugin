import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ProbeStore } from '../src/store.js';
import { RunDrafts,RunInput,RunView,FakeProvider } from '../src/run-drafts.js';
const src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
const input={prompt:'Keep whitespace\n原文 ',project_id:'project-a',media_type:'image',references:[{asset_id:'asset-a',order:0,role:'reference',src}]};
async function setup(fn){const dir=await mkdtemp(path.join(os.tmpdir(),'lovart-drafts-'));const store=new ProbeStore(dir);try{await fn(new RunDrafts(store),store,dir);}finally{store.close();await rm(dir,{recursive:true,force:true});}}
test('snapshot hashing, idempotency and repeated intentional requests',()=>setup((drafts)=>{
 const request=randomUUID(),a=drafts.save(request,input);
 assert.equal(drafts.save(request,{...input,project_id:'project-a'}).run_id,a.run_id);
 assert.throws(()=>drafts.save(request,{...input,prompt:'different'}),/IDEMPOTENCY_CONFLICT/);
 assert.notEqual(drafts.save(randomUUID(),input).run_id,a.run_id);
 assert.notEqual(drafts.save(randomUUID(),{...input,prompt:input.prompt+'\n'}).input_hash,a.input_hash);
 assert.notEqual(drafts.save(randomUUID(),{...input,project_id:'project-b'}).input_hash,a.input_hash);
 assert.equal(a.input.original_prompt,input.prompt);assert.equal(a.input.submitted_prompt,input.prompt);
 assert.equal(a.input.references[0].src,undefined);RunView.parse(a);
 const fake=new FakeProvider(); fake.submit(drafts.get(a.run_id).input);
 assert.deepEqual(fake.received[0],RunInput.parse(input));
}));
test('rejects invalid input before storage and preserves reference order',()=>setup((drafts)=>{
 const fake=new FakeProvider();
 for(const invalid of [{...input,prompt:''},{...input,unknown:1},{...input,media_type:'invalid'},{...input,references:[{...input.references[0],order:1}]}]){
  assert.throws(()=>{const r=drafts.save(randomUUID(),invalid);fake.submit(drafts.get(r.run_id).input);});
 }
 assert.equal(fake.received.length,0);
 const refs=[input.references[0],{...input.references[0],asset_id:'asset-b',order:1}];
 const a=drafts.save(randomUUID(),{...input,references:refs});
 const b=drafts.save(randomUUID(),{...input,references:[{...refs[1],order:0},{...refs[0],order:1}]});
 assert.notEqual(a.input_hash,b.input_hash);
}));
test('source-owned actions, missing original inputs and reopen recovery',()=>setup((drafts,store,dir)=>{
 const card=store.importPresentation('action-card',{version:'1',source:'test_fixture',thread_id:'thread',prompt:null,requested_model:null,effective_model:null,requested_resolution:null,references:null,image:{name:'image',src,source_url:null}});
 const args={probe_id:card.probe_id,request_id:randomUUID(),action:'recreate'};
 assert.throws(()=>drafts.prepare(args),/ORIGINAL_INPUT_MISSING/);
 const original=drafts.save(randomUUID(),input);drafts.linkVerifiedResult(card.probe_id,original.run_id);
 const recreated=drafts.prepare(args);assert.equal(recreated.parent_run_id,original.run_id);assert.deepEqual(recreated.input,original.input);
 const edited=drafts.prepare({...args,request_id:randomUUID(),action:'edit',project_id:'explicit-project',prompt:'Edit it'});
 assert.equal(edited.input.references[0].asset_id,card.probe_id);assert.equal(edited.context_strategy,'fresh');
 const second=new ProbeStore(dir);try{assert.deepEqual(new RunDrafts(second).view(edited.run_id),edited);}finally{second.close();}
}));
test('unknown schema versions are rejected transactionally',()=>setup((drafts,store)=>{
 store.db.exec('UPDATE run_schema SET version=99');
 assert.throws(()=>new RunDrafts(store),/UNSUPPORTED_RUN_SCHEMA/);
 assert.equal(store.db.prepare('SELECT version FROM run_schema').get().version,99);
}));
