// Native controls and request hooks run offline; no real account or site is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const filename = path.join(__dirname, 'auth.test.cjs');
const source = fs.readFileSync(filename, 'utf8');
const boundary = source.indexOf("\nfor (const html of ['popup.html'");
assert.notEqual(boundary, -1);
const fixture = new Module(filename, module);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(path.dirname(filename));
fixture._compile(source.slice(0, boundary) + '\nmodule.exports = { harness, PLATFORMS };', filename);
const { harness, PLATFORMS } = fixture.exports;

async function settle() { for (let i = 0; i < 4; i++) await new Promise(setImmediate); }
function refreshFixture(options = {}) {
  const origin = options.origin || 'https://newapi.example.test';
  const platform = {id:'native',authMode:'cookie',baseUrl:origin,userId:'12',visitOnly:true,account:{available:10}};
  const h = harness('background.js', {[PLATFORMS]:[platform]});
  let now = h.run('Date.now()'), next = 1;
  const timers = new Map();
  h.ctx.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
  h.ctx.setTimeout = (fn, ms) => { const id=next++; timers.set(id,{fn,at:now+Number(ms)}); return id; };
  h.ctx.clearTimeout = (id) => timers.delete(id);
  const clock = { async advance(ms) {
    const end=now+ms;
    for (;;) {
      await settle();
      const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at);
      if (!due.length) break;
      const [id,timer]=due[0];timers.delete(id);now=timer.at;timer.fn();
    }
    now=end;await settle();
  } };
  const local = new Map([['user',JSON.stringify({id:12,username:'alice',quota:999999})]]);
  h.ctx.localStorage = {getItem(key) {return local.get(key)??null;}};
  h.ctx.location = {origin,pathname:'/console'};
  h.ctx.getComputedStyle = (el) => ({display:el.hidden?'none':'block',visibility:'visible',opacity:'1'});
  const requests = [];
  class XHR {
    constructor() {this.events=new Map();this.status=0;}
    open(method,url) {this.method=method;this.url=url;}
    send() {requests.push(this);}
    addEventListener(type,fn) {if(!this.events.has(type))this.events.set(type,new Set());this.events.get(type).add(fn);}
    removeEventListener(type,fn) {this.events.get(type)?.delete(fn);}
    respond(body={success:true,data:[]},status=200) {
      this.status=status;this.responseText=typeof body==='string'?body:JSON.stringify(body);
      if(this.onload)this.onload();
      for(const fn of this.events.get('loadend')||[])fn();
    }
  }
  h.ctx.XMLHttpRequest = XHR;
  const original = {open:XHR.prototype.open,send:XHR.prototype.send};
  const element = (extra={}) => ({isConnected:true,getClientRects(){return this.hidden?[]:[{}];},...extra});
  const button = element({clicks:0,disabled:false,loading:false,
    classList:{contains(name){return name==='semi-button-loading'&&button.semiLoading;}},
    getAttribute(name){return name==='aria-disabled'?String(!!this.ariaDisabled):null;},
    querySelector(selector){return selector.includes('aria-label="refresh"')?{}:this.loading?{}:null;},
    click() {
      this.clicks++;this.loading=true;
      const url=(options.admin?'/api/data/':'/api/data/self/')+(options.noTrailingSlash?'':'');
      if(options.fetch) {
        this.completion=h.ctx.window.fetch(options.noTrailingSlash?url.slice(0,-1):url)
          .then(()=>h.ctx.setTimeout(()=>{this.loading=false;},500),()=>{this.loading=false;});
      } else {
        const xhr=new XHR();xhr.open('GET',(options.noTrailingSlash?url.slice(0,-1):url)+'?start_timestamp=1');
        xhr.onload=()=>h.ctx.setTimeout(()=>{this.loading=false;},500);xhr.send();
      }
      const uptime=new XHR();uptime.open('GET','/api/uptime/status');uptime.send();
    },
  });
  const search=element({clicks:0,querySelector(){return null;},getAttribute(){return null;},click(){this.clicks++;}});
  const heading=element({textContent:'Good morning, alice',parentElement:{querySelectorAll(){return [search,button];}}});
  const headings=[heading];
  h.ctx.document={readyState:'complete',querySelectorAll(selector){assert.equal(selector,'h1, h2, h3');return headings;}};
  let releaseFetch;
  const originalFetch=async (url) => {
    requests.push({url,fetch:true});
    return new Promise(resolve=>{releaseFetch=(body={success:true,data:[]},status=200)=>{
      const response={status,text:async()=>typeof body==='string'?body:JSON.stringify(body)};
      response.clone=()=>({...response});resolve(response);
    };});
  };
  h.ctx.window.fetch=originalFetch;
  const cleanup=()=>{
    assert.equal(XHR.prototype.open,original.open);assert.equal(XHR.prototype.send,original.send);
    assert.equal(h.ctx.window.fetch,originalFetch);assert.equal(timers.size,0);
    assert.equal(h.ctx.window.events.get('nacheckin:checkin-stop')?.size||0,0);
    assert.equal(h.ctx.window.events.get('pagehide')?.size||0,0);
    assert.ok(requests.every(xhr=>!xhr.events?.get('loadend')?.size));
  };
  h.ctx.expectedOrigin=origin;
  const run=()=>h.run('tabRefreshNewApiDashboard(expectedOrigin,"12","round")');
  return {h,platform,clock,local,requests,button,heading,headings,search,run,cleanup,XHR,
    releaseFetch:(...args)=>releaseFetch(...args)};
}

for (const admin of [false,true]) {
  test(`native ${admin?'admin':'user'} refresh waits for its statistics response and native loading`,async()=>{
    const f=refreshFixture({admin});let done=false;
    const pending=f.run().then(result=>{done=true;return result;});
    assert.equal(f.button.clicks,1);assert.equal(f.search.clicks,0);
    await f.clock.advance(2000);assert.equal(done,false);
    f.requests[1].respond();await f.clock.advance(100);assert.equal(done,false,'uptime is not a statistics refresh');
    f.requests[0].respond();await f.clock.advance(400);assert.equal(done,false,'native loading has not finished');
    await f.clock.advance(100);assert.equal((await pending).ok,true);
    assert.equal(f.button.clicks,1);assert.equal(f.h.reloaded.length,0);assert.equal(f.h.updates.length,0);
    assert.equal(JSON.parse(f.local.get('user')).quota,999999);f.cleanup();
  });
}

test('fetch-based native refresh observes a clone and preserves the site response',async()=>{
  const f=refreshFixture({fetch:true,noTrailingSlash:true});const pending=f.run();await settle();
  assert.equal(f.button.clicks,1);assert.ok(f.requests.some(r=>r.fetch&&r.url==='/api/data/self'));
  f.releaseFetch();await f.clock.advance(499);
  assert.equal(f.h.ctx.window.__nacheckinDashboardRefresh.result,null);
  await f.clock.advance(1);assert.equal((await pending).ok,true);f.cleanup();
});

test('fetch observation preserves synchronous request argument capture',async()=>{
  const f=refreshFixture({fetch:true});const seen=[];
  const originalFetch=f.h.ctx.window.fetch;
  f.h.ctx.window.fetch=function(input,init){seen.push(init.headers.Authorization);return originalFetch(input,init);};
  f.button.click=function(){
    this.clicks++;this.loading=true;
    const init={headers:{Authorization:'before'}};
    this.completion=f.h.ctx.window.fetch('/api/data/self',init).then(()=>{this.loading=false;});
    init.headers.Authorization='after';
  };
  const pending=f.run();
  assert.deepEqual(seen,['before']);
  await settle();f.releaseFetch();await f.clock.advance(100);
  assert.equal((await pending).ok,true);assert.equal(f.button.clicks,1);
  f.h.ctx.window.fetch=originalFetch;f.cleanup();
});

test('a modern Lucide header supports verified identity without cached user data',async()=>{
  const f=refreshFixture({origin:'https://modern.example.test:8443',noTrailingSlash:true});
  f.local.delete('user');f.button.querySelector=selector=>selector.includes('svg.lucide-refresh-cw')?{}:f.button.loading?{}:null;
  f.h.ctx.identity={id:12,username:'alice'};
  const pending=f.h.run('tabRefreshNewApiDashboard(expectedOrigin,"12","round",identity)');
  assert.equal(f.button.clicks,1);f.requests[0].respond();await f.clock.advance(500);
  assert.equal((await pending).ok,true);assert.equal(f.local.has('user'),false);f.cleanup();
});

test('repeat injection during or after a native refresh cannot click twice',async()=>{
  const f=refreshFixture();const pending=f.run();
  assert.equal((await f.run()).ok,false);assert.equal(f.button.clicks,1);
  f.requests[0].respond();await f.clock.advance(500);assert.equal((await pending).ok,true);
  assert.equal((await f.run()).ok,true);assert.equal(f.button.clicks,1);f.cleanup();
});

for (const [status,body] of [[403,{success:false}],[200,{success:false,data:[]}],[200,'<html>challenge</html>'],[200,{success:true,data:{}}]]) {
  test(`native refresh ${status}/${JSON.stringify(body)} does not confirm cached nonzero quota`,async()=>{
    const f=refreshFixture();const pending=f.run();f.requests[0].respond(body,status);
    const result=await pending;assert.equal(result.ok,false);assert.match(result.message,/接口请求失败/);
    await f.clock.advance(500);assert.equal(f.button.clicks,1);f.cleanup();
  });
}

for (const state of ['absent','hidden','disabled','ariaDisabled','loading']) {
  test(`native button waits for ${state} to settle and clicks only once`,async()=>{
    const f=refreshFixture();if(state==='absent')f.headings.length=0;else f.button[state]=true;
    const pending=f.run();await f.clock.advance(500);assert.equal(f.button.clicks,0);
    if(state==='absent')f.headings.push(f.heading);else f.button[state]=false;
    await f.clock.advance(100);assert.equal(f.button.clicks,1);
    f.requests[0].respond();await f.clock.advance(500);assert.equal((await pending).ok,true);f.cleanup();
  });
}

test('Semi loading class prevents success even if the button is not disabled',async()=>{
  const f=refreshFixture();const pending=f.run();f.button.semiLoading=true;
  f.requests[0].respond();await f.clock.advance(600);
  assert.equal(f.h.ctx.window.__nacheckinDashboardRefresh.result,null);
  f.button.semiLoading=false;await f.clock.advance(100);assert.equal((await pending).ok,true);f.cleanup();
});

for (const state of ['origin','identity','ambiguous','username','missing']) {
  test(`native refresh refuses ${state} without reloading or clicking unrelated controls`,async()=>{
    const f=refreshFixture();
    if(state==='origin')f.h.ctx.location.origin='https://github.com';
    if(state==='identity')f.local.set('user',JSON.stringify({id:99,username:'alice'}));
    if(state==='ambiguous')f.headings.push({...f.heading,parentElement:{querySelectorAll(){return [{...f.button}];}}});
    if(state==='username')f.heading.textContent='Good morning, other-user';
    if(state==='missing')f.headings.length=0;
    const pending=f.run();if(['username','missing'].includes(state))await f.clock.advance(15000);
    assert.equal((await pending).ok,false);assert.equal(f.button.clicks,0);assert.equal(f.h.reloaded.length,0);f.cleanup();
  });
}

test('native refresh timeout cannot repeat the click or use an old visible balance',async()=>{
  const f=refreshFixture();const pending=f.run();await f.clock.advance(15000);
  assert.equal((await pending).ok,false);assert.equal((await f.run()).ok,false);assert.equal(f.button.clicks,1);f.cleanup();
});

for (const state of ['stop-before','stop-waiting','stop-after','navigation','identity','pagehide']) {
  test(`native refresh ${state} cleans request hooks and rejects late completion`,async()=>{
    const f=refreshFixture();
    if(state==='stop-before')f.h.ctx.window.__nacheckinCancelledCheckinToken='round';
    if(state==='stop-waiting')f.button.disabled=true;
    const pending=f.run();
    if(state.startsWith('stop-'))f.h.run('tabCancelCheckinPage("round")');
    if(state==='navigation')f.h.ctx.location.origin='https://github.com';
    if(state==='identity')f.local.set('user',JSON.stringify({id:99,username:'alice'}));
    if(state==='pagehide')f.h.ctx.window.dispatchEvent({type:'pagehide',persisted:true});
    await f.clock.advance(100);const result=await pending;assert.equal(result.ok,false);
    if(state.startsWith('stop-'))assert.equal(result.cancelled,true);
    if(f.requests.length){f.requests[0].respond();await f.clock.advance(500);}
    assert.equal(f.button.clicks,['stop-before','stop-waiting'].includes(state)?0:1);f.cleanup();
  });
}

test('synchronous native response failure does not leave a poll timer or hooks',async()=>{
  const f=refreshFixture();const click=f.button.click;
  f.button.click=function(){click.call(this);f.requests[0].respond({success:false},403);};
  assert.equal((await f.run()).ok,false);await f.clock.advance(500);f.cleanup();
});
