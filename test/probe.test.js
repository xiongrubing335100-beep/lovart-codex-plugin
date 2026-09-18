import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProbeStore } from '../src/store.js';
import { URI } from '../src/server.js';

test('counter deduplication and prompt survive reopening the SQLite database', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lovart-probe-'));
  let store = new ProbeStore(dir);
  try {
    const a = store.create('A', '原始\n提示词 <script>no execution</script>');
    assert.equal(store.create('A', a.prompt).probe_id, a.probe_id);
    assert.throws(() => store.create('A', 'changed'), /NONCE_CONFLICT/);
    const key = randomUUID();
    const first = store.bump(a.probe_id, key);
    assert.deepEqual(store.bump(a.probe_id, key), first);
    const b = store.create('B', 'different');
    assert.throws(() => store.bump(b.probe_id, key), /REQUEST_CONFLICT/);
    assert.equal(store.get(b.probe_id).count, 0);
    store.close(); store = new ProbeStore(dir);
    assert.equal(store.get(a.probe_id).prompt, a.prompt);
    assert.equal(store.get(a.probe_id).count, 1);
    assert.equal(store.bump(a.probe_id, key).count, 1);
    assert.equal(store.bump(a.probe_id, randomUUID()).count, 2);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

async function connect(dir) {
  const root = process.env.LOVART_PROBE_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'dist/server.mjs')], cwd: root,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      LOVART_PROBE_STATE_DIR: dir }, stderr: 'pipe' });
  const client = new Client({ name: 'probe-protocol-test', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try { await client.connect(transport); }
  catch (error) { throw new Error(`${error.message}\n${stderr}`); }
  return client;
}
test('real stdio protocol exposes the resource and app-only callbacks; two processes deduplicate', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lovart-protocol-'));
  const clients = [];
  try {
    const a = await connect(dir); clients.push(a);
    const tools = (await a.listTools()).tools;
    assert.ok(tools.some(t=>t.name==='lovart_generate'));
    assert.ok(tools.some(t=>t.name==='lovart_run_execute'));
    assert.ok(tools.every(t=>t.name.startsWith('lovart_')));
    assert.deepEqual(tools.find(t=>t.name==='lovart_card_save_as')._meta.ui.visibility,['app']);
    assert.equal(tools.some(t => t.name === 'probe_export_media'),false);
    assert.equal(tools.find(t => t.name === 'lovart_display')._meta.ui.resourceUri, URI);
    assert.deepEqual(tools.find(t => t.name === 'lovart_card_bump')._meta.ui.visibility, ['app']);
    const resources = await a.listResources();
    assert.ok(resources.resources.some(r => r.uri === URI));
    const resource = (await a.readResource({ uri: URI })).contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.ok(resource.text.includes('ui/initialize'));
    assert.ok(!resource.text.includes('/* BUNDLE */'));
    const invalid = await a.callTool({ name: 'lovart_card_create', arguments: { nonce: '', prompt: 'x' } });
    assert.equal(invalid.isError, true);
    const made = await a.callTool({ name: 'lovart_card_create', arguments: { nonce: 'nonce-a', prompt: '协议测试 A' } });
    const id = made.structuredContent.probe_id;
    const b = await connect(dir); clients.push(b);
    const args = { probe_id: id, request_id: randomUUID() };
    const clicks = await Promise.all([a, b].map(c => c.callTool({ name: 'lovart_card_bump', arguments: args })));
    assert.equal(clicks[0].structuredContent.count, 1);
    assert.equal(clicks[1].structuredContent.count, 1);
    assert.equal(clicks[0].structuredContent.correlation_id, clicks[1].structuredContent.correlation_id);
    await a.close(); clients.splice(clients.indexOf(a), 1);
    const c = await connect(dir); clients.push(c);
    for (const legacyUri of ['ui://lovart-ui-probe/card.html','ui://lovart-ui-probe/card-20260916-r3.html','ui://lovart-ui-probe/card-20260917-r12.html','ui://lovart-ui-probe/card-20260918-r18.html']) {
      const oldResource=(await c.readResource({uri:legacyUri})).contents[0];
      assert.equal(oldResource.uri,legacyUri);
      assert.equal(oldResource.text,resource.text);
    }
    const restored = await c.callTool({ name: 'lovart_display', arguments: { probe_id: id } });
    assert.equal(restored.structuredContent.count, 1);
    assert.equal(restored.structuredContent.nonce, 'nonce-a');
    const missing = await c.callTool({ name: 'lovart_card_get', arguments: { probe_id: randomUUID() } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /PROBE_NOT_FOUND/);
    const draftInput={prompt:'Persist this exact prompt\n原文',project_id:'project-test',media_type:'image'};
    const draftKey=randomUUID();
    const saved=await c.callTool({name:'lovart_run_save',arguments:{request_id:draftKey,input:draftInput}});
    assert.equal(saved.structuredContent.run.status,'draft');
    const repeated=await b.callTool({name:'lovart_run_save',arguments:{request_id:draftKey,input:draftInput}});
    assert.equal(saved.structuredContent.run.run_id,repeated.structuredContent.run.run_id);
    const invalidDraft=await c.callTool({name:'lovart_run_save',arguments:{request_id:randomUUID(),input:{...draftInput,extra:'reject'}}});
    assert.equal(invalidDraft.isError,true);
    assert.deepEqual(tools.find(t=>t.name==='lovart_action_prepare')._meta.ui.visibility,['app']);
  } finally {
    await Promise.all(clients.map(c => c.close()));
    await rm(dir, { recursive: true, force: true });
  }
});
