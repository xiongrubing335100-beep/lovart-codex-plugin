import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaSaver,dialogScript} from '../src/save-dialog.js';
import {execFileSync} from 'node:child_process';

test('Save As passes only saved bytes; cancellation, concurrency and failure release the dialog',async()=>{
  const p={version:'1',source:'saved_run',thread_id:'test',prompt:null,requested_model:null,effective_model:null,requested_resolution:null,references:null,image:{name:'../../bad.png',src:'data:image/png;base64,AQID',source_url:null}};
  let release,payload;
  const save=createMediaSaver({get:()=>({presentation_json:JSON.stringify(p)})}, input=>{payload=input;return new Promise(resolve=>{release=resolve;});});
  const first=save('card');
  assert.deepEqual(payload,{name:'lovart-result.png',extension:'png',base64:'AQID'});
  await assert.rejects(save('card'),/已打开/);
  release({cancelled:true});assert.equal((await first).cancelled,true);
  const second=save('card');release({cancelled:false,saved_path:'chosen.png',bytes:3});assert.equal((await second).saved_path,'chosen.png');
  p.source='test_fixture';await assert.rejects(save('card'),/测试卡片/);
});

test('Windows Save As script parses and loads Forms without opening a dialog',{skip:process.platform!=='win32'},()=>{
  const code=`$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){throw $errors[0]}; Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.SaveFileDialog; $d.Dispose()`;
  execFileSync('powershell.exe',['-NoProfile','-STA','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{input:dialogScript,windowsHide:true,timeout:15000});
});
