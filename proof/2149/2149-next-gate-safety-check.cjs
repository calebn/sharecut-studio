const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(__dirname + "/2149-next-nav-gate.js", "utf8");
function fixture(readyState = "loading") {
  const handlers = [];
  class Element {
    constructor(tag) { this.localName=tag; this.id=""; this.isConnected=true; }
    getAttribute() { return null; }
  }
  const nav = new Element("nav"), button = new Element("button"), outside = new Element("div");
  const currentScript = {src:"",type:"",getAttribute:()=>"prebootstrap-nav-gate"};
  const document = {readyState,currentScript,scripts:[currentScript],querySelectorAll:()=>[nav]};
  let timeout;
  const window = {visualViewport:{scale:1,width:390,height:844},
    addEventListener:(type,callback,options)=>{assert.equal(options.capture,true);assert.equal(options.passive,true);handlers.push({type,callback});},
    removeEventListener:(type,callback)=>{const n=handlers.findIndex((h)=>h.type===type&&h.callback===callback);if(n>=0)handlers.splice(n,1);}};
  const context = vm.createContext({window,document,Element,navigator:{userAgent:"mock gate safety"},
    performance:{now:()=>1,timeOrigin:0},innerWidth:390,innerHeight:844,scrollX:0,scrollY:0,
    setTimeout:(fn,ms)=>{assert.equal(ms,120000);timeout=fn;return 1;},clearTimeout:()=>{}});
  const install = () => vm.runInContext(source,context);
  function dispatch(type, inNav=true) {
    let blocked=false;
    const e={type,timeStamp:1,isTrusted:true,cancelable:true,defaultPrevented:false,pointerId:1,pointerType:"touch",
      target:inNav?button:outside,touches:[],changedTouches:[],composedPath:()=>inNav?[button,nav,document,window]:[outside,document,window],
      stopImmediatePropagation:()=>{blocked=true;},preventDefault:()=>{throw new Error("Forbidden default prevention");}};
    for(const h of [...handlers].filter((h)=>h.type===type)){h.callback(e);if(blocked)break;}
    return {blocked,event:e};
  }
  return {window,handlers,install,dispatch,timeout:()=>timeout()};
}
const one=fixture();one.install();assert.throws(one.install,/already installed/);
one.dispatch("pointerdown");assert.throws(()=>one.window.__sharecut2149Gate.setCondition("armed"),/not fully released/);
one.dispatch("pointerup");one.window.__sharecut2149Gate.setCondition("armed");
let count=one.window.__sharecut2149Gate.export().rows.length;
assert.equal(one.dispatch("click",false).blocked,false);assert.equal(one.window.__sharecut2149Gate.export().rows.length,count);
assert.equal(one.dispatch("click").blocked,true);
assert.equal(one.dispatch("focusin").blocked,false);
let rows=one.window.__sharecut2149Gate.export().rows;
assert(rows.some((r)=>r.kind==="ungated-focus-observation"&&r.type==="focusin"));
assert.equal(rows.filter((r)=>r.kind==="later-window-capture-sentinel"&&r.type==="click").length,0);
assert(rows.some((r)=>r.kind==="first-window-capture"&&r.type==="click"&&r.blocked));
one.window.__sharecut2149Gate.setCondition("sham");assert.equal(one.dispatch("click").blocked,false);
rows=one.window.__sharecut2149Gate.export().rows;assert(rows.some((r)=>r.kind==="later-window-capture-sentinel"&&r.type==="click"));
const removed=one.window.__sharecut2149Gate.remove();assert.equal(removed.stopReason,"removed");assert.equal(one.handlers.length,0);
assert.equal(one.window.__sharecut2149Gate,undefined);
const two=fixture();two.install();two.timeout();assert.equal(two.window.__sharecut2149Gate.export().stopReason,"timeout");assert.equal(two.handlers.length,0);
const three=fixture();three.install();for(let n=0;n<599;n++)three.window.__sharecut2149Gate.mark("exact-cap");
assert.equal(three.window.__sharecut2149Gate.export().rows.length,600);assert.equal(three.window.__sharecut2149Gate.export().stopReason,"capped");assert.equal(three.handlers.length,0);
assert.throws(()=>three.window.__sharecut2149Gate.setCondition("armed"),/stopped/);
const late=fixture("complete");assert.throws(late.install,/first prebootstrap/);assert.equal(late.handlers.length,0);
console.log(JSON.stringify({result:"PASS",checks:["first-script requirement","duplicate guard","same passive capture listeners","sham sentinel","armed nav-only propagation block","active-contact guard","restored sham","remove","120s timeout","exact600-row cap"],limitation:"Mock lifecycle/ordering only. Not native dispatch, browser efficacy, or application-handler exclusion proof."}));
