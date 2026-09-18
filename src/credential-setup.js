import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {validateCredentials,saveMacCredentials} from './credential-store.js';
export {validateCredentials} from './credential-store.js';

const root=new URL('../',import.meta.url);
const pagePath=fileURLToPath(new URL('ui/credentials.html',root));
const writerPath=fileURLToPath(new URL('scripts/save-lovart-credentials.ps1',root));

// Keys travel over stdin, never command-line arguments, logs or tool results.
export function saveWindowsCredentials(input,{validateOnly=false}={}) {
  const keys=validateCredentials(input);
  if(process.platform!=='win32') return Promise.reject(new Error('WINDOWS_REQUIRED'));
  return new Promise((resolve,reject)=>{
    const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child=spawn(executable,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass',
      '-File',writerPath,...(validateOnly?['-ValidateOnly']:[])],{windowsHide:true,stdio:['pipe','ignore','ignore']});
    const timer=setTimeout(()=>{child.kill();reject(new Error('CREDENTIAL_SAVE_UNCONFIRMED'));},30000);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('CREDENTIAL_SAVE_FAILED'));});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('CREDENTIAL_SAVE_FAILED'));});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(keys));
  });
}

export async function saveCredentials(input,{
  platform=process.platform,saveWindows=saveWindowsCredentials,saveMac=saveMacCredentials,
}={}) {
  const keys=validateCredentials(input);
  if(platform==='win32')return saveWindows(keys);
  if(platform==='darwin')return saveMac(keys);
  throw new Error('CREDENTIAL_PLATFORM_UNSUPPORTED');
}

export function createCredentialSetup({save,ttlMs=15*60*1000,closeDelayMs=1000,unref=true,platform=process.platform}={}) {
  const writer=save??(input=>saveCredentials(input,{platform}));
  let active=null,lastState='idle',starting=null;
  function status(){return {status:active?.state??lastState,expires_at:active?new Date(active.expires).toISOString():null};}
  function close(state='closed') {
    if(!active) return;
    const current=active;active=null;lastState=state;clearTimeout(current.timer);clearTimeout(current.shutdown);
    current.token=null;current.server.close();current.server.closeAllConnections();
  }
  async function open() {
    if(!save&&!['win32','darwin'].includes(platform))throw new Error('网页密钥配置目前支持 Windows 和 macOS。');
    if(active&&Date.now()<active.expires&&active.state==='awaiting_input') return {...status(),url:active.url};
    if(active?.state==='saving') return status();
    close();
    const template=readFileSync(pagePath,'utf8');
    const session={token:randomBytes(32).toString('base64url'),expires:Date.now()+ttlMs,state:'awaiting_input'};
    const server=createServer(async(req,res)=>{
      const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
        'X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'};
      const json=(code,message)=>{res.writeHead(code,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(message));};
      if(req.headers.host!==session.host) return json(403,{error:'此链接只能在本机打开。'});
      if(active!==session||Date.now()>=session.expires) return json(410,{error:'配置链接已失效，请在 Codex 中重新获取。'});
      if(req.method==='GET'&&req.url==='/setup') {
        const nonce=randomBytes(16).toString('base64');
        res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8',
          'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`});
        return res.end(template.replaceAll('__PAGE_NONCE__',nonce).replace('__EXPIRES_AT__',String(session.expires)));
      }
      if(req.method!=='POST'||req.url!=='/save') return json(404,{error:'页面不存在。'});
      if(req.headers.origin!==session.origin||!['same-origin',undefined].includes(req.headers['sec-fetch-site'])) return json(403,{error:'请从配置网页保存。'});
      const supplied=Buffer.from(String(req.headers['x-setup-token']??'')),expected=Buffer.from(session.token??'');
      if(!expected.length||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)) return json(403,{error:'配置链接已失效，请在 Codex 中重新获取。'});
      if(session.state!=='awaiting_input') return json(409,{error:'密钥正在保存或已经保存，请勿重复提交。'});
      if(req.headers['content-type']!=='application/json') return json(415,{error:'提交格式不正确。'});
      let keys;
      try {
        const chunks=[];let length=0;
        for await(const chunk of req){length+=chunk.length;if(length>8192){json(413,{error:'密钥内容过长。'});return;}chunks.push(chunk);}
        keys=validateCredentials(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }catch{return json(400,{error:'请填写完整的 AK 和 SK，密钥中不能包含空格或换行。'});}
      // Re-check after reading: another request may have saved/expired in the meantime.
      if(active!==session||Date.now()>=session.expires) return json(410,{error:'配置链接已失效，请重新获取。'});
      if(session.state!=='awaiting_input') return json(409,{error:'密钥正在保存，请勿重复提交。'});
      session.state='saving';
      try {
        await writer(keys);
        session.state='saved';lastState='saved';session.token=null;
        json(200,{saved:true,message:'已保存。Lovart 下次调用会自动读取新密钥，无需重启 Codex。'});
        clearTimeout(session.timer);
        session.shutdown=setTimeout(()=>{if(active===session)close('saved');},closeDelayMs);session.shutdown.unref();
      }catch{
        if(active===session)session.state='awaiting_input';
        json(500,{error:'未能确认保存成功，请稍后重试。'});
      }finally{keys=null;}
    });
    session.server=server;
    server.requestTimeout=10000;server.headersTimeout=10000;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    session.host=`127.0.0.1:${server.address().port}`;session.origin=`http://${session.host}`;
    session.url=`${session.origin}/setup#token=${session.token}`;
    active=session;lastState='awaiting_input';
    const expire=()=>{
      if(active!==session)return;
      // Let an already accepted write finish and report its result before closing.
      if(session.state==='saving'){session.timer=setTimeout(expire,1000);session.timer.unref();}
      else close('expired');
    };
    session.timer=setTimeout(expire,ttlMs);session.timer.unref();
    if(unref)server.unref();
    return {...status(),url:session.url};
  }
  function start(){if(!starting)starting=open().finally(()=>{starting=null;});return starting;}
  return {start,status,close};
}
