import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProbeStore } from '../src/store.js';
import { Presentation, decodePresentation } from '../src/presentation.js';

export const fixture = {
 version:'1',source:'test_fixture',thread_id:'test-source',prompt:null,
 requested_model:'Requested model',effective_model:null,requested_resolution:null,references:null,
 image:{name:'One pixel',src:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=',source_url:null},
};
test('presentation rejects executable media, unrecognized fields, and preserves unknown metadata',()=>{
 assert.equal(Presentation.parse(fixture).effective_model,null);
 assert.throws(()=>Presentation.parse({...fixture,secret:'not allowed'}));
 assert.throws(()=>Presentation.parse({...fixture,image:{...fixture.image,src:'javascript:alert(1)'}}));
 assert.throws(()=>Presentation.parse({...fixture,image:{...fixture.image,src:'data:image/svg+xml;base64,AAAA'}}));
});
test('additive migration preserves old cards; imported input is immutable and survives reopen',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'lovart-presentation-'));
 let store;
 try {
  const old=new DatabaseSync(path.join(directory,'probe.sqlite'));
  old.exec("CREATE TABLE cards(probe_id TEXT PRIMARY KEY,nonce TEXT UNIQUE NOT NULL,prompt TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0); INSERT INTO cards VALUES('old','old','old prompt',4,4)");old.close();
  store=new ProbeStore(directory);
  assert.equal(store.get('old').count,4);
  const card=store.importPresentation('dynamic',fixture);
  assert.equal(store.importPresentation('dynamic',fixture).probe_id,card.probe_id);
  assert.throws(()=>store.importPresentation('dynamic',{...fixture,prompt:'changed'}),/NONCE_CONFLICT/);
  store.close();store=new ProbeStore(directory);
  assert.deepEqual(decodePresentation(store.get(card.probe_id).presentation_json),fixture);
  assert.equal(store.get('old').prompt,'old prompt');
 } finally {store?.close();await rm(directory,{recursive:true,force:true});}
});

test('video presentation accepts only embedded MP4 and preserves poster and references',()=>{
 const video={name:'Video',src:'data:video/mp4;base64,AAAA',source_url:null};
 assert.deepEqual(Presentation.parse({...fixture,video}).video,video);
 assert.throws(()=>Presentation.parse({...fixture,video:{...video,src:'javascript:alert(1)'}}));
 assert.throws(()=>Presentation.parse({...fixture,video:{...video,src:'https://example.com/video.mp4'}}));
});
