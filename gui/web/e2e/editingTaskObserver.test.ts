import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import { afterEach, expect, it, vi } from "vitest";
import { editingTaskRegistry } from "./editingTaskCases";
import { assessEditingTrial } from "./editingTaskReport";
import { type DurableState } from "./editingTaskState";
import { runEditingTask } from "./editingTasks";

const ownerProbe = vi.hoisted(() => ({
  fixture: { projectPath: "", workspaceDir: "" },
  state: undefined as DurableState | undefined,
  finish: async () => {},
}));
vi.mock("./editingBackendIdentity", () => ({
  verifyEditingBackend: async (
    _attempt: string,
    _port: string,
    input: { phase: "before" | "after" },
  ) => ({
    phase: input.phase,
    protocolHash: "controlled",
    pid: 1,
    startTime: "1",
    listenerInode: "1",
    receiptHash: "controlled",
    launchHash: "controlled",
    verificationHash: "controlled",
  }),
}));
vi.mock("./editingTaskEvidence", () => ({
  createEditingFixture: () => ownerProbe.fixture,
  readEditingState: () => ownerProbe.state,
  readEditingHistory: () => ({ cursor: -1, headId: null, entries: [] }),
}));
vi.mock("./editorProfile", () => ({
  createEditorProfiler: async () => ({
    report: { samples: [] },
    finish: () => ownerProbe.finish(),
  }),
}));
const roots: string[] = [];
afterEach(() => {
  ownerProbe.finish = async () => {};
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function observedPage() {
  const events = new EventEmitter();
  return Object.assign(events, {
    setViewportSize: async () => {
      throw new Error("literal workflow stop");
    },
    waitForLoadState: async () => {},
    screenshot: async () => Buffer.from("literal screenshot"),
    locator: () => ({
      evaluateAll: async () => ({ focused: {}, elements: [] }),
    }),
  });
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editing-observer-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "raw"));
  fs.writeFileSync(path.join(root, "raw/reference.wav"), "reference bytes");
  fs.writeFileSync(path.join(root, "raw/guest.wav"), "guest bytes");
  const projectPath = path.join(root, "episode.project.json");
  fs.writeFileSync(projectPath, "{}");
  ownerProbe.fixture = { projectPath, workspaceDir: root };
  return path.join(root, "out");
}
function read(events: EventEmitter, literal: string, body: Promise<string>) {
  const request = {
    url: () => `http://localhost/api/waveform-snap?literal=${literal}`,
    method: () => "GET",
  };
  events.emit("request", request);
  events.emit("response", {
    url: request.url,
    request: () => request,
    status: () => 200,
    text: () => body,
  });
  events.emit("requestfinished", request);
  return request;
}
function run(
  page: ReturnType<typeof observedPage>,
  output: string,
  taskId = "seek",
  routeId = "ruler-keyboard",
) {
  const task = editingTaskRegistry.find((row) => row.id === taskId)!;
  ownerProbe.state = task.start;
  return runEditingTask(
    page as unknown as Page,
    {} as CDPSession,
    { outputPath: () => path.join(output, "profile") } as unknown as TestInfo,
    task,
    routeId,
    output,
    "validity-only",
  );
}
it("waits for a request admitted while an earlier body is draining", async () => {
  const page = observedPage(),
    output = fixture();
  const first = deferred<string>(),
    late = deferred<string>(),
    command = deferred<string>();
  page.setViewportSize = async () => {
    read(
      page,
      "first",
      first.promise.then((body) => {
        read(page, "late", late.promise);
        const request = {
          url: () => "http://localhost/api/document/command",
          method: () => "POST",
          postData: () => '{"type":"LiteralLateCommand"}',
        };
        page.emit("request", request);
        page.emit("response", {
          url: request.url,
          request: () => request,
          status: () => 200,
          text: () => command.promise,
        });
        page.emit("requestfinished", request);
        return body;
      }),
    );
    throw new Error("literal workflow stop");
  };
  let settled = false;
  const result = run(page, output).then((trial) => {
    settled = true;
    return trial;
  });
  await nextTurn();
  first.resolve("literal first body");
  await nextTurn();
  const returnedBeforeLateBody = settled;
  late.resolve("literal late body");
  await nextTurn();
  const returnedBeforeLateCommand = settled;
  command.resolve("literal late command body");
  const trial = await result;
  expect({
    returnedBeforeLateBody,
    bodies: trial.journal
      .filter((row) => row.kind === "read-response")
      .map((row) => (row.kind === "read-response" ? row.body : "")),
  }).toEqual({
    returnedBeforeLateBody: false,
    bodies: ["literal first body", "literal late body"],
  });
  expect({
    returnedBeforeLateCommand,
    commands: trial.journal.filter(
      (row) => row.kind === "request" || row.kind === "response",
    ),
  }).toEqual({
    returnedBeforeLateCommand: false,
    commands: [
      {
        kind: "request",
        requestId: 3,
        type: "LiteralLateCommand",
        body: '{"type":"LiteralLateCommand"}',
        seq: 3,
        owner: "main",
        phase: "setup",
      },
      {
        kind: "response",
        requestId: 3,
        status: 200,
        body: "literal late command body",
        seq: 6,
        owner: "main",
        phase: "setup",
      },
    ],
  });
  expect(trial.failures).toEqual([
    {
      origin: { owner: "main", phase: "setup" },
      error: "Error: literal workflow stop",
      errorName: "Error",
    },
  ]);
});
it("retains a genuine body failure from the last profiler operation", async () => {
  const page = observedPage(),
    output = fixture();
  const body = deferred<string>();
  ownerProbe.finish = async () => {
    read(page, "profiler", body.promise);
  };
  const result = run(page, output);
  await nextTurn();
  body.reject(new Error("literal final body failure"));
  const trial = await result;
  expect(trial.journal).toEqual([
    {
      kind: "read-request",
      requestId: 1,
      url: "http://localhost/api/waveform-snap?literal=profiler",
      method: "GET",
      seq: 1,
      owner: "main",
      phase: "setup",
    },
    {
      errorName: "Error",
      kind: "read-body-failed",
      requestId: 1,
      status: 200,
      error: "Error: literal final body failure",
      seq: 2,
      owner: "main",
      phase: "setup",
    },
  ]);
});
it("returns an immutable journal after its explicit observation endpoint", async () => {
  const page = observedPage(),
    output = fixture();
  const externalErrors: string[] = [];
  page.on("pageerror", (error: Error) => externalErrors.push(error.message));
  ownerProbe.finish = async () => {
    read(page, "before-endpoint", Promise.resolve("literal terminal body"));
  };
  const trial = await run(page, output);
  const before = JSON.stringify(trial.journal);
  read(page, "after-endpoint", Promise.resolve("outside task window"));
  page.emit("pageerror", new Error("literal outside-window page error"));
  await nextTurn();
  expect({
    retained: trial.journal,
    unchanged: JSON.stringify(trial.journal) === before,
    externalErrors,
  }).toEqual({
    retained: [
      {
        kind: "read-request",
        requestId: 1,
        url: "http://localhost/api/waveform-snap?literal=before-endpoint",
        method: "GET",
        seq: 1,
        owner: "main",
        phase: "setup",
      },
      {
        kind: "read-response",
        requestId: 1,
        status: 200,
        body: "literal terminal body",
        seq: 2,
        owner: "main",
        phase: "setup",
      },
    ],
    unchanged: true,
    externalErrors: ["literal outside-window page error"],
  });
});

it("settles registered bodies before preserving the original failed wait", async () => {
  const page = observedPage(),
    output = fixture();
  const body = deferred<string>(),
    remaining = deferred<string>();
  const waitError = new Error("literal network idle failure");
  let originalErrorRetained = false;
  waitError.toString = function () {
    originalErrorRetained = this === waitError;
    return "Error: literal network idle failure";
  };
  page.setViewportSize = async () => {
    read(page, "failed-wait", body.promise);
    read(page, "remaining-job", remaining.promise);
    page.emit("request", {
      url: () => "http://localhost/api/waveform-snap?literal=orphan",
      method: () => "GET",
    });
    throw new Error("literal workflow stop");
  };
  page.waitForLoadState = async () => {
    throw waitError;
  };
  let settled = false;
  const result = run(page, output).then((trial) => {
    settled = true;
    return trial;
  });
  await nextTurn();
  const returnedBeforeBody = settled;
  body.reject(new Error("literal unavailable body"));
  await nextTurn();
  const returnedAfterFirstFailure = settled;
  remaining.resolve("literal remaining body");
  const trial = await result;
  const retained = JSON.stringify(trial);
  read(page, "after-failed-endpoint", Promise.resolve("outside failed window"));
  await nextTurn();
  expect({
    returnedBeforeBody,
    returnedAfterFirstFailure,
    originalErrorRetained,
    failures: trial.failures,
    journal: trial.journal,
    unchanged: JSON.stringify(trial) === retained,
  }).toEqual({
    returnedBeforeBody: false,
    returnedAfterFirstFailure: false,
    originalErrorRetained: true,
    failures: [
      {
        origin: { owner: "main", phase: "setup" },
        error: "Error: literal workflow stop",
        errorName: "Error",
      },
      {
        origin: { owner: "main", phase: "setup" },
        error: "main response drain: Error: literal network idle failure",
        errorName: "Error",
      },
    ],
    journal: [
      {
        kind: "read-request",
        requestId: 1,
        url: "http://localhost/api/waveform-snap?literal=failed-wait",
        method: "GET",
        seq: 1,
        owner: "main",
        phase: "setup",
      },
      {
        kind: "read-request",
        requestId: 2,
        url: "http://localhost/api/waveform-snap?literal=remaining-job",
        method: "GET",
        seq: 2,
        owner: "main",
        phase: "setup",
      },
      {
        kind: "read-request",
        requestId: 3,
        url: "http://localhost/api/waveform-snap?literal=orphan",
        method: "GET",
        seq: 3,
        owner: "main",
        phase: "setup",
      },
      {
        errorName: "Error",
        kind: "read-body-failed",
        requestId: 1,
        status: 200,
        error: "Error: literal unavailable body",
        seq: 4,
        owner: "main",
        phase: "setup",
      },
      {
        kind: "read-response",
        requestId: 2,
        status: 200,
        body: "literal remaining body",
        seq: 5,
        owner: "main",
        phase: "setup",
      },
    ],
    unchanged: true,
  });
  expect(
    assessEditingTrial(
      editingTaskRegistry.find((row) => row.id === "seek")!,
      trial,
    ).reasons.filter((reason) => reason.startsWith("read ")),
  ).toEqual([
    "read 1 has 0 terminal outcomes",
    "read 3 has 0 terminal outcomes",
    "read body 1 failed Error: literal unavailable body",
  ]);
});
it("retains both real failed-request and unavailable-body facts", async () => {
  const page = observedPage(),
    output = fixture();
  const body = deferred<string>();
  page.setViewportSize = async () => {
    const request = read(page, "aborted", body.promise);
    page.emit(
      "requestfailed",
      Object.assign(request, {
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      }),
    );
    throw new Error("literal workflow stop");
  };
  const result = run(page, output);
  await nextTurn();
  body.reject(new Error("literal missing resource"));
  const trial = await result;
  expect(trial.journal).toEqual([
    {
      kind: "read-request",
      requestId: 1,
      url: "http://localhost/api/waveform-snap?literal=aborted",
      method: "GET",
      seq: 1,
      owner: "main",
      phase: "setup",
    },
    {
      kind: "read-failed",
      requestId: 1,
      error: "net::ERR_ABORTED",
      seq: 2,
      owner: "main",
      phase: "setup",
    },
    {
      errorName: "Error",
      kind: "read-body-failed",
      requestId: 1,
      status: 200,
      error: "Error: literal missing resource",
      seq: 3,
      owner: "main",
      phase: "setup",
    },
  ]);
  const assessment = assessEditingTrial(
    editingTaskRegistry.find((row) => row.id === "seek")!,
    trial,
  );
  expect(
    assessment.reasons.filter((reason) => reason.startsWith("read ")),
  ).toEqual([
    "read 1 failed net::ERR_ABORTED without admitted replacement",
    "read body 1 failed Error: literal missing resource",
  ]);
});
it("owns an ancillary HTTP body admitted while another body settles", async () => {
  const page = observedPage(),
    output = fixture();
  const first = deferred<string>(),
    ancillary = deferred<string>();
  page.setViewportSize = async () => {
    read(
      page,
      "first",
      first.promise.then((body) => {
        const request = {
          url: () => "http://localhost/broken-asset.svg",
          method: () => "GET",
        };
        page.emit("response", {
          url: request.url,
          request: () => request,
          status: () => 503,
          text: () => ancillary.promise,
        });
        return body;
      }),
    );
    throw new Error("literal workflow stop");
  };
  let settled = false;
  const result = run(page, output).then((trial) => {
    settled = true;
    return trial;
  });
  await nextTurn();
  first.resolve("literal first body");
  await nextTurn();
  const returnedBeforeAncillary = settled;
  ancillary.resolve("literal ancillary failure details");
  const trial = await result;
  expect({
    returnedBeforeAncillary,
    errors: trial.journal.filter((row) => row.kind === "error"),
  }).toEqual({
    returnedBeforeAncillary: false,
    errors: [
      {
        kind: "error",
        message: "HTTP 503 GET http://localhost/broken-asset.svg",
        seq: 2,
        owner: "main",
        phase: "setup",
      },
      {
        kind: "error",
        message:
          "HTTP error body http://localhost/broken-asset.svg literal ancillary failure details",
        seq: 4,
        owner: "main",
        phase: "setup",
      },
    ],
  });
});
it("finishes cancellation observation before its owned context closes", async () => {
  const page = observedPage(),
    canceled = observedPage(),
    output = fixture();
  const body = deferred<string>();
  let closedJournal: unknown;
  const context = {
    newPage: async () => canceled,
    newCDPSession: async () => ({}),
    close: async () => {
      const request = {
        url: () => "http://localhost/api/waveform-snap?literal=teardown",
        method: () => "GET",
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      };
      canceled.emit("request", request);
      canceled.emit("requestfailed", request);
      closedJournal = JSON.parse(
        fs.readFileSync(path.join(output, "trial.json"), "utf8"),
      ).journal;
    },
  };
  Object.assign(canceled, { context: () => context });
  Object.assign(page, {
    context: () => ({ browser: () => ({ newContext: async () => context }) }),
  });
  canceled.setViewportSize = async () => {
    read(canceled, "before-cancel-close", body.promise);
    throw new Error("literal cancel workflow stop");
  };
  const result = run(page, output, "trim", "handle-keyboard");
  await nextTurn();
  body.resolve("literal canceled page body");
  const trial = await result;
  const journal = [
    {
      kind: "read-request",
      requestId: 1,
      url: "http://localhost/api/waveform-snap?literal=before-cancel-close",
      method: "GET",
      seq: 1,
      owner: "cancel",
      probe: "cancel",
      phase: "setup",
    },
    {
      kind: "read-response",
      requestId: 1,
      status: 200,
      body: "literal canceled page body",
      seq: 2,
      owner: "cancel",
      probe: "cancel",
      phase: "setup",
    },
  ];
  expect({
    journal: trial.journal,
    closedJournal,
    failures: trial.failures,
  }).toEqual({
    journal,
    closedJournal: journal,
    failures: [
      {
        origin: { owner: "cancel", phase: "setup", probe: "cancel" },
        error: "cancel: Error: literal cancel workflow stop",
        errorName: "Error",
      },
      {
        origin: { owner: "main", phase: "setup" },
        error: "Error: literal workflow stop",
        errorName: "Error",
      },
    ],
  });
});

it("bounds unavailable bodies without a journal writer after timeout", async () => {
  const page = observedPage(),
    output = fixture();
  const body = deferred<string>();
  page.setViewportSize = async () => {
    read(page, "bounded-body", body.promise);
    throw new Error("literal workflow stop");
  };
  page.waitForLoadState = async () => {
    throw new Error("literal failed idle wait");
  };
  const result = run(page, output);
  const trial = await result;
  const before = JSON.stringify(trial);
  body.resolve("body settled after its actual retrieval bound");
  await nextTurn();
  expect({
    journal: trial.journal,
    failures: trial.failures,
    unchanged: JSON.stringify(trial) === before,
  }).toEqual({
    journal: [
      {
        kind: "read-request",
        requestId: 1,
        url: "http://localhost/api/waveform-snap?literal=bounded-body",
        method: "GET",
        seq: 1,
        owner: "main",
        phase: "setup",
      },
      {
        errorName: "Error",
        kind: "read-body-failed",
        requestId: 1,
        status: 200,
        error: "Error: Editing response body drain timed out",
        seq: 2,
        owner: "main",
        phase: "setup",
      },
    ],
    failures: [
      {
        origin: { owner: "main", phase: "setup" },
        error: "Error: literal workflow stop",
        errorName: "Error",
      },
      {
        origin: { owner: "main", phase: "setup" },
        error: "main response drain: Error: literal failed idle wait",
        errorName: "Error",
      },
    ],
    unchanged: true,
  });
}, 10000);

it("retains an admitted clone command body failure with its full original owner", async () => {
  const page = observedPage(),
    canceled = observedPage(),
    output = fixture();
  const body = deferred<string>();
  let status = 201;
  const context = {
    newPage: async () => canceled,
    newCDPSession: async () => ({}),
    close: async () => {},
  };
  Object.assign(canceled, { context: () => context });
  Object.assign(page, {
    context: () => ({ browser: () => ({ newContext: async () => context }) }),
  });
  canceled.setViewportSize = async () => {
    const request = {
      url: () => "http://localhost/api/document/command",
      method: () => "POST",
      postData: () => '{"type":"LiteralCloneCommand"}',
    };
    canceled.emit("request", request);
    canceled.emit("response", {
      url: request.url,
      request: () => request,
      status: () => status,
      text: () => body.promise,
    });
    throw new Error("literal cancel workflow stop");
  };
  const result = run(page, output, "trim", "handle-keyboard");
  await nextTurn();
  status = 503;
  body.reject(new Error("literal clone body unavailable"));
  const t = await result;
  expect(
    t.journal.filter(
      (row) => row.kind === "request" || row.kind === "command-body-failed",
    ),
  ).toEqual([
    {
      seq: 1,
      owner: "cancel",
      probe: "cancel",
      phase: "setup",
      kind: "request",
      requestId: 1,
      type: "LiteralCloneCommand",
      body: '{"type":"LiteralCloneCommand"}',
    },
    {
      seq: 2,
      owner: "cancel",
      probe: "cancel",
      phase: "setup",
      kind: "command-body-failed",
      requestId: 1,
      status: 201,
      error: "Error: literal clone body unavailable",
      errorName: "Error",
    },
  ]);
  expect(
    assessEditingTrial(
      editingTaskRegistry.find((row) => row.id === "trim")!,
      t,
    ),
  ).toMatchObject({ status: "fail", completedWork: 0 });
});

it("classifies a failed observation wait with no owned pending work as a trust failure", async () => {
  const page = observedPage(),
    output = fixture();
  page.waitForLoadState = async () => {
    throw new Error("literal unowned wait failure");
  };
  const t = await run(page, output);
  expect(t.failures).toEqual([
    {
      origin: { owner: "main", phase: "setup" },
      error: "Error: literal workflow stop",
      errorName: "Error",
    },
    {
      origin: { owner: "global", blocks: "all-proofs" },
      error: "main response drain: Error: literal unowned wait failure",
      errorName: "Error",
    },
  ]);
  expect(assessEditingTrial(editingTaskRegistry[0], t)).toMatchObject({
    status: "fail",
    completedWork: 0,
    observations: {
      save: "fail",
      cancel: "not-applicable",
      undo: "not-applicable",
    },
  });
});
