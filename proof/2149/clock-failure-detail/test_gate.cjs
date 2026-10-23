const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = __dirname;
const source = fs.readFileSync(path.join(root, 'gate.js'), 'utf8');
const baseline = fs.readFileSync(path.join(root, 'original-gate.fixture.js'), 'utf8');
const inserts = ['observer-insert.js', 'api-insert.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8'));
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
assert.equal(digest(baseline), '9ef86e0a336278a55df6bde8a8b45c40babfe6970e2b44ce8b81e47b74da49d9');
assert.equal(source.replace(inserts[0], '').replace(inserts[1], ''), baseline);
assert.equal((source.match(/stopImmediatePropagation\(/g) || []).length, 1);
for (const s of inserts) assert.ok(!/preventDefault|stopPropagation|stopImmediatePropagation|requestAnimationFrame|fetch\(|queueMicrotask/.test(s));

function fixture({missing = false, initialOrigin = 123456} = {}) {
  let now = 0, origin = initialOrigin, forbidden = false, visibility = 'visible';
  const registrations = [];
  class Target {
    constructor(name) { this.name = name; this.listeners = []; }
    addEventListener(type, fn, options) { this.listeners.push({type, fn, options}); registrations.push([this.name, type, options]); }
    removeEventListener(type, fn, capture) { assert.equal(capture, true); this.listeners = this.listeners.filter(x => x.type !== type || x.fn !== fn); }
    dispatch(type, target = this, timestamp = now) { const event = {type, target, timeStamp: timestamp}; for (const x of [...this.listeners]) if (x.type === type) x.fn(event); }
  }
  class Element { getBoundingClientRect() { throw Error('geometry forbidden'); } }
  const w = new Target('window');
  const vv = new Target('visualViewport');
  Object.assign(vv, {scale: 1, width: 390, height: 700, offsetLeft: 0, offsetTop: 0});
  Object.assign(w, {visualViewport: missing ? null : vv, scrollX: 0, scrollY: 0});
  const script = {src: 'https://fixture.invalid/assets/qa2149-nav-gate-' + 'a'.repeat(64) + '.js', type: '', getAttribute: k => k === 'data-run' ? 'b'.repeat(32) : 'prebootstrap-nav-gate'};
  const doc = {readyState: 'loading', currentScript: script, scripts: [script], querySelectorAll() { if (forbidden) throw Error('DOM query forbidden'); return []; }};
  Object.defineProperties(doc, {visibilityState: {get() { if (forbidden) throw Error('DOM visibility forbidden'); return visibility; }}, activeElement: {get() { if (forbidden) throw Error('DOM activeElement forbidden'); return null; }}});
  let timeout, delay, cleared = 0;
  const context = vm.createContext({window: w, document: doc, Element, URL, crypto: {randomUUID: () => 'gate-instance'}, performance: {now: () => now, get timeOrigin() { return origin; }}, navigator: {userAgent: 'synthetic'}, scrollX: 0, scrollY: 0, innerWidth: 390, innerHeight: 700, setTimeout(fn, ms) { timeout = fn; delay = ms; return 1; }, clearTimeout() { cleared++; }});
  vm.runInContext(source, context);
  vm.runInContext(fs.readFileSync(path.join(root, 'bridge-adapter.js'), 'utf8'), context);
  const api = w.__sharecut2149Gate, adapter = w.__sharecut2149ChronologyAdapter;
  return {api, adapter, vv, w, doc, context, registrations, get delay() { return delay; }, get cleared() { return cleared; }, at(t) { now = t; }, origin(t) { origin = t; }, hidden() { visibility = 'hidden'; }, expire() { timeout(); }, emit(target, type, t, scale = vv.scale, eventTarget = target, timestamp = t) { now = t; vv.scale = scale; forbidden = true; try { target.dispatch(type, eventTarget, timestamp); } finally { forbidden = false; } }, live() { return w.listeners.length + vv.listeners.length; }};
}
const plain = x => JSON.parse(JSON.stringify(x));
const ctx = (operation = 'op1', trial = 'sham1', native = 'native-case') => ({transport_run: 'b'.repeat(32), native_run: native, operation_id: operation, trial_id: trial, request_sha256: 'c'.repeat(64), gate_instance: 'gate-instance', label: 'before-native-' + operation});
const command = (context, boundary = 'begin') => ({op: 'mark', label: boundary === 'begin' ? context.label : 'after-observation-' + context.operation_id, chronology_context: context, chronology_boundary: boundary});
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }
test('literal original touch handlers/options and cancellation remain unchanged', () => {
  const original = fixture();
  const registrations = original.registrations;
  assert.equal(registrations.length, 40);
  for (const [target, type, options] of registrations) assert.deepEqual(plain(options), {capture: true, passive: true});
  assert.equal(registrations.filter(x => ['resize', 'scroll'].includes(x[1])).length, 4);
  original.api.remove();
});
test('29ms transient and reversal retained before delayed first sample; no per-event DOM work', () => {
  const f = fixture(), c = ctx(); f.adapter.applyMark(f.api, command(c));
  f.emit(f.vv, 'resize', 29, 1.6); f.emit(f.vv, 'resize', 100, 1);
  f.at(408); const rows = f.api.export().rows.filter(x => x.kind === 'viewport-chronology');
  assert.deepEqual(plain(rows.map(x => [x.at, x.viewport.scale])), [[29, 1.6], [100, 1]]);
  f.at(649); f.adapter.applyMark(f.api, command(c, 'end'));
  assert.equal(f.api.export().chronology.live_listeners, 4); f.api.remove(); assert.equal(f.live(), 0);
});
test('pre-ACK events retained, including events after ACK snapshot; no silent replay', () => {
  const f = fixture(); f.emit(f.vv, 'resize', 1, 1.6); f.emit(f.vv, 'resize', 2, 1);
  f.at(3); f.api.beginChronology(ctx()); const copied = plain(f.api.export());
  f.emit(f.vv, 'resize', 4, 1.6); f.emit(f.vv, 'resize', 5, 1);
  assert.equal(copied.rows.filter(x => x.kind === 'viewport-chronology').length, 2);
  assert.equal(f.api.export().rows.filter(x => x.kind === 'viewport-chronology').length, 4);
  assert.throws(() => f.api.beginChronology(ctx()), /not ready|duplicate/); f.api.remove();
});
test('global scroll observed without scale change; element scroll excluded; ties ordered', () => {
  const f = fixture(); f.w.scrollY = 40;
  f.emit(f.w, 'scroll', 10); f.emit(f.w, 'scroll', 10, 1, f.doc);
  f.emit(f.w, 'scroll', 11, 1, {}); f.emit(f.vv, 'scroll', 12); f.emit(f.w, 'resize', 12);
  const rows = f.api.export().rows.filter(x => x.kind === 'viewport-chronology');
  assert.equal(rows.length, 4); assert.equal(rows[0].viewport.scrollY, 40);
  assert.ok(rows[1].sequence > rows[0].sequence); f.api.remove();
});
test('no callbacks means no event reported; nonfinite viewport is terminal', () => {
  const f = fixture(); f.api.beginChronology(ctx()); f.at(2100); f.api.endChronology(ctx());
  assert.equal(f.api.export().rows.filter(x => x.kind === 'viewport-chronology').length, 0); f.api.remove();
  const g = fixture(); g.emit(g.vv, 'resize', 29, NaN);
  assert.equal(g.api.export().chronology.error, 'invalid-viewport'); assert.equal(g.live(), 0);
});
test('one native case; setup before target; ONE SHAM; no setup or second target afterward', () => {
  const f = fixture(), setup = ctx('setup-op', 'setup1');
  f.api.beginChronology(setup); f.api.endChronology(setup);
  assert.throws(() => f.api.beginChronology(ctx('other', 'sham1', 'other-case')), /not ready/);
  const target = ctx(); f.api.beginChronology(target); f.api.endChronology(target);
  assert.throws(() => f.api.beginChronology(ctx('second')), /not ready/);
  assert.throws(() => f.api.beginChronology(ctx('late-setup', 'setup2')), /not ready/); f.api.remove();
});
test('600 shared rows cap stops all listeners, no new budget', () => {
  const f = fixture(); for (let i = 1; i <= 650; i++) f.emit(f.vv, 'scroll', i);
  assert.equal(f.api.export().rows.length, 600); assert.equal(f.api.export().stopReason, 'capped');
  assert.equal(f.api.export().chronology.clock_failure, null); assert.equal(f.live(), 0);
  assert.throws(() => f.api.beginChronology(ctx()));
});
test('original 120s timer; delayed timer cannot permit callback beyond deadline', () => {
  const f = fixture(); assert.equal(f.delay, 120000); f.emit(f.vv, 'resize', 120000);
  assert.equal(f.api.export().stopReason, 'chronology-deadline');
  assert.equal(f.api.export().chronology.clock_failure, null); assert.equal(f.live(), 0);
  const g = fixture(); g.expire(); assert.equal(g.api.export().stopReason, 'timeout'); assert.equal(g.live(), 0);
});
test('missing source, origin change, backwards clock, replacement, visibility fail closed', () => {
  const a = fixture({missing: true}); assert.throws(() => a.api.beginChronology(ctx())); assert.equal(a.live(), 0);
  const b = fixture(); b.origin(2); b.emit(b.vv, 'resize', 1); assert.equal(b.api.export().chronology.error, 'clock-changed');
  const c = fixture(); c.emit(c.vv, 'resize', 10); c.emit(c.vv, 'resize', 9); assert.equal(c.api.export().chronology.error, 'clock-changed');
  const d = fixture(); d.context.document = {...d.doc}; assert.throws(() => d.api.beginChronology(ctx()));
  const e = fixture(); e.hidden(); assert.throws(() => e.api.beginChronology(ctx())); assert.equal(e.live(), 0);
});
test('status clock predicates retain exact sampled values and first failure through cleanup', () => {
  const cases = [
    {name: 'nonfinite-now', setup: f => f.at(NaN), failed: {now_nonfinite: true, captured_origin_nonfinite: false, origin_changed: false, now_before_last_at: false}, nowTag: 'NaN'},
    {name: 'nonfinite-captured-origin', options: {initialOrigin: Infinity}, setup: () => {}, failed: {now_nonfinite: false, captured_origin_nonfinite: true, origin_changed: false, now_before_last_at: false}, originTag: 'Infinity'},
    {name: 'changed-origin', setup: f => f.origin(7), failed: {now_nonfinite: false, captured_origin_nonfinite: false, origin_changed: true, now_before_last_at: false}},
    {name: 'backward-now', setup: f => { f.emit(f.vv, 'resize', 10); f.at(9); }, failed: {now_nonfinite: false, captured_origin_nonfinite: false, origin_changed: false, now_before_last_at: true}},
  ];
  for (const c of cases) {
    const f = fixture(c.options); c.setup(f);
    const before = f.api.export();
    assert.equal(before.stopReason, 'chronology-clock-changed', c.name);
    assert.equal(before.chronology.error, 'clock-changed', c.name);
    assert.equal(before.chronology.clock_failure.site, 'status', c.name);
    assert.deepEqual(plain(before.chronology.clock_failure.failed), c.failed, c.name);
    assert.equal(before.chronology.clock_failure.source, null);
    assert.equal(before.chronology.clock_failure.type, null);
    assert.equal(before.chronology.clock_failure.samples.current_origin.value, c.name === 'changed-origin' ? 7 : c.options ? null : 123456);
    assert.equal(before.chronology.clock_failure.samples.event_timestamp.type, 'undefined');
    assert.equal(before.chronology.clock_failure.samples.last_at.value, c.name === 'backward-now' ? 10 : 0);
    assert.equal(before.chronology.clock_failure.samples.now.value, c.name === 'backward-now' ? 9 : c.name === 'nonfinite-now' ? null : 0);
    assert.equal(before.chronology.clock_failure.phase, 'installation');
    assert.equal(before.chronology.clock_failure.context, null);
    if (c.nowTag) assert.equal(before.chronology.clock_failure.samples.now.tag, c.nowTag);
    if (c.originTag) assert.equal(before.chronology.clock_failure.samples.captured_origin.tag, c.originTag);
    const first = plain(before.chronology.clock_failure);
    before.chronology.clock_failure.samples.last_at.value = 999;
    before.chronology.clock_failure.failed.now_nonfinite = false;
    assert.deepEqual(plain(before.chronology.clock_failure), first);
    f.at(500); f.origin(999);
    assert.deepEqual(plain(f.api.export().chronology.clock_failure), first, c.name);
    const removed = plain(f.api.remove());
    assert.deepEqual(removed.chronology.clock_failure, first, c.name);
    assert.equal(f.live(), 0, c.name);
  }
});
test('observer clock predicates distinguish timestamp, origin and backwards callback', () => {
  const cases = [
    {name: 'nonfinite-now', action: f => f.emit(f.vv, 'resize', NaN, 1, f.vv, 1), failed: {now_nonfinite: true, origin_changed: false, now_before_last_at: false, event_timestamp_nonfinite: false}},
    {name: 'changed-origin', action: f => { f.origin(7); f.emit(f.w, 'scroll', 1); }, failed: {now_nonfinite: false, origin_changed: true, now_before_last_at: false, event_timestamp_nonfinite: false}},
    {name: 'backward-now', action: f => { f.emit(f.vv, 'resize', 10); f.emit(f.vv, 'scroll', 9); }, failed: {now_nonfinite: false, origin_changed: false, now_before_last_at: true, event_timestamp_nonfinite: false}},
    {name: 'nonfinite-event-timestamp', action: f => f.emit(f.vv, 'resize', 1, 1, f.vv, Infinity), failed: {now_nonfinite: false, origin_changed: false, now_before_last_at: false, event_timestamp_nonfinite: true}},
    {name: 'wrong-type-event-timestamp', action: f => f.emit(f.vv, 'resize', 1, 1, f.vv, 'late'), failed: {now_nonfinite: false, origin_changed: false, now_before_last_at: false, event_timestamp_nonfinite: true}},
  ];
  for (const c of cases) {
    const f = fixture(); c.action(f);
    const snapshot = plain(f.api.export());
    assert.equal(snapshot.stopReason, 'chronology-clock-changed', c.name);
    assert.equal(snapshot.chronology.error, 'clock-changed', c.name);
    assert.equal(snapshot.chronology.clock_failure.site, 'observer', c.name);
    assert.deepEqual(snapshot.chronology.clock_failure.failed, c.failed, c.name);
    assert.equal(snapshot.chronology.clock_failure.source, c.name === 'changed-origin' ? 'window:scroll' : c.name === 'backward-now' ? 'visualViewport:scroll' : 'visualViewport:resize');
    assert.equal(snapshot.chronology.clock_failure.type, c.name === 'backward-now' || c.name === 'changed-origin' ? 'scroll' : 'resize');
    if (c.name === 'nonfinite-event-timestamp') assert.equal(snapshot.chronology.clock_failure.samples.event_timestamp.tag, 'Infinity');
    if (c.name === 'wrong-type-event-timestamp') assert.deepEqual(snapshot.chronology.clock_failure.samples.event_timestamp, {value: 'late', finite: false, type: 'string', tag: 'string'});
    assert.equal(snapshot.chronology.clock_failure.samples.last_at.value, c.name === 'backward-now' ? 10 : 0);
    assert.equal(f.live(), 0, c.name);
  }
});
test('coarsened callback ties and delayed finite event timestamps pass independently of wall time', () => {
  const f = fixture();
  f.context.Date = class { static now() { throw Error('wall clock read'); } constructor() { throw Error('wall clock read'); } };
  assert.throws(() => vm.runInContext('Date.now()', f.context), /wall clock read/);
  f.emit(f.vv, 'resize', 10, 1, f.vv, -5000);
  f.emit(f.vv, 'resize', 10, 1, f.vv, 9999999);
  f.emit(f.w, 'scroll', 11, 1, f.w, 1);
  const result = plain(f.api.export());
  assert.equal(result.chronology.clock_failure, null);
  assert.equal(result.stopReason, null);
  assert.deepEqual(result.rows.filter(x => x.kind === 'viewport-chronology').map(x => x.eventTimestamp), [-5000, 9999999, 1]);
  f.api.remove(); assert.equal(f.live(), 0);
});
test('first observer clock failure survives JSON export, remove and later clock anomalies', () => {
  const f = fixture(); f.api.beginChronology(ctx('setup-op', 'setup1'));
  f.emit(f.vv, 'resize', 1, 1, f.vv, NaN);
  const snapshot = plain(f.api.export());
  const detail = snapshot.chronology.clock_failure;
  assert.equal(detail.samples.event_timestamp.type, 'number');
  assert.equal(detail.samples.event_timestamp.tag, 'NaN');
  assert.equal(detail.phase, 'before-native');
  assert.equal(detail.context.operation_id, 'setup-op');
  assert.equal(snapshot.rows.length, 2);
  f.at(-100); f.origin(Infinity);
  assert.deepEqual(plain(f.api.export().chronology.clock_failure), detail);
  assert.deepEqual(plain(f.api.remove().chronology.clock_failure), detail);
  assert.equal(f.live(), 0);
});
test('adapter exact boundaries, echo, ready metadata, end context and duplicate removal', () => {
  const f = fixture(); assert.equal(f.adapter.payload(f.api.export()).chronology.live_listeners, 4);
  assert.throws(() => f.adapter.applyMark(f.api, {op: 'mark', label: ctx().label}));
  assert.throws(() => f.adapter.applyMark(f.api, {...command(ctx()), op: 'export'}));
  f.adapter.applyMark(f.api, command(ctx()));
  assert.throws(() => f.api.endChronology({...ctx(), request_sha256: 'd'.repeat(64)}));
  f.adapter.applyMark(f.api, command(ctx(), 'end'));
  const first = f.api.remove(); assert.equal(f.api.remove(), first); assert.equal(f.live(), 0);
  assert.equal(f.w.__sharecut2149ChronologyAdapter, undefined);
  assert.deepEqual(plain(f.adapter.payload(first).chronology_cleanup), {adapter_removed: true, live_listeners: 0});
  assert.throws(() => f.adapter.applyMark(f.api, command(ctx('post-remove'))));
});

function ackFixture() {
  const f = fixture(), context = ctx();
  const ready = plain(f.api.export().chronology);
  f.at(1); f.adapter.applyMark(f.api, command(context));
  const snapshot = plain(f.api.export());
  const data = {v: 1, run: context.transport_run, instance: 'bridge-instance', epoch: 1, prev: 'e'.repeat(64), op: 'mark', label: context.label, at: 1, timeOrigin: 123456, remaining_ms: 119999, document_identity: {origin: 'https://fixture.invalid', pathname: '/', sha256: '1'.repeat(64)}, base_identity: {origin: 'https://fixture.invalid', pathname: '/', sha256: '2'.repeat(64)}, condition: snapshot.condition, stopReason: snapshot.stopReason, touchCount: snapshot.touchCount, activePointerIds: snapshot.activePointerIds, rows: snapshot.rows.slice(1), total_rows: snapshot.rows.length, ...f.adapter.payload(snapshot)};
  const expected = {context, transport_run: context.transport_run, bridge_instance: 'bridge-instance', gate_instance: context.gate_instance, epoch: 1, prev_sha256: data.prev, time_origin: 123456, original_start: ready.original_start, installed_at: ready.installed_at, min_remaining_ms: 10000, script_path: ready.script_path, bundle_sha256: ready.bundle_sha256, document_identity: data.document_identity, base_identity: data.base_identity};
  const raw_payload = JSON.stringify(data); f.api.remove();
  return {raw_payload, receipt_sha256: digest(raw_payload), expected};
}
if (process.argv[2] === '--ack-fixture') fs.writeFileSync(process.argv[3], JSON.stringify(ackFixture()));
console.log(`${checks} gate/adapter checks passed; synthetic events only.`);
