import { spawn } from 'node:child_process';
import { Presentation } from './presentation.js';

export const dialogScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Windows.Forms
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$owner = New-Object System.Windows.Forms.Form
try {
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.Opacity = 0
  $owner.Show()
  $dialog.Title = 'Save Lovart media'
  $dialog.FileName = $payload.name
  $dialog.DefaultExt = $payload.extension
  $dialog.Filter = 'Media file (*.' + $payload.extension + ')|*.' + $payload.extension
  $dialog.AddExtension = $true
  $dialog.OverwritePrompt = $true
  $dialog.CheckPathExists = $true
  $dialog.RestoreDirectory = $true
  if ($dialog.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) {
    $result = @{cancelled=$true}
  } else {
    $bytes = [Convert]::FromBase64String($payload.base64)
    $stream = $dialog.OpenFile()
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    $result = @{cancelled=$false;saved_path=$dialog.FileName;bytes=$bytes.Length}
  }
  [Console]::Out.Write(($result | ConvertTo-Json -Compress))
} finally { $dialog.Dispose(); $owner.Dispose() }
`;

export function showSaveDialog(payload) {
  if (process.platform !== 'win32') throw new Error('SAVE_DIALOG_REQUIRES_WINDOWS');
  return new Promise((resolve,reject) => {
    const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(dialogScript,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('另存为窗口等待超时，请重试'));},300000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0) return reject(new Error('系统另存为失败：'+stderr.slice(0,400)));
      try {resolve(JSON.parse(stdout));}catch {reject(new Error('系统另存为未返回有效结果'));}
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createMediaSaver(store, showDialog=showSaveDialog) {
  let pending=false;
  return async probeId => {
    if(pending) throw new Error('另存为窗口已打开，请先完成或取消');
    const record=store.get(probeId);
    if(!record.presentation_json) throw new Error('没有可保存的媒体');
    const presentation=Presentation.parse(JSON.parse(record.presentation_json));
    if(presentation.source==='test_fixture') throw new Error('测试卡片没有真实结果');
    const media=presentation.video??presentation.image;
    const [header,base64]=media.src.split(',');
    const mime=header.slice(5,header.indexOf(';'));
    const extension={'video/mp4':'mp4','image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];
    if(!extension) throw new Error('不支持的媒体类型');
    pending=true;
    try {return {contract_version:'1',...await showDialog({name:'lovart-result.'+extension,extension,base64})};}
    finally {pending=false;}
  };
}
