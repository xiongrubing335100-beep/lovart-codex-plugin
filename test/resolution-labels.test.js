import test from 'node:test';
import assert from 'node:assert/strict';
import {resolutionLabels} from '../src/resolution-labels.js';

test('only exact 1K, 2K and 4K sizes get a specification badge',()=>{
  for(const [w,h] of [[1456,816],[816,1456],[1536,1024],[2560,1440],[3072,1728],[7680,4320],[100,100],[1920,1080],[1280,720]]) {
    assert.equal(resolutionLabels(w,h).spec,null);
  }
  assert.equal(resolutionLabels(1024,1024).spec,'1K');
  assert.equal(resolutionLabels(2048,1152).spec,'2K');
  assert.equal(resolutionLabels(2160,3840).spec,'4K');
  assert.equal(resolutionLabels(4096,2048).spec,'4K');
  assert.equal(resolutionLabels(1456,816).size,'1456 × 816');
});

test('aspect ratio supports common sizes, small alignment differences and custom ratios',()=>{
  assert.equal(resolutionLabels(1456,816).aspect,'16:9');
  assert.match(resolutionLabels(1456,816).aspectDescription,/精确宽高比 91:51/);
  assert.equal(resolutionLabels(816,1456).aspect,'9:16');
  assert.equal(resolutionLabels(1280,720).aspect,'16:9');
  assert.equal(resolutionLabels(1080,1920).aspect,'9:16');
  assert.equal(resolutionLabels(1024,1024).aspect,'1:1');
  assert.equal(resolutionLabels(1600,1200).aspect,'4:3');
  assert.equal(resolutionLabels(1500,816).aspect,'125:68');
  assert.equal(resolutionLabels(3840,2160).spec,'4K');
});

test('unloaded or invalid dimensions never produce a specification',()=>{
  for(const [w,h] of [[0,0],[1456,0],[NaN,720],[-1,720],[1920,1080.5]]) {
    assert.equal(resolutionLabels(w,h),null);
  }
});
