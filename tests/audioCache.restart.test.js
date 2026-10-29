'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('LTE recupera audio completo después de reiniciar sin ejecutar el extractor; respeta caché desactivada', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunera-cache-restart-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir, 'example.webm');
  fs.writeFileSync(file, Buffer.alloc(40000, 1));
  const makeProcess = (enabled, online) => {
    let handler;
    let extracted = 0;
    const context = vm.createContext({
      fs,path,console:{log(){},warn(){},error(){}},Date,Math,
      ipcMain:{handle(name,fn){handler=fn;}},
      audioExtractorPreference:'lte',applicationDataGeneration:0,
      currentStream:null,networkAccessEnabled:online,
      sendPlaybackProgress(){},validateMediaUrl(){},requireMainWindowSender(){},
      beginPlaybackResolution(){return new AbortController();},finishPlaybackResolution(){},
      getCacheSettings:async()=>({enabled,maxSizeMB:500}),getAudioCacheDirectory:()=>dir,
      cleanupPartialCacheFiles(){},getVideoId:()=> 'example',AUDIO_CACHE_EXTENSIONS:['webm'],
      getStoredTrackMetadata:async()=>({title:'Saved title',artist:'Saved artist',duration:180}),
      updatePlaybackHistory(){},getStreamingQualityLabel:()=> 'Medium',
      ensureInternetAccess(){if(!online)throw Error('offline');},
      getOrExtractAudio(){extracted++;throw Error('extractor called');}
    });
    vm.runInContext(between('function getPlayableCachePath(', 'async function buildCacheLibrary('),context);
    vm.runInContext(between('async function buildCachedTrackData(', 'function getMemoryStreamCacheKey('),context);
    vm.runInContext(between("ipcMain.handle('stream-song'",'function getCacheSettings('),context);
    return {play:()=>handler({sender:{}},'https://youtube.com/watch?v=example','medium'),calls:()=>extracted};
  };
  for(const online of [true,false]) {
    const restarted = makeProcess(true,online);
    const result = await restarted.play();
    assert.equal(result.path,file);
    assert.equal(result.metadata.title,'Saved title');
    assert.equal(restarted.calls(),0);
  }
  const disabled = makeProcess(false,true);
  await assert.rejects(disabled.play(),/extractor called/);
  assert.equal(disabled.calls(),1);
});

test('La descarga de caché acepta sólo audio completo y rechaza HTTP parcial', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'lunera-cache-download-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const data = Buffer.alloc(40000,5);
  const server = http.createServer((req,res)=>{
    res.writeHead(req.url==='/partial'?206:200,{'content-length':data.length});
    res.end(data);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const context=vm.createContext({http,https,fs,URL,console,buildRequestHeaders:h=>h});
  vm.runInContext(between('function downloadUrlToFile(', 'function cleanupPartialCacheFiles('),context);
  const url=`http://127.0.0.1:${server.address().port}`;
  const file=path.join(dir,'complete.part');
  await context.downloadUrlToFile(url,file);
  assert.deepEqual(fs.readFileSync(file),data);
  await assert.rejects(context.downloadUrlToFile(url+'/partial',path.join(dir,'partial.part')),/206/);
});

test('Limpiar parciales conserva la canción que todavía se descarga', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lunera-cache-partials-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const active=path.join(dir,'active.part');
  const stale=path.join(dir,'stale.part');
  fs.writeFileSync(active,'active');fs.writeFileSync(stale,'stale');
  const context=vm.createContext({fs,path,console,audioCacheJobs:new Map([['song',{writeTargetPath:active}]])});
  vm.runInContext(between('function cleanupPartialCacheFiles(', 'async function cacheExtractedAudio('),context);
  context.cleanupPartialCacheFiles(dir);
  assert.equal(fs.existsSync(active),true);
  assert.equal(fs.existsSync(stale),false);
});
