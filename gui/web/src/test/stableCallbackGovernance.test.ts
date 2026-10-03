import { describe, expect, it } from "vitest";
import { findStableCallbackRenderCalls } from "./stableCallbackGovernance";

describe("stable callback execution boundaries", () => {
  it.each([
    {
      name: "stable namespace string member and instantiation wrapper",
      text: 'import * as Stable from "./useStableCallback";\nfunction Probe() {\n  const read = (Stable["useStableCallback"]<[], number>)(() => 1);\n  read();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 4, column: 3, callback: "read" },
      ],
    },
    {
      name: "stable namespace computed identifier is dynamic",
      text: 'import * as Stable from "./useStableCallback";\nfunction Probe() {\n  const useStableCallback = "other";\n  const read = Stable[useStableCallback](() => 1);\n  read();\n}',
      expected: [],
    },
    {
      name: "unrelated import with same hook spelling",
      text: 'import { useStableCallback } from "other";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  read();\n}',
      expected: [],
    },
    {
      name: "default React import with computed literal",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  React["useMemo"](read, []);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 20, callback: "read" },
      ],
    },
    {
      name: "nested destructuring is outside parameter policy",
      text: 'import { useStableCallback } from "./useStableCallback";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (({ inner: { value = read() } = {} } = {}) => value)();\n}',
      expected: [],
    },
    {
      name: "deferred object methods and accessors",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  return { later() { read(); }, get value() { return read(); }, set value(x) { read(); } };\n}',
      expected: [],
    },
    {
      name: "deferred class methods and instance fields",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  class Later { value = read(); #private = read(); constructor() { read(); } later() { read(); } get result() { return read(); } static later() { read(); } }\n  return Later;\n}',
      expected: [],
    },
    {
      name: "deferred generators including invoked generator",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  const later = function* () { read(); };\n  (function* () { read(); })();\n  return later;\n}',
      expected: [],
    },
    {
      name: "async functions outside the synchronous policy",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (async () => { read(); })();\n  React.useMemo(async () => read(), []);\n}',
      expected: [],
    },
    {
      name: "eager object computed method key",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  return { [read()]() {} };\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 13, callback: "read" },
      ],
    },
    {
      name: "eager class computed keys",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  class Later { [read()]() {} }\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 18, callback: "read" },
      ],
    },
    {
      name: "eager instance field computed key",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  class Later { [read()] = () => read(); }\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 18, callback: "read" },
      ],
    },
    {
      name: "eager class heritage",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  class Later extends read() {}\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 23, callback: "read" },
      ],
    },
    {
      name: "eager static fields and blocks",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  class Later { static value = read(); static #private = read(); static { read(); } }\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 32, callback: "read" },
        { file: "utils/Fixture.tsx", line: 5, column: 58, callback: "read" },
        { file: "utils/Fixture.tsx", line: 5, column: 75, callback: "read" },
      ],
    },
    {
      name: "static-block lexical and var shadows",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  class Later { static { const read = () => 2; read(); } static { var read = () => 3; read(); } }\n}',
      expected: [],
    },
    {
      name: "switch discriminant uses outer binding",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  switch (read()) { case 0: const read = () => 2; read(); }\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 11, callback: "read" },
      ],
    },
    {
      name: "hoisted var shadows in IIFE",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (() => { read(); var read = () => 2; })();\n}',
      expected: [],
    },
    {
      name: "parameter default resolves outside body var scope",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((x = read()) => { var read = () => 2; return x; })();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 9, callback: "read" },
      ],
    },
    {
      name: "computed method key resolves outside parameter scope",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  return { [read()](read) { read(); } };\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 13, callback: "read" },
      ],
    },
    {
      name: "function expression self binding shadows callback",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (function read() { read(); })();\n}',
      expected: [],
    },
    {
      name: "computed identifier call and apply are dynamic",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  const call = "toString", apply = "toString";\n  read[call](); read[apply]();\n}',
      expected: [],
    },
    {
      name: "computed string call and apply invoke the callback",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  read["call"](null);\n  read?.["apply"](null, []);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 3, callback: "read" },
        { file: "utils/Fixture.tsx", line: 6, column: 3, callback: "read" },
      ],
    },
    {
      name: "computed identifier React hooks are dynamic",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  const useMemo = "useEffect", useState = "useEffect", useReducer = "useEffect";\n  React[useMemo](() => read(), []);\n  React[useState](() => read());\n  React[useReducer](x => x, 0, () => read());\n}',
      expected: [],
    },
    {
      name: "computed string React hooks are recognized",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  React["useMemo"](() => read(), []);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 26, callback: "read" },
      ],
    },
    {
      name: "shadowed namespace and named hooks",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((React) => React.useMemo(() => read(), []))({ useMemo: () => {} });\n  const useMemo = (fn) => fn; useMemo(() => read());\n}',
      expected: [],
    },
    {
      name: "satisfies wrapper on stable declaration",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  const other = useStableCallback(() => 2) satisfies () => number;\n  other();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 6, column: 3, callback: "other" },
      ],
    },
    {
      name: "satisfies wrapper on callback invocation",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (read satisfies () => number)();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 3, callback: "read" },
      ],
    },
    {
      name: "satisfies wrapper on IIFE",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((() => read()) satisfies () => number)();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 11, callback: "read" },
      ],
    },
    {
      name: "satisfies wrapper on hook callee and memo callback",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  const other = (useStableCallback satisfies Function)(() => 2);\n  React.useMemo((() => other()) satisfies () => number, []);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 6, column: 24, callback: "other" },
      ],
    },
    {
      name: "other TypeScript expression wrappers",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (read as () => number)!();\n  read<number>();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 3, callback: "read" },
        { file: "utils/Fixture.tsx", line: 6, column: 3, callback: "read" },
      ],
    },
    {
      name: "omitted IIFE parameter default",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((x = read()) => x)();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 9, callback: "read" },
      ],
    },
    {
      name: "explicit undefined IIFE parameter default",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((x = read()) => x)(undefined);\n  ((x = read()) => x)(void 0);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 9, callback: "read" },
        { file: "utils/Fixture.tsx", line: 6, column: 9, callback: "read" },
      ],
    },
    {
      name: "supplied literal arguments suppress defaults",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((x = read()) => x)(1);\n  ((x = read()) => x)(null);\n  ((x = read()) => x)(false);\n  ((x = read()) => x)("x");\n  ((x = read()) => x)({});\n  ((x = read()) => x)([]);\n}',
      expected: [],
    },
    {
      name: "supplied argument does not hide calls in body",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((x = read()) => read())(1);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 20, callback: "read" },
      ],
    },
    {
      name: "shadowed undefined is not an omitted argument",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  const undefined = 1; ((x = read()) => x)(undefined);\n}',
      expected: [],
    },
    {
      name: "omitted object destructuring default",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (({ x = read() } = {}) => x)();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 11, callback: "read" },
      ],
    },
    {
      name: "omitted array destructuring default",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (([x = read()] = []) => x)();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 10, callback: "read" },
      ],
    },
    {
      name: "empty literal destructuring arguments",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (({ x = read() }) => x)({});\n  (([x = read()]) => x)([]);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 11, callback: "read" },
        { file: "utils/Fixture.tsx", line: 6, column: 10, callback: "read" },
      ],
    },
    {
      name: "supplied nonempty destructuring arguments are outside policy",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  (({ x = read() }) => x)({ x: 1 });\n  (([x = read()]) => x)([1]);\n}',
      expected: [],
    },
    {
      name: "dynamic and spread argument defaults are outside policy",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((x = read()) => x)(value);\n  ((x = read()) => x)(...values);\n}',
      expected: [],
    },
    {
      name: "React memo and state omitted defaults",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  React.useMemo((x = read()) => x, []);\n  React.useState((x = read()) => x);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 22, callback: "read" },
        { file: "utils/Fixture.tsx", line: 6, column: 23, callback: "read" },
      ],
    },
    {
      name: "React reducer initializer receives initial argument",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  React.useReducer(x => x, undefined, (x = read()) => x);\n  React.useReducer(x => x, 1, (x = read()) => x);\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 5, column: 44, callback: "read" },
      ],
    },
    {
      name: "eager parameter shadows stable callback",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  ((read = () => 2, x = read()) => x)();\n}',
      expected: [],
    },
    {
      name: "alias and helper calls stay outside policy",
      text: 'import { useStableCallback } from "./useStableCallback";\nimport * as React from "react";\nfunction Probe() {\n  const read = useStableCallback(() => 1);\n  const alias = read; alias();\n  function helper() { read(); } helper();\n  return <Child read={read} />;\n}',
      expected: [],
    },
    {
      name: "reassigned bindings are outside the policy",
      text: 'import { useStableCallback } from "./useStableCallback";\nfunction Probe() {\n  let read = useStableCallback(() => 1);\n  read = () => 2;\n  return read();\n}',
      expected: [],
    },
    {
      name: "unreassigned let binding remains governed",
      text: 'import { useStableCallback } from "./useStableCallback";\nfunction Probe() {\n  let read = useStableCallback(() => 1);\n  return read();\n}',
      expected: [
        { file: "utils/Fixture.tsx", line: 4, column: 10, callback: "read" },
      ],
    },
  ])("$name", ({ text, expected }) => {
    expect(
      findStableCallbackRenderCalls({ rel: "utils/Fixture.tsx", text }),
    ).toEqual(expected);
  });
});
