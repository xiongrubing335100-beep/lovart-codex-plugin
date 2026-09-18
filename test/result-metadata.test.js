import test from 'node:test';
import assert from 'node:assert/strict';
import {readResultModel,createResultModelEnricher} from '../src/result-metadata.js';
import {ProbeStore} from '../src/store.js';
import {RunDrafts} from '../src/run-drafts.js';
import {GenerationCards} from '../src/generation-cards.js';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url='https://a.lovart.ai/current.png',other='https://a.lovart.ai/other.png';
const result = (artifacts,fields={}) => ({...fields,items:[{type:'generator',artifacts}]});

test('only explicit, unambiguous effective models belonging to the requested artifact are accepted',()=>{
  assert.equal(readResultModel(result([{content:url,effective_model:'actual-image-model'}]),url),'actual-image-model');
  assert.equal(readResultModel(result([{content:url,metadata:{effective_model:'actual-image-model'}}]),url),'actual-image-model');
  assert.equal(readResultModel(result([{content:url}],{effective_model:'actual-image-model'}),url),'actual-image-model');
  assert.equal(readResultModel(result([{content:url},{content:other}],{effective_model:'not-scoped'}),url),null);
  assert.equal(readResultModel(result([{content:other,effective_model:'other-model'}]),url),null);
  assert.equal(readResultModel(result([{content:url,effective_model:'a',metadata:{effective_model:'b'}}]),url),null);
  assert.equal(readResultModel(result([{content:url,effective_model:'unsafe\nvalue'}]),url),null);
});

test('planning models, request preferences and assistant text never become the actual image model',()=>{
  const data=result([{content:url,model:'planning-model',requested_model:'preferred-model'}],{
    model:'planning-model',prefer_models:{IMAGE:['preferred-model']},include_tools:['named-tool']});
  data.items.unshift({type:'assistant',text:'Generated with model X',effective_model:'assistant-model'});
  assert.equal(readResultModel(data,url),null);
  assert.equal(readResultModel({items:[{type:'generator',name:'artifacts',artifacts:[{type:'image',content:url}]}]},url),null);
});

test('new cards preserve returned actual models; late result metadata enriches old cards without rewriting inputs',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'lovart-result-metadata-')),store=new ProbeStore(dir),drafts=new RunDrafts(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const file=path.join(dir,'image.png');
  writeFileSync(file,Buffer.from('89504e470d0a1a0a','hex'));
  let payload=result([{content:url,effective_model:'actual'}],{thread_id:'thread-1',status:'done',project_id:'project-1',downloaded:[{type:'image',url,local_path:file}]});
  const adapter=new GenerationCards({store,drafts,execute:async()=>payload,stateDir:dir,outputDir:dir});
  const first=await adapter.generate({prompt:'Original',project_id:'project-1',prefer_models:{IMAGE:['preferred']}});
  const firstId=first.cards[0].probe_id;
  assert.equal(JSON.parse(store.get(firstId).presentation_json).effective_model,'actual');
  delete payload.items[0].artifacts[0].effective_model;
  const second=await adapter.generate({prompt:'Original 2',project_id:'project-1'}),id=second.cards[0].probe_id;
  const original=store.get(id).presentation_json,enrich=createResultModelEnricher(store);
  assert.equal(JSON.parse(enrich(store.get(id)).presentation_json).effective_model,null);
  payload.items[0].artifacts[0].effective_model='later-confirmed';
  const resumed=await adapter.resume('thread-1');assert.equal(resumed.cards[0].probe_id,id);
  assert.equal(JSON.parse(enrich(store.get(id)).presentation_json).effective_model,'later-confirmed');
  assert.equal(store.get(id).presentation_json,original);
  assert.equal(JSON.parse(enrich(store.get(firstId)).presentation_json).effective_model,'actual');
});
