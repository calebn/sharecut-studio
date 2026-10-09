import { expect, it } from "vitest";
import { assessEditingTrial, type EditingTrial } from "./editingTaskReport";
import { definition, trial } from "./editingTaskTestFixtures";

function canceledReadTrial(replaced: boolean): EditingTrial {
  const t = trial();
  const url =
    "http://127.0.0.1:1234/api/document/state?path=%2Ftmp%2Ftask.json&phase=detail";
  t.journal.push({
    seq: 8,
    owner: "main",
    phase: "setup",
    kind: "read-request",
    requestId: 3,
    url,
    method: "GET",
  });
  t.journal.push({
    seq: 9,
    owner: "main",
    phase: "setup",
    kind: "read-failed",
    requestId: 3,
    error: "net::ERR_ABORTED",
  });
  if (replaced) {
    t.journal.push({
      seq: 10,
      owner: "main",
      phase: "setup",
      kind: "read-request",
      requestId: 4,
      url,
      method: "GET",
    });
    t.journal.push({
      seq: 11,
      owner: "main",
      phase: "setup",
      kind: "read-response",
      requestId: 4,
      status: 200,
      body: '{"server_seq":0,"state_token":"0000000000000000000000000000000000000000000000000000000000000000"}',
    });
  }
  return t;
}
it("rejects ancillary app HTTP errors despite completed saved work", () => {
  const t = trial();
  t.journal.push({
    seq: 8,
    owner: "main",
    phase: "setup",
    kind: "error",
    message: "HTTP 500 GET /record/share-registry",
  });
  expect(assessEditingTrial(definition, t).status).toBe("fail");
  expect(assessEditingTrial(definition, t).reasons).toEqual([
    "HTTP 500 GET /record/share-registry",
  ]);
});
it("retains unknown responses and duplicate mutations as failures", () => {
  const t = trial();
  t.journal.push({
    seq: 8,
    owner: "main",
    phase: "action",
    kind: "request",
    requestId: 3,
    type: "Surprise",
    body: '{"ok":true,"type":"Applied"}',
  });
  expect(assessEditingTrial(definition, t).reasons).toEqual([
    "request 3 has no response",
    "unexpected action command Surprise",
  ]);
});
it("rejects successful HTTP with an unknown command outcome", () => {
  const t = trial();
  t.journal[2] = {
    seq: 3,
    owner: "main",
    phase: "action",
    kind: "response",
    requestId: 1,
    status: 200,
    body: "{}",
  };
  expect(assessEditingTrial(definition, t).reasons).toEqual([
    "request 1 has unknown outcome",
  ]);
});
it("rejects a canceled detail read without a successful replacement", () => {
  expect(
    assessEditingTrial(definition, canceledReadTrial(false)).reasons,
  ).toEqual(["read 3 failed net::ERR_ABORTED without admitted replacement"]);
});
it("retains and classifies the replaced setup detail read", () => {
  const result = assessEditingTrial(definition, canceledReadTrial(true));
  expect(result.status).toBe("pass");
  expect(result.canceledReads).toBe(1);
});
it.each(["action", "other-project", "HTTP500", "unknown-body"])(
  "rejects detail cancellation with %s replacement evidence",
  (fault) => {
    const t = canceledReadTrial(true);
    for (const row of t.journal) {
      if (
        (row.kind === "read-request" || row.kind === "read-failed") &&
        fault === "action"
      )
        row.phase = "action";
      if (
        row.kind === "read-request" &&
        row.requestId === 4 &&
        fault === "other-project"
      )
        row.url =
          "http://127.0.0.1:1234/api/document/state?path=%2Ftmp%2Fother.json&phase=detail";
      if (row.kind === "read-response" && fault === "HTTP500") row.status = 500;
      if (row.kind === "read-response" && fault === "unknown-body")
        row.body = "{}";
    }
    const result = assessEditingTrial(definition, t);
    expect(result.status).toBe("fail");
    expect(result.canceledReads).toBe(0);
  },
);
it("admits replacement before abort callback with valid source request order", () => {
  const t = canceledReadTrial(true);
  const failed = t.journal.find((row) => row.kind === "read-failed")!;
  const replacement = t.journal.find(
    (row) => row.kind === "read-request" && row.requestId === 4,
  )!;
  replacement.seq = 9;
  failed.seq = 10;
  t.journal.sort((a, b) => a.seq - b.seq);
  expect(assessEditingTrial(definition, t).status).toBe("pass");
  expect(assessEditingTrial(definition, t).canceledReads).toBe(1);
});
it.each(["same-request", "duplicate-response"])(
  "rejects %s as replacement read evidence",
  (fault) => {
    const t = canceledReadTrial(true);
    if (fault === "same-request") {
      for (const row of t.journal)
        if (
          (row.kind === "read-request" || row.kind === "read-response") &&
          row.requestId === 4
        )
          row.requestId = 3;
    } else {
      t.journal.push({
        seq: 12,
        owner: "main",
        phase: "setup",
        kind: "read-response",
        requestId: 4,
        status: 200,
        body: '{"server_seq":0,"state_token":"0000000000000000000000000000000000000000000000000000000000000000"}',
      });
    }
    expect(assessEditingTrial(definition, t).status).toBe("fail");
    expect(assessEditingTrial(definition, t).canceledReads).toBe(0);
  },
);
it("rejects replacement before original read", () => {
  const t = canceledReadTrial(true);
  for (const row of t.journal) {
    if (row.seq <= 7) row.seq++;
    else if (row.kind === "read-request") row.seq = row.requestId === 3 ? 9 : 1;
    else if (row.kind === "read-failed") row.seq = 10;
  }
  t.journal.sort((a, b) => a.seq - b.seq);
  expect(assessEditingTrial(definition, t).reasons).toEqual([
    "read 3 failed net::ERR_ABORTED without admitted replacement",
  ]);
});
it("rejects replacement response before failed callback", () => {
  const t = canceledReadTrial(true);
  for (const row of t.journal) {
    if (row.kind === "read-failed") row.seq = 11;
    else if (row.kind === "read-response") row.seq = 9;
  }
  t.journal.sort((a, b) => a.seq - b.seq);
  expect(assessEditingTrial(definition, t).reasons).toEqual([
    "outcome 4 order or phase differs",
    "read 3 failed net::ERR_ABORTED without admitted replacement",
  ]);
});
it("rejects a successful setup Surprise command", () => {
  const t = trial();
  t.journal.push(
    {
      seq: 8,
      owner: "main",
      phase: "setup",
      kind: "request",
      requestId: 3,
      type: "Surprise",
      body: "{}",
    },
    {
      seq: 9,
      owner: "main",
      phase: "setup",
      kind: "response",
      requestId: 3,
      status: 200,
      body: '{"ok":true,"type":"Applied"}',
    },
  );
  expect(assessEditingTrial(definition, t)).toMatchObject({
    status: "fail",
    accidentalCommands: 1,
  });
});
it.each([undefined, "broken", NaN, Infinity, 99, 600, 200.5])(
  "rejects malformed Undo status %s",
  (status) => {
    const t = trial();
    Object.assign(t.journal[6], { status });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
it.each([undefined, "1", NaN, Infinity, 0, 1.5])(
  "rejects malformed journal sequence %s",
  (seq) => {
    const t = trial();
    Object.assign(t.journal[0], { seq });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
it("rejects an orphan failed command response", () => {
  const t = trial();
  t.journal.push({
    seq: 8,
    owner: "main",
    phase: "undo",
    kind: "response",
    requestId: 999,
    status: 500,
    body: "{}",
  });
  expect(assessEditingTrial(definition, t).status).toBe("fail");
});
it("rejects a pending document read", () => {
  const t = trial();
  t.journal.push({
    seq: 8,
    owner: "main",
    phase: "action",
    kind: "read-request",
    requestId: 8,
    url: "http://localhost/api/document/state?path=x&phase=detail",
    method: "GET",
  });
  expect(assessEditingTrial(definition, t).status).toBe("fail");
});
it("rejects a successful unknown document snapshot", () => {
  const t = trial();
  t.journal.push(
    {
      seq: 8,
      owner: "main",
      phase: "action",
      kind: "read-request",
      requestId: 8,
      url: "http://localhost/api/document/state?path=x&phase=detail",
      method: "GET",
    },
    {
      seq: 9,
      owner: "main",
      phase: "action",
      kind: "read-response",
      requestId: 8,
      status: 200,
      body: "{}",
    },
  );
  expect(assessEditingTrial(definition, t).status).toBe("fail");
});
it.each(["setup", "action", "cancel", "undo"] as const)(
  "rejects orphan and malformed read outcomes in %s",
  (phase) => {
    const t = trial();
    t.journal.push({
      seq: 8,
      ...(phase === "cancel"
        ? { owner: "cancel" as const, probe: "cancel", phase }
        : { owner: "main" as const, phase }),
      kind: "read-response",
      requestId: 999,
      status: 200,
      body: "{}",
    });
    expect(assessEditingTrial(definition, t).reasons).toContain(
      "orphan outcome 999",
    );
    Object.assign(t.journal[7], { status: undefined });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
it.each([
  "matching",
  "missing-abort",
  "wrong-id",
  "action",
  "ordinary-error",
  "HTTP500",
])("admits only matching canceled body error %s", (fault) => {
  const t = canceledReadTrial(true);
  t.journal.push({
    seq: 12,
    owner: "main",
    phase: fault === "action" ? "action" : "setup",
    errorName: "Error",
    kind: "read-body-failed",
    requestId: fault === "wrong-id" ? 4 : 3,
    status: fault === "HTTP500" ? 500 : 200,
    error:
      fault === "ordinary-error"
        ? "ordinary failure"
        : "Error: response.text: Protocol error (Network.getResponseBody): No data found for resource with given identifier",
  });
  if (fault === "missing-abort")
    t.journal = t.journal.filter((row) => row.kind !== "read-failed");
  expect(assessEditingTrial(definition, t).status).toBe(
    fault === "matching" ? "pass" : "fail",
  );
});
it.each(["duplicate", "wrong-phase", "wrong-order", "wrong-Undo"])(
  "rejects command ownership %s",
  (fault) => {
    const t = trial();
    if (fault === "duplicate") t.journal.push({ ...t.journal[6], seq: 8 });
    else if (fault === "wrong-phase") t.journal[6].phase = "action";
    else if (fault === "wrong-order") t.journal[6].seq = 1;
    else Object.assign(t.journal[5], { type: "Surprise" });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
it.each([undefined, "3", NaN, Infinity, 0, 1.5])(
  "rejects retained request ID %s",
  (requestId) => {
    const t = trial();
    Object.assign(t.journal[5], { requestId });
    expect(assessEditingTrial(definition, t).status).toBe("fail");
  },
);
it.each([201, 404, 503])(
  "treats unavailable command body HTTP%s as one fatal terminal without a mutation",
  (status) => {
    const t = trial();
    t.journal[2] = {
      seq: 3,
      owner: "main",
      phase: "action",
      kind: "command-body-failed",
      requestId: 1,
      status,
      error: "literal unavailable command body",
      errorName: null,
    };
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      mutations: 0,
      canceledReads: 0,
      observations: { save: "fail", cancel: "pass", undo: "fail" },
    });
    expect(assessEditingTrial(definition, t).reasons).toEqual([
      "command body 1 failed literal unavailable command body",
      "action expected 1 mutations, observed 0",
    ]);
  },
);
it.each(["duplicate", "mixed", "orphan", "owner", "order", "malformed"])(
  "rejects command body terminal %s",
  (fault) => {
    const t = trial();
    const terminal = {
      seq: 7,
      owner: "main" as const,
      phase: "undo" as const,
      kind: "command-body-failed" as const,
      requestId: 2,
      status: 201,
      error: "literal Undo body unavailable",
      errorName: "Error",
    };
    t.journal[6] = terminal;
    if (fault === "duplicate") t.journal.push({ ...terminal, seq: 8 });
    if (fault === "mixed")
      t.journal.push({
        seq: 8,
        owner: "main",
        phase: "undo",
        kind: "response",
        requestId: 2,
        status: 200,
        body: '{"ok":true,"type":"Applied"}',
      });
    if (fault === "orphan") terminal.requestId = 999;
    if (fault === "owner")
      Object.assign(terminal, {
        owner: "cancel",
        phase: "cancel",
        probe: "cancel",
      });
    if (fault === "order") terminal.seq = 1;
    if (fault === "malformed")
      Object.assign(terminal, { errorName: undefined });
    expect(assessEditingTrial(definition, t)).toMatchObject({
      status: "fail",
      completedWork: 0,
      observations:
        fault === "orphan" || fault === "order" || fault === "malformed"
          ? { save: "fail", cancel: "fail", undo: "fail" }
          : fault === "owner"
            ? { save: "pass", cancel: "fail", undo: "fail" }
            : { save: "pass", cancel: "pass", undo: "fail" },
    });
  },
);
