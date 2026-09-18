import test from 'node:test';
import assert from 'node:assert/strict';
import {cardPrompt,promptView} from '../src/prompt-display.js';

test('display hides model and aspect settings while retaining visual composition',()=>{
  const p={prompt:'模型：MJ v8.2\nWide 16:9 film still, distant eye-level camera. No cropped legs. --ar 16:9 --v 8.2',requested_model:'MJ v8.2'};
  assert.equal(cardPrompt(p),'Wide film still, distant eye-level camera. No cropped legs.');
  assert.match(p.prompt,/--ar 16:9 --v 8.2$/);
  assert.equal(cardPrompt({...p,prompt:'使用 MJ v8.2 模型生成图片；宽高比：16:9，校园全景。'}),'校园全景。');
  assert.equal(cardPrompt({...p,prompt:'Model: MJ v8.2; Portrait, aspect ratio 9:16, soft daylight.'}),'Portrait, soft daylight.');
  assert.equal(cardPrompt({...p,prompt:'Landscape. --aspect 7:5'}),'Landscape.');
});

test('quoted scene text, URLs and unrelated numbers remain visible',()=>{
  const prompt='Wide 16:9 film still. A sign reads "MJ v8.2  16:9". Another reads ‘1:1’. At 16:09, an 18-year-old uses a 50mm lens. https://example.test/16:9 --ar 16:9';
  const visible=cardPrompt({prompt,requested_model:'MJ v8.2'});
  assert.ok(visible.includes('"MJ v8.2  16:9"'));
  assert.ok(visible.includes('‘1:1’'));
  assert.ok(visible.includes('At 16:09, an 18-year-old uses a 50mm lens.'));
  assert.ok(visible.includes('https://example.test/16:9'));
  assert.equal(visible.startsWith('Wide film still.'),true);
});

test('view transformation preserves saved original prompt and metadata and is idempotent',()=>{
  const p={prompt:'Agent wrapper: original with --ar 16:9',display_prompt:'Wide 16:9 film still. --ar 16:9',requested_model:'MJ v8.2'};
  const data={probe_id:'card',prompt:p.prompt,presentation_json:JSON.stringify(p)};
  const view=promptView(data),shown=JSON.parse(view.presentation_json);
  assert.equal(view.prompt,'Wide film still.');
  assert.equal(shown.display_prompt,view.prompt);
  assert.equal(shown.prompt,p.prompt);
  assert.equal(shown.requested_model,p.requested_model);
  assert.equal(data.presentation_json,JSON.stringify(p));
  assert.deepEqual(promptView(view),view);
  assert.equal(cardPrompt({prompt:null}),null);
});
