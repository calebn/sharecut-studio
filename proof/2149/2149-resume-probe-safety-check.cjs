const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(__dirname + "/2149-resume-passive-probe.js", "utf8");
function fixture() {
  const targets = [];
  class Target {
    constructor() { this.handlers = []; targets.push(this); }
    addEventListener(type, callback, options) { assert.equal(options.passive, true); this.handlers.push({type, callback, options}); }
    removeEventListener(type, callback, capture) {
      this.handlers = this.handlers.filter((h) => !(h.type === type && h.callback === callback && h.options.capture === capture));
    }
  }
  class Element extends Target {
    constructor() { super(); this.localName = "div"; this.nodeName = "DIV"; this.id = ""; this.isConnected = true; this.scrollWidth = 390; }
    getAttribute() { return null; }
    getBoundingClientRect() { return {x:0,y:0,width:390,height:44}; }
    matches() { return false; }
    closest() { return null; }
  }
  const body = new Element(), html = new Element(), document = new Target();
  Object.assign(document, {body, documentElement:html, activeElement:body, querySelector:()=>null, elementFromPoint:()=>body});
  const viewport = new Target(); Object.assign(viewport, {scale:1,width:390,height:844});
  let timeout, disconnected = false;
  const microtasks = [];
  const window = new Target(); window.visualViewport = viewport;
  const context = vm.createContext({window, document, Element, navigator:{userAgent:"mock safety fixture"},
    performance:{now:()=>1,timeOrigin:0}, innerWidth:390,innerHeight:844,scrollX:0,scrollY:0,
    matchMedia:()=>({matches:false}), getComputedStyle:()=>({touchAction:"auto"}),
    setTimeout:(fn,ms)=>{assert.equal(ms,120000); timeout=fn; return 1;}, clearTimeout:()=>{},
    queueMicrotask:(fn)=>microtasks.push(fn), MutationObserver:class {observe(){} disconnect(){disconnected=true;}}});
  vm.runInContext(source, context);
  return {window, document, body, targets, microtasks, runTimeout:()=>timeout(), disconnected:()=>disconnected, context};
}
const one = fixture();
assert.equal(one.window.__sharecut2149Probe.export().rows.length, 1);
assert.throws(()=>vm.runInContext(source,one.context), /already installed/);
const event = {type:"touchstart",timeStamp:1,isTrusted:true,cancelable:true,defaultPrevented:false,target:one.body,
  touches:[],changedTouches:[],composedPath:()=>[one.body,one.document,one.window]};
for (const h of [...one.document.handlers].filter((h)=>h.type===event.type)) h.callback(event);
one.microtasks.forEach((fn)=>fn());
const eventRows=one.window.__sharecut2149Probe.export().rows;
assert.deepEqual([...new Set(eventRows.filter((r)=>r.eventId).map((r)=>r.eventId))],[1]);
assert(eventRows.some((r)=>r.kind==="capture-microtask"));
assert(!eventRows.some((r)=>r.kind==="after-dispatch"));
const removed=one.window.__sharecut2149Probe.remove();
assert.equal(removed.stopReason,"manual"); assert(one.disconnected());
assert.equal(one.window.__sharecut2149Probe, undefined);
assert(one.targets.every((t)=>t.handlers.length===0));
const two=fixture();two.runTimeout();assert.equal(two.window.__sharecut2149Probe.export().stopReason,"timeout");
assert(two.targets.every((t)=>t.handlers.length===0));
const three=fixture();for(let n=0;n<1199;n++)three.window.__sharecut2149Probe.mark("cap");
const capped=three.window.__sharecut2149Probe.export();assert.equal(capped.rows.length,1200);
assert.equal(capped.stopReason,"capped");assert.equal(capped.dropped,0);assert(three.disconnected());
assert(three.targets.every((t)=>t.handlers.length===0));
three.window.__sharecut2149Probe.mark("after cap");
assert.equal(three.window.__sharecut2149Probe.export().rows.length,1200);
console.log(JSON.stringify({result:"PASS",checks:["install/export","duplicate protection","event phase correlation","manual remove cleanup","120s timeout cleanup","1200-row cap disconnect"],limitation:"Mock lifecycle/shape safety only; not a browser run, native timing proof, or bug efficacy check"}));
