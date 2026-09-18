import test from 'node:test';
import assert from 'node:assert/strict';
import {encode} from 'cbor-x';
import {readFileSync} from 'node:fs';
import {readVideoMetadata,createMetadataEnricher} from '../src/media-metadata.js';

function box(type,...payloads){const b=Buffer.concat([Buffer.alloc(8),...payloads]);b.writeUInt32BE(b.length);b.write(type,4,4,'ascii');return b;}
function jumb(name,...children){return box('jumb',box('jumd',Buffer.alloc(16),Buffer.from([3]),Buffer.from(name+'\0')),...children);}
function mp4(actions){return Buffer.concat([box('ftyp',Buffer.from('isom')),box('uuid',Buffer.from('d8fec3d61b0e483c92975828877ec481','hex'),Buffer.alloc(4),Buffer.from('manifest\0'),Buffer.alloc(8),jumb('c2pa',jumb('urn:c2pa:test',jumb('c2pa.assertions',jumb('c2pa.actions.v2',box('cbor',encode({actions})))))))]);}
const action={action:'c2pa.created',parameters:{model_name:'test-model'},softwareAgent:{name:'provider'}};
test('only explicit unambiguous creation model records are used; never infer a final prompt',()=>{
  const bytes=mp4([action]),result=readVideoMetadata(bytes);
  assert.equal(result.model,'test-model');assert.equal(result.signature_verified,false);
  assert.equal(result.final_prompt,undefined);
  assert.equal(readVideoMetadata(mp4([action,action])),null);
  assert.equal(readVideoMetadata(mp4([{...action,parameters:{requested_model:'test-model'}}])),null);
  assert.equal(readVideoMetadata(mp4([{...action,action:'c2pa.edited'}])),null);
  assert.equal(readVideoMetadata(Buffer.from('model_name=test-model')),null);
  assert.equal(readVideoMetadata(bytes.subarray(0,bytes.length-1)),null);
  const p=JSON.stringify({video:{src:'data:video/mp4;base64,'+bytes.toString('base64')},effective_model:null,prompt:'agent request'});
  const enriched=createMetadataEnricher()({probe_id:'a',presentation_json:p});
  assert.equal(enriched.presentation_json,p);assert.equal(enriched.media_metadata.model,'test-model');
});
test('existing generated video has a Seedance model record',{skip:!process.env.LOVART_PROBE_TEST_VIDEO},()=>{
  const result=readVideoMetadata(readFileSync(process.env.LOVART_PROBE_TEST_VIDEO));
  assert.equal(result.model,'doubao-seedance-2-0');
  assert.equal(result.software_agent,'Volcengine_Ark_CN');
  assert.equal(result.created_at,'2026-09-17T05:23:24.000Z');
});
