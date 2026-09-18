import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {get} from 'node:http';
import {createCredentialSetup,validateCredentials,saveWindowsCredentials} from '../src/credential-setup.js';
import {resolveLovartEnv} from '../src/lovart-cli.js';
function request(link,body,headers={}) {
  const url=new URL(link);
  return fetch(`${url.origin}/save`,{method:'POST',headers:{'Origin':url.origin,'Content-Type':'application/json',
    'X-Setup-Token':new URLSearchParams(url.hash.slice(1)).get('token'),...headers},body:JSON.stringify(body)});
}
const keys={access_key:'test-AK',secret_key:'test-SK'};

test('local credential page reuses one session, saves both values once and closes',async t=>{
  let stored=null,writes=0;
  const setup=createCredentialSetup({save:async input=>{stored=input;writes++;},closeDelayMs:20});t.after(()=>setup.close());
  const [first,second]=await Promise.all([setup.start(),setup.start()]);
  assert.equal(first.url,second.url);assert.equal(first.status,'awaiting_input');
  const url=new URL(first.url);assert.equal(url.hostname,'127.0.0.1');
  const page=await fetch(first.url),html=await page.text();
  assert.equal(page.headers.get('cache-control'),'no-store');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.ok(!html.includes(keys.secret_key));assert.ok(!html.includes(url.hash.slice(7)));
  const saved=await request(first.url,{access_key:' test-AK ',secret_key:' test-SK '});
  assert.equal(saved.status,200);const response=await saved.text();assert.ok(!response.includes('test-SK'));
  assert.deepEqual(stored,keys);assert.equal(writes,1);assert.equal(setup.status().status,'saved');
  // The existing loader sees new persisted values on its next call, without a restart.
  const env=resolveLovartEnv({LOVART_ACCESS_KEY:'old',LOVART_SECRET_KEY:'old'},
    {platform:'win32',readUserVariable:name=>name==='LOVART_ACCESS_KEY'?stored.access_key:stored.secret_key});
  assert.equal(env.LOVART_ACCESS_KEY,keys.access_key);assert.equal(env.LOVART_SECRET_KEY,keys.secret_key);
  await delay(50);assert.equal(setup.status().status,'saved');
  await assert.rejects(fetch(first.url));assert.equal(writes,1);
});

test('invalid, cross-origin and unauthorized submissions cannot overwrite stored credentials',async t=>{
  let writes=0;const setup=createCredentialSetup({save:async()=>{writes++;}});t.after(()=>setup.close());
  const {url}=await setup.start();
  for(const [body,headers,status] of [
    [keys,{Origin:'https://example.invalid'},403],[keys,{'X-Setup-Token':'wrong'},403],
    [keys,{'Content-Type':'text/plain'},415],[{access_key:'only'}, {},400],
    [{...keys,secret_key:'broken\nkey'},{},400],[{...keys,unexpected:'value'},{},400],
  ]) assert.equal((await request(url,body,headers)).status,status);
  const wrongHost=await new Promise((resolve,reject)=>get(url,{headers:{Host:'example.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
  assert.equal(wrongHost,403);
  assert.equal(writes,0);assert.equal(setup.status().status,'awaiting_input');
});

test('concurrent saving is locked and failure allows an explicit retry without exposing keys',async t=>{
  let release,calls=0;const waiting=new Promise(resolve=>{release=resolve;});
  const setup=createCredentialSetup({save:async()=>{calls++;if(calls===1){await waiting;throw new Error('sensitive test-SK');}},closeDelayMs:50});t.after(()=>setup.close());
  const {url}=await setup.start();const first=request(url,keys);
  for(let attempt=0;setup.status().status!=='saving'&&attempt<100;attempt++)await delay(5);
  assert.equal(setup.status().status,'saving');
  assert.equal((await request(url,keys)).status,409);release();
  const failed=await first;assert.equal(failed.status,500);assert.ok(!(await failed.text()).includes('test-SK'));
  assert.equal(setup.status().status,'awaiting_input');assert.equal((await request(url,keys)).status,200);assert.equal(calls,2);
});

test('expired sessions close and a new configuration request creates a fresh link',async t=>{
  let writes=0;const setup=createCredentialSetup({save:async()=>{writes++;},ttlMs:40});t.after(()=>setup.close());
  const first=await setup.start();await delay(80);assert.equal(setup.status().status,'expired');
  const second=await setup.start();assert.notEqual(first.url,second.url);assert.equal(writes,0);
});

test('writer accepts pasted key text safely over stdin in validation-only mode',async()=>{
  assert.deepEqual(validateCredentials({access_key:' ak_123 ',secret_key:' sk_456 '}),{access_key:'ak_123',secret_key:'sk_456'});
  assert.throws(()=>validateCredentials({...keys,secret_key:' '}));
  assert.throws(()=>validateCredentials({...keys,secret_key:'x'.repeat(2049)}));
  if(process.platform==='win32')await saveWindowsCredentials({access_key:'fake_$()_`_"',secret_key:'fake_\'_secret'},{validateOnly:true});
});
