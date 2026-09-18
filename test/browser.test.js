import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolutionLabels } from '../src/resolution-labels.js';

// A simulated host in a real browser. Passing this is NOT a native Codex gate pass.
test('browser harness: actual bridge calls reach stdio, text is safe, remount restores counter', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lovart-browser-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const client = new Client({ name: 'browser-harness', version: '1.0.0' });
  let browser, server;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, 'dist/server.mjs')], cwd: root,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LOVART_PROBE_STATE_DIR: dir }, stderr: 'pipe' }));
    let initial = await client.callTool({ name: 'lovart_card_create', arguments: {
      nonce: 'browser-A', prompt: '<script>window.INJECTED=true</script>\n浏览器组件测试（不是 Codex 验收）' } });
    const card = await readFile(path.join(root, 'dist/card.html'));
    const host = `<!doctype html><html><body style="margin:0"><iframe title="probe" src="/card" style="width:100%;height:900px;border:0"></iframe><script>
      const frame=document.querySelector('iframe');
      const send=m=>frame.contentWindow.postMessage({jsonrpc:'2.0',...m},location.origin);
      addEventListener('message',async e=>{
        if(e.source!==frame.contentWindow || e.origin!==location.origin) return;
        const m=e.data;
        if(m.method==='ui/initialize') send({id:m.id,result:{protocolVersion:m.params.protocolVersion,
          hostInfo:{name:'TEST-HARNESS-NOT-CODEX',version:'1'},hostCapabilities:{serverTools:{},...(location.search.includes('no-download')?{}:{downloadFile:{}}),message:{text:{}}},
          hostContext:{theme:'dark',displayMode:'inline',availableDisplayModes:['inline','fullscreen']}}});
        else if(m.method==='ui/notifications/initialized') {
          const initial=await(await fetch('/initial')).json();
          send({method:'ui/notifications/tool-input',params:{arguments:{probe_id:initial.structuredContent.probe_id}}});
          send({method:'ui/notifications/tool-result',params:location.search.includes('input-only')?{content:[{type:'text',text:'[host omitted oversized result]'}]}:initial});
        }
        else if(m.method==='ui/message'){window.sentMessages??=[];window.sentMessages.push(m.params);send({id:m.id,result:{isError:!!window.rejectMessage}});}
        else if(m.method==='ui/download-file'){window.lastDownload=m.params;send({id:m.id,result:{isError:!!window.rejectDownload}});}
        else if(m.method==='ui/request-display-mode'){window.requestedMode=m.params.mode;send({id:m.id,result:{mode:window.rejectPreview?'inline':m.params.mode}});}
        else if(m.method==='ui/notifications/size-changed'){
          window.cardSizes??=[];window.cardSizes.push(m.params);
          frame.style.height=m.params.height+'px';
        }
        else if(m.method==='tools/call'){
          if(m.params.name==='lovart_card_save_as') {
            window.saveRequests??=[];window.saveRequests.push(m.params.arguments);
            send({id:m.id,result:{structuredContent:{contract_version:'1',cancelled:!window.acceptSave,saved_path:window.acceptSave?'C:/chosen/video.mp4':undefined}}});return;
          }
          if(m.params.name==='lovart_card_get' && location.search.includes('flaky')) {
            window.readAttempts=(window.readAttempts??0)+1;
            if(window.readAttempts<=2){send({id:m.id,result:{isError:true,content:[{type:'text',text:'server starting'}]}});return;}
          }
          try { const r=await fetch('/call',{method:'POST',body:JSON.stringify(m.params)});const result=await r.json(); if(location.search.includes('input-only')) delete result.structuredContent; send({id:m.id,result}); }
          catch {send({id:m.id,error:{code:-32603,message:'harness failure'}});}
        } else if(m.id!==undefined) send({id:m.id,result:{}});
      });
    </script></body></html>`;
    server = createServer(async (req, res) => {
      try {
        if (req.url === '/card') { res.setHeader('Content-Type','text/html'); res.setHeader('Content-Security-Policy', 'media-src https://a.lovart.ai'); return res.end(card); }
        if (req.url === '/initial') { res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(initial)); }
        if (req.url === '/call' && req.method === 'POST') {
          let body=''; for await (const chunk of req) body+=chunk;
          const input=JSON.parse(body);
          if (!['lovart_card_get','lovart_card_bump','lovart_card_observe','lovart_action_prepare'].includes(input.name)) throw new Error('tool denied');
          const output=await client.callTool(input);
          res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify(output));
        }
        res.setHeader('Content-Type','text/html'); res.end(host);
      } catch {res.writeHead(500);res.end('{}');}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: {width:768,height:960} });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const frame = page.frameLocator('iframe');
    await frame.locator('#bump:not([disabled])').waitFor();
    assert.ok((await frame.locator('#prompt').textContent()).startsWith('<script>'));
    assert.equal(await frame.locator('body').evaluate(()=>window.INJECTED), undefined);
    assert.equal(await frame.locator('#media').evaluate(img=>img.naturalWidth),1080);
    // Size notifications are asynchronous and can arrive after the first render.
    await page.waitForFunction(()=>Array.isArray(window.cardSizes)&&window.cardSizes.length>0);
    // Native previews temporarily hide the conversation. Never persist a zero-size card.
    await page.evaluate(async()=>{
      const frame=document.querySelector('iframe');frame.style.display='none';
      await new Promise(resolve=>setTimeout(resolve,250));frame.style.display='';
    });
    await frame.locator('#media').waitFor({state:'visible'});
    assert.ok((await page.evaluate(()=>window.cardSizes)).every(size=>size.height>0&&size.width>0),'hidden host must not receive a zero card size');
    await frame.locator('#prompt').hover();
    assert.equal(await frame.locator('.media-actions').evaluate(e=>getComputedStyle(e).pointerEvents),'none');
    await frame.locator('.visual').hover();
    assert.equal(await frame.locator('.media-actions').evaluate(e=>getComputedStyle(e).pointerEvents),'auto');
    await frame.locator('#animate').click();
    assert.match(await frame.locator('#notice').textContent(),/动画入口尚未接入/);
    await frame.locator('#edit').click();
    assert.match(await frame.locator('#notice').textContent(),/编辑入口尚未接入/);
    await frame.locator('#download').click();
    await page.waitForFunction(()=>!!window.lastDownload);
    const exported = await page.evaluate(()=>window.lastDownload.contents[0].resource);
    const png = Buffer.from(exported.blob,'base64');
    assert.equal(png.readUInt32BE(16),1033);
    assert.equal(png.readUInt32BE(20),577);
    await page.evaluate(()=>window.rejectDownload=true);
    await frame.locator('#download').click();
    await frame.locator('#notice').filter({hasText:'Codex 下载未完成或已取消'}).waitFor();
    assert.equal((await client.callTool({name:'lovart_card_get',arguments:{probe_id:initial.structuredContent.probe_id}})).structuredContent.count,0);
    assert.equal(await frame.locator('#diagnostics').isVisible(),false);
    assert.match(await frame.locator('#open-preview').evaluate(e=>getComputedStyle(e).cursor),/data:image\/svg\+xml/);
    assert.equal(await frame.locator('#open-preview').evaluate(e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.id;}),'open-preview');
    assert.equal(await frame.locator('#edit').evaluate(e=>getComputedStyle(e).cursor),'pointer');
    assert.equal(await page.evaluate(()=>window.requestedMode),undefined);
    await frame.locator('#open-preview').click({position:{x:100,y:100}});
    await frame.locator('#preview:not([hidden])').waitFor();
    assert.equal(await frame.locator('#preview #bump').count(),1);
    assert.equal(await frame.locator('#preview .reference').count(),3);
    await frame.locator('#preview #edit').click();
    assert.match(await frame.locator('#preview #notice').textContent(),/编辑入口尚未接入/);
    await mkdir(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results/expanded-preview.png')});
    await frame.locator('#close-preview').click();
    await frame.locator('#image-card:not([hidden])').waitFor();
    assert.equal(await frame.locator('.visual .media-actions').count(),1);
    await page.waitForFunction(()=>{
      const iframe=document.querySelector('iframe');
      return Math.abs(iframe.getBoundingClientRect().height-iframe.contentDocument.querySelector('#image-card').getBoundingClientRect().height)<2;
    });
    // Restoring an external media viewer can retain the same card dimensions.
    // A pageshow must still re-publish its height if the host discarded its size.
    const sizesBeforeResume=await page.evaluate(()=>window.cardSizes.length);
    await frame.locator('body').evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.waitForFunction(n=>window.cardSizes.length>n,sizesBeforeResume);
    assert.ok((await page.evaluate(()=>window.cardSizes)).every(size=>size.height>0&&size.width>0));
    await page.evaluate(()=>window.rejectPreview=true);
    await frame.locator('#open-preview').click({position:{x:100,y:100}});
    await frame.locator('#notice').filter({hasText:'预览未能切换'}).waitFor();
    assert.equal(await frame.locator('#preview').isVisible(),false);
    await frame.locator('#diagnostics-toggle').click();
    await frame.locator('#bump').click();
    await frame.locator('#connection-text').filter({hasText:'已验证 · 1'}).waitFor();
    const saved = await client.callTool({name:'lovart_card_get',arguments:{probe_id:initial.structuredContent.probe_id}});
    assert.equal(saved.structuredContent.count,1);
    await frame.locator('#notice').filter({hasText:'诊断消息已发送'}).waitFor();
    assert.equal(await page.evaluate(()=>window.sentMessages.length),1);
    assert.match(await page.evaluate(()=>window.sentMessages[0].content[0].text),/不生成图片/);
    assert.equal(await frame.locator('#bump').isDisabled(),true);
    assert.ok(saved.structuredContent.observations.some(o=>o.event==='bridge_connected'));
    await page.reload();
    await frame.locator('#diagnostics-toggle').click();
    await frame.locator('#connection-text').filter({hasText:'已验证 · 1'}).waitFor();
    for (const width of [480,768,1024]) {
      await page.setViewportSize({width,height:960});
      assert.ok(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await page.setViewportSize({width:768,height:960});
    await mkdir(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results/browser-harness.png'),fullPage:true});
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
    const image = {name:'Actual input',src:imageData,source_url:null};
    const presentation = {version:'1',source:'test_fixture',thread_id:'dynamic-test',prompt:null,
      requested_model:'Do not display as effective',effective_model:null,requested_resolution:null,references:null,image};
    initial = await client.callTool({name:'lovart_card_import',arguments:{nonce:'dynamic-unknown',presentation}});
    assert.equal(initial.isError,undefined);
    await page.reload();
    await frame.locator('#resolution-label').filter({hasText:'1 × 1'}).waitFor();
    assert.equal(await frame.locator('#resolution-spec').isVisible(),false);
    assert.equal(await frame.locator('#model-label').textContent(),'Do not display as effective（请求）');
    assert.equal(await frame.locator('#prompt').textContent(),'生成描述未记录');
    assert.equal(await frame.locator('.references').isVisible(),false);
    assert.equal(await frame.locator('#aspect-label').textContent(),'1:1');
    assert.equal(await frame.locator('#aspect-label').isVisible(),true);
    assert.equal(await frame.locator('#bump').isDisabled(),false);
    await frame.locator('.visual').hover(); await frame.locator('#download').click();
    await page.waitForFunction(()=>!!window.lastDownload);
    assert.equal(await page.evaluate(()=>window.lastDownload.contents[0].resource.blob),imageData.split(',')[1]);
    initial = await client.callTool({name:'lovart_card_import',arguments:{nonce:'dynamic-known',presentation:{...presentation,
      source:'legacy_result',prompt:'使用 MJ v8.2；返回全部原图。提示词：Actual saved prompt\n第二行',display_prompt:'Actual saved prompt\n第二行',effective_model:'Verified model',references:[{...image,name:'First reference'},{...image,name:'Second reference'}]}}});
    await page.reload();
    await frame.locator('#model-label').filter({hasText:'Verified model'}).waitFor();
    assert.equal(await frame.locator('#build-label').isVisible(),false);
    assert.equal(await frame.locator('#diagnostics-toggle').isVisible(),false);
    assert.equal(await frame.locator('.reference-asset').count(),2);
    assert.equal(await frame.locator('.reference-asset').first().getAttribute('alt'),'First reference');
    await page.setViewportSize({width:320,height:960});
    assert.ok(await frame.locator('body').evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'metadata chips must wrap on narrow cards');
    assert.equal(await frame.locator('#aspect-label').isVisible(),true);
    await page.setViewportSize({width:768,height:960});
    await frame.locator('.reference-button').first().click();
    await frame.locator('#reference-dialog[open]').waitFor();
    assert.equal(await frame.locator('#reference-full').getAttribute('src'),imageData);
    assert.equal(await frame.locator('#reference-full').evaluate(e=>getComputedStyle(e).objectFit),'contain');
    assert.equal(await frame.locator('#reference-caption').textContent(),'First reference · 1/2');
    await frame.locator('#reference-next').click();
    assert.equal(await frame.locator('#reference-caption').textContent(),'Second reference · 2/2');
    await frame.locator('#reference-next').press('ArrowLeft');
    assert.equal(await frame.locator('#reference-caption').textContent(),'First reference · 1/2');
    await frame.locator('#reference-close').press('Escape');
    await frame.locator('#reference-dialog').waitFor({state:'hidden'});
    assert.equal(await frame.locator('.reference-button').first().evaluate(e=>e===document.activeElement),true);
    await frame.locator('.reference-button').first().click();
    await frame.locator('#reference-dialog').click({position:{x:3,y:3}});
    await frame.locator('#reference-dialog').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.sentMessages?.length ?? 0),0);

    assert.equal(await frame.locator('#prompt').textContent(),'Actual saved prompt\n第二行');
    await frame.locator('.visual').hover(); await frame.locator('#edit').click();
    await frame.locator('#notice').filter({hasText:'编辑请求已发送'}).waitFor();
    assert.equal(await frame.locator('#action-dialog').count(),0);
    const editMessage=await page.evaluate(()=>window.sentMessages[0]);
    assert.equal(editMessage.role,'user');
    assert.match(editMessage.content[0].text,/使用 Lovart 编辑这张参考图/);
    assert.ok(editMessage.content[0].text.includes(initial.structuredContent.probe_id));
    assert.match(editMessage.content[0].text,/Prompt:/);
    assert.match(editMessage.content[0].text,/暂不提交生成/);
    assert.equal(await frame.locator('#edit').isDisabled(),true);
    await page.evaluate(()=>window.rejectMessage=true);
    await frame.locator('#animate').click();
    await frame.locator('#notice').filter({hasText:'宿主拒绝接收消息'}).waitFor();
    const rejectedAnimation=await page.evaluate(()=>window.sentMessages[1]);
    await page.evaluate(()=>window.rejectMessage=false);
    await frame.locator('#animate').click();
    await frame.locator('#notice').filter({hasText:'动画请求已发送'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.sentMessages[2]),rejectedAnimation);
    assert.match(rejectedAnimation.content[0].text,/模型：Auto/);
    assert.equal(await frame.locator('#animate').isDisabled(),true);
    // Real legacy card: dispatch to Codex even when original inputs need recovery.
    initial = await client.callTool({name:'lovart_card_import',arguments:{nonce:'recreate-real',presentation:{...presentation,source:'legacy_result',prompt:'Original prompt'}}});
    await page.reload();
    await frame.locator('#bump:not([disabled])').waitFor();
    await page.evaluate(()=>window.rejectMessage=true);
    await frame.locator('#bump').click();
    await frame.locator('#notice').filter({hasText:'宿主拒绝接收消息'}).waitFor();
    const rejected = await page.evaluate(()=>window.sentMessages[0]);
    assert.equal(rejected.role,'user');
    assert.match(rejected.content[0].text,/lovart_run_execute/);
    assert.match(rejected.content[0].text,/lovart_display/);
    assert.match(rejected.content[0].text,/缺失必要输入/);
    await page.evaluate(()=>window.rejectMessage=false);
    await frame.locator('#bump').click();
    await frame.locator('#notice').filter({hasText:'重新生成请求已发送'}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.sentMessages[1]),rejected);
    initial = await client.callTool({name:'lovart_display',arguments:{probe_id:initial.structuredContent.probe_id}});
    await page.goto(`http://127.0.0.1:${server.address().port}/?input-only&flaky`);
    await frame.locator('#prompt').filter({hasText:'Original prompt'}).waitFor();
    await frame.locator('#bump:not([disabled])').waitFor();
    assert.equal(await frame.locator('.meta').isVisible(),true);
    assert.equal(await frame.locator('.visual').isVisible(),true);
    assert.equal(await page.evaluate(()=>window.readAttempts),3);
    assert.equal(await page.evaluate(()=>window.sentMessages?.length??0),0);
    assert.equal(await frame.locator('#retry-load').isVisible(),false);

    assert.equal(initial.structuredContent.presentation_pending,true);
    assert.ok(JSON.stringify(initial).length < 5000);
    await page.goto(`http://127.0.0.1:${server.address().port}/?input-only`);
    await frame.locator('#prompt').filter({hasText:'Original prompt'}).waitFor();
    await frame.locator('#bump:not([disabled])').waitFor();
    assert.equal(await frame.locator('#media').getAttribute('src'),imageData);
    assert.equal(await frame.locator('.visual').isVisible(),true);
    await frame.locator('#bump').click();
    await frame.locator('#notice').filter({hasText:'重新生成请求已发送'}).waitFor();
    assert.match(await page.evaluate(()=>window.sentMessages[0].content[0].text),/lovart_display/);

    assert.equal(await frame.locator('#bump').isDisabled(),true);

    if (process.env.LOVART_PROBE_TEST_IMAGE) {
      const png=await readFile(process.env.LOVART_PROBE_TEST_IMAGE);
      const fullImage={name:'Current full-resolution result',src:'data:image/png;base64,'+png.toString('base64'),source_url:null};
      const originalPrompt='Model: MJ v8.2; Wide 16:9 film still, distant eye-level camera. --ar 16:9';
      const imported=await client.callTool({name:'lovart_card_import',arguments:{nonce:'preview-recovery-real-image',presentation:{...presentation,source:'saved_run',prompt:originalPrompt,requested_model:'MJ v8.2',image:fullImage}}});
      assert.equal(JSON.parse(imported.structuredContent.presentation_json).prompt,originalPrompt);
      initial=await client.callTool({name:'lovart_display',arguments:{probe_id:imported.structuredContent.probe_id}});
      await page.goto(`http://127.0.0.1:${server.address().port}/?input-only`);
      await frame.locator('#resolution-label').filter({hasText:`${png.readUInt32BE(16)} × ${png.readUInt32BE(20)}`}).waitFor();
      assert.equal(await frame.locator('#prompt').textContent(),'Wide film still, distant eye-level camera.');
      assert.equal(await frame.locator('#model-label').textContent(),'MJ v8.2（请求）');
      const labels=resolutionLabels(png.readUInt32BE(16),png.readUInt32BE(20));
      assert.equal(await frame.locator('#resolution-spec').textContent(),labels.spec??'');
      assert.equal(await frame.locator('#resolution-spec').isVisible(),!!labels.spec);
      assert.equal(await frame.locator('#aspect-label').textContent(),labels.aspect);
      assert.equal(await frame.locator('#resolution-spec').evaluate(e=>e.previousElementSibling.id),'resolution-label');
      for(let attempt=0;attempt<3;attempt++) {
        await frame.locator('#open-preview').click({position:{x:100,y:100}});
        await frame.locator('#preview:not([hidden])').waitFor();
        await page.evaluate(async()=>{
          const iframe=document.querySelector('iframe');iframe.style.display='none';
          await new Promise(resolve=>setTimeout(resolve,150));iframe.style.display='';
        });
        if(attempt===0) await frame.locator('#close-preview').press('Escape');
        else if(attempt===1) await frame.locator('#close-preview').click();
        else await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{displayMode:'inline'}},location.origin));
        await frame.locator('#image-card:not([hidden])').waitFor();
        await page.waitForFunction(()=>{
          const iframe=document.querySelector('iframe');
          return iframe.getBoundingClientRect().height>100 && Math.abs(iframe.getBoundingClientRect().height-iframe.contentDocument.querySelector('#image-card').getBoundingClientRect().height)<2;
        });
        assert.equal(await frame.locator('#media').evaluate(img=>img.naturalWidth),png.readUInt32BE(16));
        assert.equal(await frame.locator('#download').isEnabled(),true);
        assert.equal(await frame.locator('#prompt').textContent(),'Wide film still, distant eye-level camera.');
      }
      assert.ok((await page.evaluate(()=>window.cardSizes)).every(size=>size.height>0&&size.width>0));
      assert.equal(await page.evaluate(()=>window.sentMessages?.length??0),0);
      await page.screenshot({path:path.join(root,'test-results/preview-return-r21.png'),fullPage:true});
    }

    if (process.env.LOVART_PROBE_TEST_VIDEO) {
      const videoBytes=await readFile(process.env.LOVART_PROBE_TEST_VIDEO);
      const videoSrc=`data:video/mp4;base64,${videoBytes.toString('base64')}`;
      const videoUrl='https://a.lovart.ai/artifacts/agent/test-playback.mp4';
      let failVideo=false;
      await page.route(videoUrl,route=>{
        if (failVideo) return route.abort();
        const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Number(range[2]) : videoBytes.length-1;
        return route.fulfill({status:range?206:200,contentType:'video/mp4',
          headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${videoBytes.length}`}:{})},
          body:videoBytes.subarray(start,end+1)});
      });
      initial=await client.callTool({name:'lovart_card_import',arguments:{nonce:'video-playback',presentation:{
        ...presentation,source:'saved_run',prompt:'Fixed camera, gentle wind',references:[image],
        video:{name:'Generated video',src:videoSrc,source_url:videoUrl},
      }}});
      assert.equal(initial.isError,undefined);
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await frame.locator('#video-media').waitFor({state:'visible'});
      await frame.locator('#video-media').evaluate(v=>new Promise((resolve,reject)=>{
        if(v.readyState>=2) return resolve(); v.onloadeddata=resolve;v.onerror=reject;
      }));
      const metadata=await frame.locator('#video-media').evaluate(v=>({w:v.videoWidth,h:v.videoHeight,d:v.duration,controls:v.controls,autoplay:v.autoplay}));
      assert.ok(metadata.w>0 && metadata.h>0 && metadata.d>0);
      assert.equal(await frame.locator('#resolution-spec').isVisible(),!!resolutionLabels(metadata.w,metadata.h).spec);
      assert.equal(await frame.locator('#aspect-label').textContent(),resolutionLabels(metadata.w,metadata.h).aspect);
      assert.equal(metadata.controls,false);assert.equal(metadata.autoplay,false);
      assert.equal(await frame.locator('#open-preview').isVisible(),false);
      assert.equal(await frame.locator('#edit').isVisible(),false);
      assert.equal(await frame.locator('#animate').isVisible(),false);
      await frame.locator('#video-mute').click();
      await frame.locator('#video-play').click();
      await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.querySelector('video').currentTime>0.1);
      await frame.locator('#video-play').click();
      await frame.locator('#video-seek').fill('40');
      assert.ok(await frame.locator('#video-media').evaluate(v=>Math.abs(v.currentTime/v.duration-0.4)<0.02));
      await frame.locator('#video-speed').click();
      assert.equal(await frame.locator('#video-menu').isVisible(),true);
      await frame.locator('#video-speed').click();
      assert.equal(await frame.locator('#video-menu').isVisible(),false);
      await frame.locator('#video-speed').click();
      await page.keyboard.press('Escape');
      assert.equal(await frame.locator('#video-menu').isVisible(),false);
      await frame.locator('#video-speed').click();
      await frame.locator('#video-time').click();
      assert.equal(await frame.locator('#video-menu').isVisible(),false);
      await frame.locator('#video-speed').click();
      await frame.locator('[data-speed="1.25"]').click();
      assert.equal(await frame.locator('#video-menu').isVisible(),false);
      assert.equal(await frame.locator('#video-media').evaluate(v=>v.playbackRate),1.25);
      await frame.locator('#video-fullscreen').click();
      assert.equal(await frame.locator('.visual').evaluate(v=>document.fullscreenElement===v),true);
      await frame.locator('#video-fullscreen').click();
      assert.equal(await frame.locator('.visual').evaluate(()=>document.fullscreenElement===null),true);
      assert.equal(await frame.locator('#video-media').evaluate(v=>v.paused),true);
      await frame.locator('#download').click();
      await page.waitForFunction(()=>!!window.lastDownload);
      assert.deepEqual(await page.evaluate(()=>window.lastDownload.contents),[{type:'resource_link',uri:videoUrl,name:'lovart-result.mp4',mimeType:'video/mp4'}]);
      await page.evaluate(()=>window.rejectDownload=true);
      await frame.locator('#download').click();
      await frame.locator('#notice').filter({hasText:'Codex 下载未完成或已取消'}).waitFor();
      assert.equal(await frame.locator('#download').isEnabled(),true);
      assert.equal(await page.evaluate(()=>window.sentMessages?.length??0),0);
      await page.screenshot({path:path.join(root,'test-results/video-card.png'),fullPage:true});
      await page.reload();await frame.locator('#video-media').waitFor({state:'visible'});
      assert.equal(await frame.locator('#video-media').getAttribute('src'),videoUrl);
      failVideo=true;
      await page.reload();
      await frame.locator('#retry-video').waitFor({state:'visible'});
      await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.querySelector('#notice').textContent.includes('视频加载失败'));
      assert.match(await frame.locator('#notice').textContent(),/视频加载失败/);
      failVideo=false;
      await frame.locator('#retry-video').click();
      await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.querySelector('video').readyState>=2);
      assert.equal(await frame.locator('#retry-video').isVisible(),false);
      await page.goto(`http://127.0.0.1:${server.address().port}?no-download`);
      await frame.locator('#video-media').waitFor({state:'visible'});
      assert.equal(initial.structuredContent.media_metadata.model,'doubao-seedance-2-0');
      assert.equal(await frame.locator('#model-label').textContent(),'Seedance 2.0（文件记录）');
      await frame.locator('#download').click();
      await frame.locator('#notice').filter({hasText:'已取消保存'}).waitFor();
      assert.equal(await frame.locator('#download').isEnabled(),true);
      await page.evaluate(()=>window.acceptSave=true);
      await frame.locator('#download').click();
      await frame.locator('#notice').filter({hasText:'已保存：C:/chosen/video.mp4'}).waitFor();
      assert.deepEqual(await page.evaluate(()=>window.saveRequests),[{probe_id:initial.structuredContent.probe_id},{probe_id:initial.structuredContent.probe_id}]);
      assert.equal(await page.evaluate(()=>window.sentMessages?.length??0),0);
      assert.equal(await page.evaluate(()=>window.lastDownload),undefined);
      // Text-to-video can return no source image; show the video without a made-up poster.
      initial=await client.callTool({name:'lovart_card_import',arguments:{nonce:'video-no-poster',presentation:{
        ...presentation,source:'saved_run',image:null,references:[],
        video:{name:'No poster video',src:videoSrc,source_url:videoUrl},
      }}});
      assert.equal(initial.isError,undefined);
      await page.reload();
      await frame.locator('#video-media').waitFor({state:'visible'});
      await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.querySelector('video').readyState>=2);
      assert.equal(await frame.locator('#video-media').getAttribute('poster'),null);
      assert.equal(await frame.locator('#download').isEnabled(),true);
    }
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve=>server.close(resolve));
    await client.close();
    await rm(dir,{recursive:true,force:true});
  }
});
