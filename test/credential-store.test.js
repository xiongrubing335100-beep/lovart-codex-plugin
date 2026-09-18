import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync,chmodSync,statSync,symlinkSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {macCredentialsDirectory,readMacCredentials,saveMacCredentials} from '../src/credential-store.js';
import {saveCredentials,createCredentialSetup} from '../src/credential-setup.js';
import {resolveLovartEnv} from '../src/lovart-cli.js';

const first={access_key:'fake-first-AK',secret_key:'fake-first-SK'};
const second={access_key:'fake-second-AK',secret_key:'fake-second-SK'};
function sandbox(t) {
  const home=mkdtempSync(path.join(tmpdir(),'lovart-credentials-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  return {directory:macCredentialsDirectory(home)};
}

test('macOS store retains a complete pair across replacements and a fresh process',t=>{
  const options=sandbox(t);
  const env={LOVART_ACCESS_KEY:'old-AK',LOVART_SECRET_KEY:'old-SK',PATH:'unchanged'};
  const loader={platform:'darwin',readMac:()=>readMacCredentials(options)};
  assert.equal(readMacCredentials(options),null);
  assert.deepEqual(resolveLovartEnv(env,loader),env);
  saveMacCredentials(first,options);
  assert.deepEqual(readMacCredentials(options),first);
  assert.equal(resolveLovartEnv(env,loader).LOVART_SECRET_KEY,first.secret_key);
  saveMacCredentials(second,options);
  const resolved=resolveLovartEnv(env,loader);
  assert.equal(resolved.LOVART_ACCESS_KEY,second.access_key);
  assert.equal(resolved.LOVART_SECRET_KEY,second.secret_key);
  assert.equal(resolved.PATH,env.PATH);
  assert.equal(env.LOVART_ACCESS_KEY,'old-AK');
  assert.deepEqual(readdirSync(options.directory),['keys.json']);
  const moduleUrl=new URL('../src/credential-store.js',import.meta.url).href;
  // Only fake values are used; the child reports a boolean, never stored keys.
  const output=execFileSync(process.execPath,['--input-type=module','-e',
    `import {readMacCredentials} from ${JSON.stringify(moduleUrl)}; const pair=readMacCredentials({directory:process.argv[1]}); process.stdout.write(String(pair.access_key==='fake-second-AK'&&pair.secret_key==='fake-second-SK'));`,options.directory],{encoding:'utf8'});
  assert.equal(output,'true');
});

test('invalid replacement leaves the previous pair intact; invalid stored content never falls back to stale keys',t=>{
  const options=sandbox(t);saveMacCredentials(first,options);
  for(const bad of [{access_key:'only'},{...second,secret_key:'bad key'},{...second,secret_key:'x'.repeat(2049)}])assert.throws(()=>saveMacCredentials(bad,options));
  assert.deepEqual(readMacCredentials(options),first);
  const filename=path.join(options.directory,'keys.json');
  writeFileSync(filename,'corrupt-fake-secret');
  assert.throws(()=>resolveLovartEnv({LOVART_ACCESS_KEY:'stale',LOVART_SECRET_KEY:'stale'},
    {platform:'darwin',readMac:()=>readMacCredentials(options)}),error=>/配置lovart的密钥/.test(error.message)&&!error.message.includes('corrupt-fake-secret'));
  saveMacCredentials(second,options);assert.deepEqual(readMacCredentials(options),second);
});

test('macOS private directory and file permissions are enforced on POSIX',
  {skip:typeof process.getuid!=='function'?'POSIX permissions need macOS/Linux':false},t=>{
    const options=sandbox(t);saveMacCredentials(first,options);
    const filename=path.join(options.directory,'keys.json');
    assert.equal(statSync(options.directory).mode&0o777,0o700);
    assert.equal(statSync(filename).mode&0o777,0o600);
    chmodSync(filename,0o644);assert.throws(()=>readMacCredentials(options));
    saveMacCredentials(second,options);assert.equal(statSync(filename).mode&0o777,0o600);
    chmodSync(options.directory,0o755);assert.throws(()=>readMacCredentials(options));
    saveMacCredentials(first,options);assert.equal(statSync(options.directory).mode&0o777,0o700);
  });

test('macOS store refuses linked directories and linked credential files',
  {skip:process.platform==='win32'?'Symlink test needs POSIX permissions':false},t=>{
    const options=sandbox(t);const outside=path.join(path.dirname(options.directory),'outside');
    mkdirSync(outside,{recursive:true,mode:0o700});
    symlinkSync(outside,options.directory,'dir');
    assert.throws(()=>saveMacCredentials(first,options));assert.deepEqual(readdirSync(outside),[]);
    rmSync(options.directory);saveMacCredentials(first,options);
    const target=path.join(outside,'untouched');writeFileSync(target,'untouched');
    const filename=path.join(options.directory,'keys.json');rmSync(filename);symlinkSync(target,filename);
    assert.throws(()=>saveMacCredentials(second,options));assert.throws(()=>readMacCredentials(options));
    assert.equal(readFileSync(target,'utf8'),'untouched');
  });

test('credential dispatcher keeps Windows separate and rejects unsupported platforms before any write',async()=>{
  const calls=[];const writers={saveWindows:async input=>calls.push(['win32',input]),saveMac:input=>calls.push(['darwin',input])};
  await saveCredentials(first,{platform:'win32',...writers});
  await saveCredentials(second,{platform:'darwin',...writers});
  assert.deepEqual(calls,[['win32',first],['darwin',second]]);
  await assert.rejects(saveCredentials(first,{platform:'linux',...writers}),/UNSUPPORTED/);
  await assert.rejects(saveCredentials({access_key:'only'},{platform:'darwin',...writers}),/INVALID_KEYS/);
  assert.equal(calls.length,2);
});

test('macOS webpage save reaches the persistent store and next Lovart call reads the new pair',async t=>{
  const options=sandbox(t);saveMacCredentials(first,options);
  const setup=createCredentialSetup({platform:'darwin',save:input=>saveCredentials(input,{platform:'darwin',saveMac:keys=>saveMacCredentials(keys,options)})});
  t.after(()=>setup.close());const entry=await setup.start();const url=new URL(entry.url);
  const page=await fetch(url);const html=await page.text();assert.match(html,/⌘V/);assert.match(html,/Ctrl\+V/);
  const response=await fetch(`${url.origin}/save`,{method:'POST',headers:{Origin:url.origin,'Content-Type':'application/json',
    'X-Setup-Token':new URLSearchParams(url.hash.slice(1)).get('token')},body:JSON.stringify(second)});
  assert.equal(response.status,200);assert.ok(!(await response.text()).includes('fake-second'));
  const env=resolveLovartEnv({}, {platform:'darwin',readMac:()=>readMacCredentials(options)});
  assert.equal(env.LOVART_ACCESS_KEY,second.access_key);assert.equal(env.LOVART_SECRET_KEY,second.secret_key);
  assert.equal(setup.status().status,'saved');
});
