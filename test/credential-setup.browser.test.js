import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {createCredentialSetup} from '../src/credential-setup.js';

test('credential web form supports native paste, show/hide, validation and saved state', {timeout:30000},async()=>{
  const received=[];const setup=createCredentialSetup({save:async input=>{received.push(input);}});
  let browser;
  try {
    const {url}=await setup.start();browser=await chromium.launch({channel:'chrome',headless:true});
    const context=await browser.newContext({permissions:['clipboard-read','clipboard-write'],viewport:{width:720,height:850}});
    const page=await context.newPage();const requests=[];
    page.on('request',r=>requests.push(r.url()));await page.goto(url);
    const ak=page.locator('#access-key'),sk=page.locator('#secret-key');
    const modifier=process.platform==='darwin'?'Meta':'Control';
    assert.equal(await ak.getAttribute('type'),'password');assert.equal(await sk.getAttribute('type'),'password');
    await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/credential-setup.png',fullPage:true});
    await page.evaluate(()=>navigator.clipboard.writeText('fake-access-key-for-paste'));
    await ak.focus();await ak.press(`${modifier}+V`);assert.equal(await ak.inputValue(),'fake-access-key-for-paste');
    await page.evaluate(()=>navigator.clipboard.writeText('fake-secret-key-for-paste'));
    await sk.focus();await sk.press(`${modifier}+V`);assert.equal(await sk.inputValue(),'fake-secret-key-for-paste');
    assert.equal(await sk.evaluate(input=>!input.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))),false);
    await page.getByRole('button',{name:'显示 Secret Key',exact:true}).click();assert.equal(await sk.getAttribute('type'),'text');
    await sk.press(`${modifier}+A`);await sk.press(`${modifier}+C`);
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'fake-secret-key-for-paste');
    await page.getByRole('button',{name:'隐藏 Secret Key',exact:true}).click();assert.equal(await sk.getAttribute('type'),'password');
    await sk.fill('bad key');await page.getByRole('button',{name:'保存密钥',exact:true}).click();
    assert.match(await page.locator('#message').textContent(),/不能包含空格/);assert.equal(received.length,0);
    await sk.fill('fake-secret-key-for-paste');await page.getByRole('button',{name:'保存密钥',exact:true}).click();
    await page.locator('#message[data-state=success]').waitFor();
    assert.deepEqual(received,[{access_key:'fake-access-key-for-paste',secret_key:'fake-secret-key-for-paste'}]);
    assert.equal(await ak.inputValue(),'');assert.equal(await sk.inputValue(),'');assert.equal(await page.locator('#save').isDisabled(),true);
    assert.equal(new URL(page.url()).hash,'');
    assert.ok(!await page.locator('body').textContent().then(text=>text.includes('fake-secret-key')));
    assert.ok(requests.every(value=>new URL(value).origin===new URL(url).origin));
    await page.setViewportSize({width:320,height:700});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{await browser?.close();setup.close();}
});
