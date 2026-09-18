import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProbeStore} from '../src/store.js';
import {RunDrafts} from '../src/run-drafts.js';
import {GenerationCards} from '../src/generation-cards.js';
import {agentRequest} from '../src/generation-input.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const url='https://a.lovart.ai/artifacts/current.png',old='https://a.lovart.ai/artifacts/old.png';
function fixture(t,execute) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'lovart-merge-'));
  const store=new ProbeStore(dir),drafts=new RunDrafts(store),file=path.join(dir,'result.png');
  writeFileSync(file,png);
  const adapter=new GenerationCards({store,drafts,execute,outputDir:dir,stateDir:dir});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const result=(overrides={})=>({thread_id:'thread-new',project_id:'project-1',final_status:'done',
    items:[{artifacts:[{type:'image',content:url}]}],downloaded:[{type:'image',url,local_path:file,new:true}],...overrides});
  return {dir,store,drafts,file,adapter,result};
}

test('generation persists clean inputs, shows current artifacts, restores and recreates exactly once',async t=>{
  const calls=[];let f;
  f=fixture(t,async args=>{calls.push(args);return f.result();});
  f.adapter.rememberUpload(f.file,{url:old});
  const request_id=randomUUID(),input={request_id,prompt:'保持原始提示词。16:9',project_id:'project-1',attachments:[old],
    reasoning_mode:'fast',prefer_models:{IMAGE:['nano_banana_pro']},include_tools:['named-tool']};
  const first=await f.adapter.generate(input);
  assert.equal(first.cards.length,1);assert.equal(first.card_errors,undefined);
  const p=JSON.parse(f.store.get(first.cards[0].probe_id).presentation_json);
  assert.equal(p.prompt,input.prompt);assert.equal(p.effective_model,null);assert.equal(p.requested_model,'nano_banana_pro');
  assert.equal(p.references[0].source_url,old);
  const reopened=new GenerationCards({store:f.store,drafts:f.drafts,execute:async args=>{calls.push(args);return f.result();},outputDir:f.dir,stateDir:f.dir});
  assert.deepEqual(await reopened.generate(input),first);assert.equal(calls.length,1);
  const prepared=f.drafts.prepare({request_id:randomUUID(),probe_id:first.cards[0].probe_id,action:'recreate'});
  const regenerated=await reopened.executeDraft(prepared.run_id);
  assert.equal(regenerated.cards.length,1);assert.notEqual(regenerated.cards[0].probe_id,first.cards[0].probe_id);
  await reopened.executeDraft(prepared.run_id);assert.equal(calls.length,2);
  assert.deepEqual(calls[1],calls[0]);assert.equal(calls[0][calls[0].indexOf('--prompt')+1],input.prompt);
  await assert.rejects(reopened.generate({...input,prompt:'changed'}),/IDEMPOTENCY_CONFLICT/);
});

test('pending confirmation creates no card or second submission; explicit confirm and polls share one card',async t=>{
  const calls=[];let f;
  f=fixture(t,async args=>{calls.push(args);return args[0]==='chat'?f.result({final_status:'pending_confirmation',pending_confirmation:{credits:10}}):f.result();});
  const first=await f.adapter.generate({prompt:'original',project_id:'project-1'});
  assert.equal(first.cards.length,0);assert.equal(calls.length,1);
  const confirmed=await f.adapter.resume('thread-new',true);
  const polled=await f.adapter.resume('thread-new');
  assert.equal(confirmed.cards.length,1);assert.deepEqual(confirmed.cards,polled.cards);
  assert.deepEqual(calls.map(args=>args[0]),['chat','confirm','result']);
});

test('creative prompt, requested version and execution settings survive restart and Recreate separately',async t=>{
  const calls=[];let f;
  f=fixture(t,async args=>{calls.push(args);return f.result();});
  const input={request_id:randomUUID(),project_id:'project-1',
    prompt:' A woman holds a sign reading "MJ v8.2".\nFull body, no cropped legs. --ar 16:9 ',
    requested_model:'MJ v8.2',execution_instructions:'Return all original images without selecting.',
    prefer_models:{IMAGE:['generate_image_midjourney']},include_tools:['generate_image_midjourney']};
  const result=await f.adapter.generate(input),id=result.cards[0].probe_id;
  const presentation=JSON.parse(f.store.get(id).presentation_json);
  assert.equal(presentation.prompt,input.prompt);
  assert.equal(presentation.requested_model,'MJ v8.2');
  assert.equal(presentation.effective_model,null);
  assert.equal(f.adapter.job(input.request_id).input.execution_instructions,input.execution_instructions);
  const recreated=f.drafts.prepare({request_id:randomUUID(),probe_id:id,action:'recreate'});
  assert.equal(recreated.input.original_prompt,input.prompt);
  assert.equal(recreated.input.submitted_prompt,agentRequest(input));
  const restored=new GenerationCards({store:f.store,drafts:f.drafts,execute:async args=>{calls.push(args);return f.result();},outputDir:f.dir,stateDir:f.dir});
  await restored.executeDraft(recreated.run_id);
  assert.deepEqual(calls[1],calls[0]);
  assert.ok(calls[0][calls[0].indexOf('--prompt')+1].endsWith(input.prompt));
  assert.equal(calls[0][calls[0].indexOf('--prefer-models')+1],JSON.stringify(input.prefer_models));
  await restored.executeDraft(recreated.run_id);assert.equal(calls.length,2);
});

test('a friendly model name is never passed as a routing tool alias',async t=>{
  const calls=[];let f;f=fixture(t,async args=>{calls.push(args);return f.result();});
  const draft=f.drafts.save(randomUUID(),{prompt:'Portrait',project_id:'project-1',media_type:'image',requested_model:'MJ v8.2'});
  await f.adapter.executeDraft(draft.run_id);
  assert.equal(calls[0].includes('--prefer-models'),false);
  assert.match(calls[0][calls[0].indexOf('--prompt')+1],/Requested model: MJ v8.2/);
});

test('continuation baseline survives timeout/restart and removes historical downloads',async t=>{
  const calls=[];let f;
  f=fixture(t,async args=>{
    calls.push(args);
    if(args[0]==='chat') return f.result({final_status:'timeout',downloaded:[]});
    return f.result({items:[{artifacts:[{type:'image',content:old}]}],downloaded:[]});
  });
  const request_id=randomUUID();await f.adapter.generate({request_id,prompt:'edit only',project_id:'project-1',thread_id:'thread-new'});
  const restored=new GenerationCards({store:f.store,drafts:f.drafts,outputDir:f.dir,stateDir:f.dir,execute:async()=>f.result({
    items:[{artifacts:[{type:'image',content:old},{type:'image',content:url}]}],
    downloaded:[{type:'image',url:old,local_path:f.file},{type:'image',url,local_path:f.file,new:false}],
  })});
  const result=await restored.resume('thread-new');
  assert.equal(result.cards.length,1);assert.deepEqual(result.downloaded.map(file=>file.url),[url]);
  assert.deepEqual(calls.map(args=>args[0]),['result','chat']);
});

test('an uncertain submission cannot be repeated under the same request id',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;throw new Error('transport lost');});
  const input={request_id:randomUUID(),prompt:'hello'};
  await assert.rejects(f.adapter.generate(input),/Do not resubmit automatically/);
  const retry=await f.adapter.generate(input);assert.equal(retry.status,'submission_unknown');assert.equal(calls,1);
});

test('text-only, failed, unrelated and unsupported results do not become success cards',async t=>{
  let result;const f=fixture(t,async()=>result);
  for(const overrides of [
    {generation_succeeded:false}, {final_status:'abort'}, {items:[]},
    {downloaded:[{type:'image',url,local_path:path.join(f.dir,'missing.png')}]},
  ]) {
    result=f.result(overrides);const out=await f.adapter.generate({prompt:'current'});assert.equal(out.cards.length,0);
  }
});

test('video without a reference has no fabricated poster and remains downloadable',async t=>{
  let f;f=fixture(t,async()=>f.result({items:[{artifacts:[{type:'video',content:url}]}],downloaded:[{type:'video',url,local_path:f.file}]}));
  writeFileSync(f.file,Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]));
  const result=await f.adapter.generate({prompt:'wind',project_id:'project-1'});assert.equal(result.cards.length,1);
  const p=JSON.parse(f.store.get(result.cards[0].probe_id).presentation_json);assert.equal(p.image,null);assert.match(p.video.src,/^data:video\/mp4;base64,/);
});
