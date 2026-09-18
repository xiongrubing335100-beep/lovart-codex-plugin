import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeToolResult} from '../src/tool-result.js';

test('accepts structured and text-only host envelopes without accepting clipped JSON', () => {
  const data={contract_version:'1',probe_id:'card-id',prompt:'Exact prompt'};
  assert.deepEqual(decodeToolResult({structuredContent:data}),data);
  assert.deepEqual(decodeToolResult({content:[{type:'text',text:JSON.stringify(data)}]}),data);
  assert.deepEqual(decodeToolResult({structuredContent:JSON.stringify(data)}),data);
  assert.equal(decodeToolResult({content:[{type:'text',text:'{"contract_version":"1", [truncated]'}]}),null);
  assert.equal(decodeToolResult({isError:true,structuredContent:data}),null);
});
