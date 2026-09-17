// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {spawn} = require('node:child_process');
const directory = process.env.XGC2_OFFLINE_TEST_BUILD;
if (!directory) throw new Error('Run web/offline-tests/run.cjs');
const s = require(path.join(directory,'cjs/state.js'));
const c = require(path.join(directory,'cjs/capture.js'));
const sha = 'a'.repeat(64), base = 1700000000000000000n;
function fixture() {
  const asset = {path:`assets/${sha}.json`,sha256:sha,size:100};
  return {schema:'xgc2.video-snapshot',version:1,bagStartNs:String(base),
    recipe:{source:{cameraTopic:'/image'},interval:{startNs:'0',endNs:'100000000'},output:{width:3840,height:2160,fps:30}},
    policy:{maxFrameAgeNs:'100000000',tfLookaheadNs:'100000000'},events:asset,
    topics:[{name:'/info',schemaName:'sensor_msgs/CameraInfo'}],rendererConfig:{},
    cameraFrames:[{sourceFrameId:'0',logTimeNs:String(base),cameraTimeNs:String(base),width:3840,height:2160,format:'png',asset,
      header:{frame_id:'optical',stamp:{sec:1700000000,nsec:0}}}]};
}
function plan(n=0) { return {snapshotSha256:sha,frameIndex:n,targetTimeNs:String(BigInt(n)*1000000000n/30n),sourceFrameId:'0',cameraTimeNs:String(base),width:3840,height:2160}; }
test('native-side selection validates the indexed frame rather than echoing the host',()=>{
  const f=s.parseSnapshot(fixture());assert.equal(s.selectFrame(f,plan(2),sha).sourceFrameId,'0');
});
for (const changed of [{frameIndex:-1},{frameIndex:3},{targetTimeNs:'1'},{sourceFrameId:'wrong'},{cameraTimeNs:'1'},{width:1920},{snapshotSha256:'b'.repeat(64)}]) {
  test(`refuse mismatched plan ${JSON.stringify(changed)}`,()=>assert.throws(()=>s.selectFrame(fixture(),{...plan(),...changed},sha)));
}
test('shuffled target requests reproduce the same camera mapping',()=>{
  const f=fixture();for(const n of [2,0,1,2,1,0]) assert.equal(s.selectFrame(f,plan(n),sha).cameraTimeNs,String(base));
});
test('source gap and timestamp reset fail',()=>{
  const f=fixture();f.policy.maxFrameAgeNs='1';assert.throws(()=>s.selectFrame(f,plan(1),sha),/gap/);
  const g=fixture();g.cameraFrames.push({...g.cameraFrames[0],sourceFrameId:'other'});assert.throws(()=>s.parseSnapshot(g),/increasing/);
});
test('event validator rejects undeclared schemas, mesh assets, role mismatch and time disorder',()=>{
  const row={timeNs:'1',role:'data',event:{topic:'/info',schemaName:'sensor_msgs/CameraInfo',message:{},receiveTime:{sec:0,nsec:1},sizeInBytes:1}};
  assert.equal(s.parseEvents([row],fixture().topics).length,1);
  assert.throws(()=>s.parseEvents([{...row,role:'tf'}],fixture().topics));
  assert.throws(()=>s.parseEvents([row,{...row,timeNs:'0'}],fixture().topics));
  assert.throws(()=>s.parseEvents([{...row,event:{...row.event,schemaName:'unknown'}}],fixture().topics));
  assert.throws(()=>s.parseEvents([{...row,event:{...row.event,schemaName:'visualization_msgs/Marker',message:{type:10}}}], [{name:'/info',schemaName:'visualization_msgs/Marker'}]));
});
test('RGBA row orientation flips once and validates buffer dimensions',()=>{
  const pixels=Uint8Array.from([1,2,3,4, 5,6,7,8]);
  assert.deepEqual(Array.from(c.flipRows(pixels,1,2)),[5,6,7,8,1,2,3,4]);
  for(const [w,h] of [[0,2],[-1,2],[2,2],[1.5,2],[20000,1]]) assert.throws(()=>c.flipRows(pixels,w,h));
});
test('GPU readback restores pack and framebuffer state even on error',()=>{
  const keys=['READ_FRAMEBUFFER_BINDING','PIXEL_PACK_BUFFER_BINDING','PACK_ALIGNMENT','PACK_ROW_LENGTH','PACK_SKIP_ROWS','PACK_SKIP_PIXELS'];
  const values=new Map(keys.map(k=>[k,k+'-initial']));
  const gl={drawingBufferWidth:1,drawingBufferHeight:2,isContextLost:()=>false,getParameter:k=>values.get(k),
    bindFramebuffer:(_,v)=>values.set('READ_FRAMEBUFFER_BINDING',v),bindBuffer:(_,v)=>values.set('PIXEL_PACK_BUFFER_BINDING',v),
    pixelStorei:(k,v)=>values.set(k,v),finish:()=>{},readPixels:(_x,_y,_w,_h,_fmt,_type,buffer)=>buffer.set([1,2,3,4,5,6,7,8]),
    getError:()=>0,NO_ERROR:0};for(const k of keys)gl[k]=k;
  assert.deepEqual(Array.from(c.readFramePixels(gl,1,2)),[5,6,7,8,1,2,3,4]);
  for(const k of keys)assert.equal(values.get(k),k+'-initial');
  gl.getError=()=>1;assert.throws(()=>c.readFramePixels(gl,1,2),/readback/);
  for(const k of keys)assert.equal(values.get(k),k+'-initial');
});
test('actual Chromium WebGL2 3840x2160 readback and persistent canvas', {skip:!process.env.XGC2_CHROMIUM,timeout:20000},async t=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'xgc2-gl-test-'));
  t.after(()=>fs.rm(profile,{recursive:true,force:true}));
  const html=`<!doctype html><body><script type="module">
  import {readFramePixels} from '/capture.js';
  try {
    const canvas=document.createElement('canvas');canvas.width=3840;canvas.height=2160;
    const gl=canvas.getContext('webgl2',{antialias:false});if(!gl)throw Error('WebGL2 unavailable');
    gl.clearColor(0,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0,1080,3840,1080);gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.disable(gl.SCISSOR_TEST);
    const pixels=readFramePixels(gl,3840,2160);
    const top=Array.from(pixels.slice(0,4));const bottom=Array.from(pixels.slice(-4));
    if(String(top)!=='255,0,0,255'||String(bottom)!=='0,0,255,255')throw Error('Incorrect orientation '+top+' '+bottom);
    const out=document.createElement('canvas');out.width=3840;out.height=2160;
    const ctx=out.getContext('2d');ctx.putImageData(new ImageData(pixels,3840,2160),0,0);
    gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);
    if(String(Array.from(ctx.getImageData(0,0,1,1).data))!=='255,0,0,255')throw Error('Capture changed with renderer');
    document.body.textContent='PASS:4K-WebGL2-readback';
  } catch(error){document.body.textContent='FAIL:'+error.message;}
  </script>`;
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/capture.js'){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(directory,'esm/capture.js')));}
    else {res.setHeader('Content-Type','text/html');res.end(html);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}/`;
  const child=spawn(process.env.XGC2_CHROMIUM,['--headless','--no-sandbox','--disable-dev-shm-usage',
    '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run',
    '--disable-background-networking','--user-data-dir='+profile,'--virtual-time-budget=5000','--dump-dom',url]);
  t.after(()=>child.kill('SIGKILL'));
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr=(stderr+b).slice(-8000));
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,stderr);assert.match(stdout,/PASS:4K-WebGL2-readback/,stdout+stderr);
});

test('offline TF window retains long experiments without the live two-second cutoff',()=>{
  const h=require(path.join(directory,'cjs/history.js'));
  function row(stamp,child='robot') {return {timeNs:String(stamp),role:'tf',event:{message:{transforms:[{child_frame_id:child,
    header:{stamp:{sec:Number(stamp/1000000000n),nsec:Number(stamp%1000000000n)}}}]}}};}
  const bounds={maxStorageTime:600000000000n,maxCapacityPerFrame:76800};
  const history=Array.from({length:420},(_,n)=>row(base+BigInt(n)*1000000000n));
  h.validateTransformHistory(history,bounds);
  assert.throws(()=>h.validateTransformHistory([row(base),row(base+600000000000n)],bounds),/window/);
});
test('TF capacity and canonical frame aliases cannot silently trim history',()=>{
  const h=require(path.join(directory,'cjs/history.js'));
  const row=(stamp,child)=>({timeNs:String(stamp),role:'tf',event:{message:{transforms:[{child_frame_id:child,header:{stamp:{sec:0,nsec:stamp}}}]}}});
  assert.throws(()=>h.validateTransformHistory([row(1,'/robot'),row(2,'robot')],{maxStorageTime:100n,maxCapacityPerFrame:2}),/capacity/);
  assert.throws(()=>h.validateTransformHistory([{...row(1,'robot'),role:'tf-static'},row(2,'robot')],{maxStorageTime:100n,maxCapacityPerFrame:4}),/mix/);
});
test('latched static TF old timestamp remains valid',()=>{
  const h=require(path.join(directory,'cjs/history.js'));
  h.validateTransformHistory([{timeNs:String(base),role:'tf-static',event:{message:{transforms:[
    {child_frame_id:'camera',header:{stamp:{sec:0,nsec:1}}},
  ]}}}],{maxStorageTime:600000000000n,maxCapacityPerFrame:76800});
});

test('interactive preview shares the offline query channel',()=>{
  const i=require(path.join(directory,'cjs/interactive.js'));
  assert.equal(i.interactivePreviewEnabled('?xgcTfHistorySeconds=600&xgcInteractive=1'),true);
  assert.equal(i.interactivePreviewEnabled('?xgcInteractive=1&xgcTfHistorySeconds=600'),true);
  assert.equal(i.interactivePreviewEnabled('?xgcTfHistorySeconds=600'),false);
  assert.equal(i.interactivePreviewEnabled('?xgcInteractive=0'),false);
  assert.equal(i.interactivePreviewEnabled('?xgcInteractive=true'),false);
  assert.equal(i.interactivePreviewEnabled(''),false);
});
test('DPR=1 capture requirement is relaxed only for interactive frames',()=>{
  const i=require(path.join(directory,'cjs/interactive.js'));
  i.requireCapturePixelRatio(1,false);
  i.requireCapturePixelRatio(1,true);
  i.requireCapturePixelRatio(1.25,true);
  i.requireCapturePixelRatio(2,true);
  assert.throws(()=>i.requireCapturePixelRatio(1.25,false),/devicePixelRatio=1/);
  assert.throws(()=>i.requireCapturePixelRatio(2,false),/devicePixelRatio=1/);
});
test('interactive scrub failure does not taint; strict capture still taints',()=>{
  const i=require(path.join(directory,'cjs/interactive.js'));
  assert.equal(i.taintsOnFrameError(true),false);
  assert.equal(i.taintsOnFrameError(false),true);
});
