import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { e2eAuthStores, ownedE2eAuthStores } from "./runtimeEnv";

type BackendSource = {
  cwd: string;
  executable: string;
  module: string;
  sourceHash: string;
};
type ProtocolIdentity = BackendSource & {
  moduleName: "podcast_mcp.gui.server";
  productionDist: string;
};
type CleanupOwner = Readonly<{
  directory: string;
  manifestPath: string;
  device: string;
  inode: string;
  uid: string;
  mode: number;
}>;
type BoundIdentity = ProtocolIdentity & {
  shareRegistry: string;
};
type BindRequest = {
  version: 2;
  protocolHash: string;
  host: "127.0.0.1";
  port: number;
  expected: BoundIdentity;
};
type BindReceipt = Omit<BindRequest, "expected"> & {
  pid: number;
  actual: BoundIdentity;
};
type ProcessIdentity = { pid: number; parentPid: number; startTime: string };
type LaunchRecord = {
  version: 2;
  protocolHash: string;
  attempt: string;
  port: number;
  wrapper: ProcessIdentity;
  child: ProcessIdentity;
  command: string[];
  requestHash: string;
  cleanupOwner: CleanupOwner;
};
type LiveFacts = {
  process: ProcessIdentity;
  ancestry: ProcessIdentity[];
  listenerInode: string;
  listenerFd: string;
  cwd: string;
  executable: string;
  productionDist: string;
  shareRegistry: string;
  shareIdentity: string;
  cleanupOwner: CleanupOwner;
  health: { status: 200; ok: true };
};
type Observation = {
  version: 2;
  phase: "before" | "after";
  protocolHash: string;
  attempt: string;
  port: number;
  receipt: { bytes: string; sha256: string };
  launch: { bytes: string; sha256: string };
  facts: LiveFacts;
};
export type BackendEvidence = Readonly<{
  phase: "before" | "after";
  protocolHash: string;
  pid: number;
  startTime: string;
  listenerInode: string;
  receiptHash: string;
  launchHash: string;
  verificationHash: string;
}>;
export type BackendAdmission =
  | { kind: "admitted"; before: BackendEvidence; after: BackendEvidence }
  | { kind: "rejected"; reason: string };

const sourceKey = "src/podcast_mcp/gui/server.py";
const identityDirectory = (attempt: string) =>
  path.join(attempt, "backend-identity");
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Editing backend identity requires an object");
  return value as Record<string, unknown>;
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  const row = object(value);
  same(Object.keys(row).sort(), keys.sort(), "wire fields");
  return row;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Editing backend identity requires nonempty text");
  return value;
}
function digest(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{64}$/.test(result))
    throw new Error("Editing backend identity requires a SHA256 digest");
  return result;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new Error("Editing backend identity requires a positive integer");
  return value;
}
function same(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Editing backend ${label} differs`);
}
function decimal(value: unknown): string {
  const result = text(value);
  if (!/^(0|[1-9][0-9]*)$/.test(result))
    throw new Error("Editing backend owner requires decimal stat metadata");
  return result;
}
function retainedPath(value: unknown): string {
  const result = text(value);
  if (
    !path.isAbsolute(result) ||
    path.resolve(result) !== result ||
    result.includes("\0")
  )
    throw new Error("Editing backend owner requires canonical absolute paths");
  return result;
}
function parseCleanupOwner(value: unknown): CleanupOwner {
  const row = fields(value, [
    "directory",
    "manifestPath",
    "device",
    "inode",
    "uid",
    "mode",
  ]);
  const directory = retainedPath(row.directory);
  const manifestPath = retainedPath(row.manifestPath);
  if (
    !path.basename(directory).startsWith("sharecut-e2e-cleanup-") ||
    manifestPath !== path.join(directory, "workspaces.json") ||
    typeof row.mode !== "number" ||
    !Number.isSafeInteger(row.mode) ||
    row.mode < 0 ||
    row.mode > 0o777 ||
    (row.mode & 0o077) !== 0
  )
    throw new Error("Editing backend retained cleanup owner differs");
  return {
    directory,
    manifestPath,
    device: decimal(row.device),
    inode: decimal(row.inode),
    uid: decimal(row.uid),
    mode: row.mode,
  };
}
function captureCleanupOwner(env: NodeJS.ProcessEnv): CleanupOwner {
  const manifest = env.DAW_E2E_CLEANUP_MANIFEST;
  if (!manifest) throw new Error("E2E cleanup manifest is required");
  const stores = ownedE2eAuthStores(manifest);
  const capture = (): CleanupOwner => {
    const info = fs.statSync(stores.directory, { bigint: true });
    return {
      directory: stores.directory,
      manifestPath: path.join(stores.directory, "workspaces.json"),
      device: info.dev.toString(),
      inode: info.ino.toString(),
      uid: info.uid.toString(),
      mode: Number(info.mode & 0o777n),
    };
  };
  const owner = capture();
  same(
    [
      path.resolve(text(env.PODCAST_SHARE_REGISTRY)),
      path.resolve(text(env.PODCAST_SHARE_IDENTITY)),
    ],
    [stores.shareRegistry, stores.shareIdentity],
    "selected auth paths",
  );
  same(ownedE2eAuthStores(manifest), stores, "owner paths during capture");
  same(capture(), owner, "cleanup owner during capture");
  return owner;
}
function boundIdentity(
  protocol: ProtocolIdentity,
  owner: CleanupOwner,
): BoundIdentity {
  return {
    ...protocol,
    shareRegistry: e2eAuthStores(owner.directory).shareRegistry,
  };
}
function writeOwned(file: string, value: unknown): void {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function admitImportedBackend(
  repo: string,
  productFiles: Record<string, string>,
  input: unknown,
): BackendSource {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Backend import provenance returned invalid metadata");
  const backend = object(input);
  if (
    typeof backend.cwd !== "string" ||
    !backend.cwd.trim() ||
    typeof backend.executable !== "string" ||
    !backend.executable.trim() ||
    typeof backend.module !== "string" ||
    !backend.module.trim()
  )
    throw new Error("Backend import provenance returned invalid metadata");
  const canonicalRepo = fs.realpathSync(repo);
  if (fs.realpathSync(backend.cwd) !== canonicalRepo)
    throw new Error("Backend import is outside verified app source");
  const serverPath = path.join(canonicalRepo, sourceKey);
  const canonicalModule = fs.realpathSync(backend.module);
  const reject = (): never => {
    throw new Error("Backend import does not match admitted server source");
  };
  if (canonicalModule !== serverPath) reject();
  for (const file of [serverPath, backend.module]) {
    const root = [canonicalRepo, repo].find((candidate) =>
      file.startsWith(`${candidate}${path.sep}`),
    );
    if (!root) return reject();
    let componentPath = canonicalRepo;
    for (const component of file.slice(root.length + 1).split(path.sep)) {
      componentPath = path.join(componentPath, component);
      const relative = path.relative(canonicalRepo, componentPath);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        fs.lstatSync(componentPath).isSymbolicLink()
      )
        reject();
    }
    if (!fs.lstatSync(componentPath).isFile()) reject();
  }
  const sourceHash = hash(fs.readFileSync(canonicalModule));
  if (sourceHash !== productFiles[sourceKey]) reject();
  return {
    cwd: canonicalRepo,
    executable: backend.executable,
    module: canonicalModule,
    sourceHash,
  };
}

function protocolIdentity(
  protocolFile: string,
  protocolHash: string,
): ProtocolIdentity {
  const bytes = fs.readFileSync(protocolFile);
  same(hash(bytes), digest(protocolHash), "protocol bytes");
  const protocol = object(JSON.parse(bytes.toString("utf8")));
  if (protocol.version !== 8)
    throw new Error("Editing backend requires protocol8");
  const backend = object(protocol.backend);
  const inventory = object(object(protocol.source).productFiles);
  const cwd = text(backend.cwd);
  const module = text(backend.module);
  const sourceHash = digest(backend.sourceHash);
  same(module, path.join(cwd, sourceKey), "protocol server path");
  same(sourceHash, digest(inventory[sourceKey]), "protocol server inventory");
  return {
    cwd,
    executable: text(backend.executable),
    module,
    sourceHash,
    moduleName: "podcast_mcp.gui.server",
    productionDist: text(protocol.productionDist),
  };
}
function requestIdentity(
  protocolFile: string,
  protocolHash: string,
  owner: CleanupOwner,
  port: number,
): BindRequest {
  if (process.platform !== "linux")
    throw new Error("Editing backend listener identity requires Linux");
  const expected = boundIdentity(
    protocolIdentity(protocolFile, protocolHash),
    owner,
  );
  const admitted = admitImportedBackend(
    expected.cwd,
    { [sourceKey]: expected.sourceHash },
    expected,
  );
  return {
    version: 2,
    protocolHash,
    host: "127.0.0.1",
    port: integer(port, 65535),
    expected: {
      ...admitted,
      executable: fs.realpathSync(expected.executable),
      moduleName: "podcast_mcp.gui.server",
      productionDist: fs.realpathSync(expected.productionDist),
      shareRegistry: path.resolve(expected.shareRegistry),
    },
  };
}
function parseIdentity(value: unknown): BoundIdentity {
  const row = fields(value, [
    "cwd",
    "executable",
    "module",
    "sourceHash",
    "moduleName",
    "productionDist",
    "shareRegistry",
  ]);
  if (row.moduleName !== "podcast_mcp.gui.server")
    throw new Error("Editing backend factory module differs");
  return {
    cwd: text(row.cwd),
    executable: text(row.executable),
    module: text(row.module),
    sourceHash: digest(row.sourceHash),
    moduleName: row.moduleName,
    productionDist: text(row.productionDist),
    shareRegistry: text(row.shareRegistry),
  };
}
function parseRequest(bytes: string): BindRequest {
  const row = fields(JSON.parse(bytes), [
    "version",
    "protocolHash",
    "host",
    "port",
    "expected",
  ]);
  if (row.version !== 2 || row.host !== "127.0.0.1")
    throw new Error("Editing backend bind request version or host differs");
  return {
    version: 2,
    protocolHash: digest(row.protocolHash),
    host: row.host,
    port: integer(row.port, 65535),
    expected: parseIdentity(row.expected),
  };
}
function parseReceipt(bytes: string): BindReceipt {
  const row = fields(JSON.parse(bytes), [
    "version",
    "protocolHash",
    "host",
    "port",
    "pid",
    "actual",
  ]);
  if (row.version !== 2 || row.host !== "127.0.0.1")
    throw new Error("Editing backend bind receipt version or host differs");
  return {
    version: 2,
    protocolHash: digest(row.protocolHash),
    host: row.host,
    port: integer(row.port, 65535),
    pid: integer(row.pid),
    actual: parseIdentity(row.actual),
  };
}
function parseProcess(value: unknown): ProcessIdentity {
  const row = fields(value, ["pid", "parentPid", "startTime"]);
  const startTime = text(row.startTime);
  if (!/^\d+$/.test(startTime))
    throw new Error("Editing backend process start time differs");
  return {
    pid: integer(row.pid),
    parentPid: integer(row.parentPid),
    startTime,
  };
}
function parseLaunch(bytes: string): LaunchRecord {
  const row = fields(JSON.parse(bytes), [
    "version",
    "protocolHash",
    "attempt",
    "port",
    "wrapper",
    "child",
    "command",
    "requestHash",
    "cleanupOwner",
  ]);
  if (
    row.version !== 2 ||
    !Array.isArray(row.command) ||
    row.command.length === 0
  )
    throw new Error("Editing backend launch record differs");
  return {
    version: 2,
    protocolHash: digest(row.protocolHash),
    attempt: text(row.attempt),
    port: integer(row.port, 65535),
    wrapper: parseProcess(row.wrapper),
    child: parseProcess(row.child),
    command: row.command.map(text),
    requestHash: digest(row.requestHash),
    cleanupOwner: parseCleanupOwner(row.cleanupOwner),
  };
}
function nativeProcess(pid: number): ProcessIdentity {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  if (["Z", "X"].includes(fields[0]))
    throw new Error("Editing backend process has exited");
  return parseProcess({
    pid,
    parentPid: Number(fields[1]),
    startTime: fields[19],
  });
}
function environment(pid: number): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf("=");
        return [entry.slice(0, at), entry.slice(at + 1)];
      }),
  );
}
function census(attempt: string, port: number) {
  const candidates = fs
    .readdirSync("/proc")
    .filter((pid) => /^\d+$/.test(pid))
    .flatMap((pid) => {
      try {
        const command = fs
          .readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .split("\0")
          .filter(Boolean);
        const at = command.indexOf("--port");
        if (
          at < 0 ||
          command[at + 1] !== String(port) ||
          !command.includes("gui")
        )
          return [];
        const executable = fs.realpathSync(`/proc/${pid}/exe`);
        if (!path.basename(executable).startsWith("python")) return [];
        const env = environment(Number(pid));
        return [
          {
            pid: Number(pid),
            command,
            executable,
            cwd: fs.realpathSync(`/proc/${pid}/cwd`),
            productionDist: env.PODCAST_GUI_DIST,
            shareRegistry: env.PODCAST_SHARE_REGISTRY,
          },
        ];
      } catch {
        return [];
      }
    });
  fs.writeFileSync(
    path.join(attempt, "live-backend.json"),
    JSON.stringify(candidates, null, 2),
  );
  if (candidates.length !== 1)
    throw new Error("Editing backend requires one advertised GUI process");
  return candidates[0];
}
function listener(pid: number, port: number) {
  same(
    fs.readlinkSync(`/proc/${pid}/ns/net`),
    fs.readlinkSync("/proc/self/ns/net"),
    "network namespace",
  );
  const address = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  const rows = fs
    .readFileSync(`/proc/${pid}/net/tcp`, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/));
  const listening = rows.filter((row) => row[1] === address && row[3] === "0A");
  if (listening.length !== 1 || !/^\d+$/.test(listening[0][9]))
    throw new Error(
      "Editing backend has no exclusive leased loopback listener",
    );
  const listenerInode = listening[0][9];
  const listenerFd = fs.readdirSync(`/proc/${pid}/fd`).find((fd) => {
    try {
      return (
        fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${listenerInode}]`
      );
    } catch {
      return false;
    }
  });
  if (listenerFd === undefined)
    throw new Error("Editing backend PID does not own leased listener");
  return { listenerInode, listenerFd };
}
function validateOwnership(
  receipt: BindReceipt,
  launch: LaunchRecord,
  facts: LiveFacts,
  expected: BoundIdentity,
  protocolHash: string,
  attempt: string,
  port: number,
): void {
  same(receipt.protocolHash, protocolHash, "receipt protocol");
  same(launch.protocolHash, protocolHash, "launch protocol");
  same(launch.attempt, path.resolve(attempt), "launch attempt");
  same([receipt.port, launch.port], [port, port], "leased port");
  same(receipt.actual, expected, "actual factory identity");
  same(receipt.pid, facts.process.pid, "listener PID");
  same(facts.cleanupOwner, launch.cleanupOwner, "cleanup owner");
  const stores = e2eAuthStores(launch.cleanupOwner.directory);
  same(
    [facts.shareRegistry, facts.shareIdentity],
    [stores.shareRegistry, stores.shareIdentity],
    "owned auth paths",
  );
  same(expected.shareRegistry, stores.shareRegistry, "factory owner registry");
  same(
    [facts.cwd, facts.executable, facts.productionDist, facts.shareRegistry],
    [
      expected.cwd,
      expected.executable,
      expected.productionDist,
      expected.shareRegistry,
    ],
    "native process identity",
  );
  same(facts.ancestry[0], facts.process, "ancestry listener");
  same(facts.ancestry[facts.ancestry.length - 1], launch.child, "owned child");
  same(launch.child.parentPid, launch.wrapper.pid, "wrapper child parent");
  if (
    new Set(facts.ancestry.map((row) => row.pid)).size !== facts.ancestry.length
  )
    throw new Error("Editing backend ancestry contains a cycle");
  for (let index = 0; index + 1 < facts.ancestry.length; index++)
    same(
      facts.ancestry[index].parentPid,
      facts.ancestry[index + 1].pid,
      "ancestry parent",
    );
  same(facts.health, { status: 200, ok: true }, "health");
}
async function observe(
  attempt: string,
  request: BindRequest,
  observerEnv: NodeJS.ProcessEnv,
): Promise<Omit<Observation, "phase">> {
  const candidate = census(attempt, request.port);
  const directory = identityDirectory(attempt);
  const receiptBytes = fs.readFileSync(
    path.join(directory, "live.json"),
    "utf8",
  );
  const launchBytes = fs.readFileSync(
    path.join(directory, "launch.json"),
    "utf8",
  );
  const receipt = parseReceipt(receiptBytes);
  const launch = parseLaunch(launchBytes);
  same(captureCleanupOwner(observerEnv), launch.cleanupOwner, "cleanup owner");
  const requestFile = path.join(directory, "request.json");
  same(hash(fs.readFileSync(requestFile)), launch.requestHash, "request bytes");
  same(
    parseRequest(fs.readFileSync(requestFile, "utf8")),
    request,
    "live request expectations",
  );
  same(candidate.pid, receipt.pid, "advertised listener PID");
  same(nativeProcess(launch.wrapper.pid), launch.wrapper, "live wrapper");
  same(nativeProcess(launch.child.pid), launch.child, "live direct child");
  const ancestry = [nativeProcess(receipt.pid)];
  while (ancestry[ancestry.length - 1].pid !== launch.child.pid) {
    const parentPid = ancestry[ancestry.length - 1].parentPid;
    if (ancestry.some((row) => row.pid === parentPid) || parentPid === 1)
      throw new Error("Editing backend listener is outside owned child tree");
    ancestry.push(nativeProcess(parentPid));
  }
  const env = environment(receipt.pid);
  const nativeFacts = {
    process: ancestry[0],
    ancestry,
    ...listener(receipt.pid, request.port),
    cwd: fs.realpathSync(`/proc/${receipt.pid}/cwd`),
    executable: fs.realpathSync(`/proc/${receipt.pid}/exe`),
    productionDist: fs.realpathSync(text(env.PODCAST_GUI_DIST)),
    shareRegistry: path.resolve(text(env.PODCAST_SHARE_REGISTRY)),
    shareIdentity: path.resolve(text(env.PODCAST_SHARE_IDENTITY)),
    cleanupOwner: captureCleanupOwner(env),
  };
  same(nativeFacts.cleanupOwner, launch.cleanupOwner, "cleanup owner");
  const health = await fetch(`http://127.0.0.1:${request.port}/api/health`, {
    signal: AbortSignal.timeout(2000),
    redirect: "error",
  });
  const body = object(await health.json());
  const status = health.status,
    ok = body.ok;
  if (status !== 200 || ok !== true)
    throw new Error("Editing backend health failed");
  const facts: LiveFacts = { ...nativeFacts, health: { status, ok } };
  validateOwnership(
    receipt,
    launch,
    facts,
    request.expected,
    request.protocolHash,
    attempt,
    request.port,
  );
  same(
    fs.readFileSync(path.join(directory, "live.json"), "utf8"),
    receiptBytes,
    "receipt during observation",
  );
  same(
    nativeProcess(launch.wrapper.pid),
    launch.wrapper,
    "wrapper during observation",
  );
  for (const ancestor of ancestry)
    same(nativeProcess(ancestor.pid), ancestor, "ancestry during observation");
  same(
    listener(receipt.pid, request.port).listenerInode,
    facts.listenerInode,
    "listener during observation",
  );
  same(
    fs.readFileSync(path.join(directory, "launch.json"), "utf8"),
    launchBytes,
    "launch during observation",
  );
  same(captureCleanupOwner(observerEnv), launch.cleanupOwner, "cleanup owner");
  same(
    captureCleanupOwner(environment(receipt.pid)),
    launch.cleanupOwner,
    "cleanup owner",
  );
  same(hash(fs.readFileSync(requestFile)), launch.requestHash, "request bytes");
  return {
    version: 2,
    protocolHash: request.protocolHash,
    attempt: path.resolve(attempt),
    port: request.port,
    receipt: { bytes: receiptBytes, sha256: hash(receiptBytes) },
    launch: { bytes: launchBytes, sha256: hash(launchBytes) },
    facts,
  };
}
function identityEvidence(
  observation: Omit<Observation, "phase">,
): Omit<BackendEvidence, "phase" | "verificationHash"> {
  return {
    protocolHash: observation.protocolHash,
    pid: observation.facts.process.pid,
    startTime: observation.facts.process.startTime,
    listenerInode: observation.facts.listenerInode,
    receiptHash: observation.receipt.sha256,
    launchHash: observation.launch.sha256,
  };
}
function evidence(observation: Observation, bytes: string): BackendEvidence {
  return {
    phase: observation.phase,
    ...identityEvidence(observation),
    verificationHash: hash(bytes),
  };
}
function continuous(before: BackendEvidence, after: BackendEvidence): void {
  const identity = ({
    phase: _phase,
    verificationHash: _verificationHash,
    ...rest
  }: BackendEvidence) => rest;
  same(identity(after), identity(before), "before and after identity");
}

export class EditingBackendLaunch {
  private readonly request: BindRequest;
  private readonly cleanupOwner: CleanupOwner;
  private readonly requestHash: string;
  readonly environment: NodeJS.ProcessEnv;
  constructor(
    attempt: string,
    protocolFile: string,
    protocolHash: string,
    port: number,
    env: NodeJS.ProcessEnv,
  ) {
    this.attempt = path.resolve(attempt);
    for (const name of [
      "PODCAST_SIDECAR_BOOT_TOKEN",
      "PODCAST_SIDECAR_EPHEMERAL",
      "PODCAST_SIDECAR_LISTEN_FILE",
    ])
      if (env[name] !== undefined)
        throw new Error(
          "Editing backend has conflicting sidecar configuration",
        );
    this.cleanupOwner = captureCleanupOwner(env);
    this.request = requestIdentity(
      protocolFile,
      protocolHash,
      this.cleanupOwner,
      port,
    );
    same(
      [
        fs.realpathSync(text(env.PODCAST_GUI_DIST)),
        path.resolve(text(env.PODCAST_SHARE_REGISTRY)),
      ],
      [
        this.request.expected.productionDist,
        this.request.expected.shareRegistry,
      ],
      "launch isolation",
    );
    fs.mkdirSync(identityDirectory(this.attempt), { mode: 0o700 });
    const requestFile = path.join(
      identityDirectory(this.attempt),
      "request.json",
    );
    writeOwned(requestFile, this.request);
    this.requestHash = hash(fs.readFileSync(requestFile));
    this.environment = { ...env, PODCAST_EDITING_BIND_REQUEST: requestFile };
  }
  private readonly attempt: string;
  recordChild(pid: number, command: string[]): void {
    const wrapper = nativeProcess(process.pid);
    const child = nativeProcess(pid);
    same(child.parentPid, wrapper.pid, "spawned child parent");
    const launch: LaunchRecord = {
      version: 2,
      protocolHash: this.request.protocolHash,
      attempt: this.attempt,
      port: this.request.port,
      wrapper,
      child,
      command,
      requestHash: this.requestHash,
      cleanupOwner: this.cleanupOwner,
    };
    same(
      captureCleanupOwner(this.environment),
      this.cleanupOwner,
      "cleanup owner",
    );
    same(
      hash(
        fs.readFileSync(
          path.join(identityDirectory(this.attempt), "request.json"),
        ),
      ),
      this.requestHash,
      "request bytes",
    );
    writeOwned(
      path.join(identityDirectory(this.attempt), "launch.json"),
      launch,
    );
  }
  async waitUntilReady(): Promise<void> {
    const launch = parseLaunch(
      fs.readFileSync(
        path.join(identityDirectory(this.attempt), "launch.json"),
        "utf8",
      ),
    );
    const deadline = Date.now() + 30_000;
    let failure: unknown;
    while (Date.now() < deadline) {
      same(nativeProcess(launch.child.pid), launch.child, "startup child");
      try {
        const observation = await observe(
          this.attempt,
          this.request,
          this.environment,
        );
        writeOwned(path.join(identityDirectory(this.attempt), "ready.json"), {
          version: 2,
          ...identityEvidence(observation),
        });
        return;
      } catch (error) {
        failure = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Editing backend readiness identity failed", {
      cause: failure,
    });
  }
}

export async function verifyEditingBackend(
  attempt: string,
  selectedPort: string | undefined,
  input: {
    protocolFile: string;
    protocolHash: string;
    environment: NodeJS.ProcessEnv;
  } & ({ phase: "before" } | { phase: "after"; previous: BackendEvidence }),
): Promise<BackendEvidence> {
  const request = requestIdentity(
    input.protocolFile,
    input.protocolHash,
    captureCleanupOwner(input.environment),
    Number(selectedPort),
  );
  census(attempt, request.port);
  fs.readFileSync(path.join(identityDirectory(attempt), "live.json"));
  const readyFile = path.join(identityDirectory(attempt), "ready.json");
  const deadline = Date.now() + 35_000;
  while (!fs.existsSync(readyFile) && Date.now() < deadline) {
    if (fs.existsSync(path.join(identityDirectory(attempt), "failure.json")))
      throw new Error("Editing backend startup identity failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const ready = fields(JSON.parse(fs.readFileSync(readyFile, "utf8")), [
    "version",
    "protocolHash",
    "pid",
    "startTime",
    "listenerInode",
    "receiptHash",
    "launchHash",
  ]);
  if (ready.version !== 2)
    throw new Error("Editing backend ready version differs");
  const observation: Observation = {
    ...(await observe(attempt, request, input.environment)),
    phase: input.phase,
  };
  const bytes = `${JSON.stringify(observation, null, 2)}\n`;
  const result = evidence(observation, bytes);
  for (const key of [
    "protocolHash",
    "pid",
    "startTime",
    "listenerInode",
    "receiptHash",
    "launchHash",
  ] as const)
    same(result[key], ready[key], "ready identity");
  if (input.phase === "after") continuous(input.previous, result);
  writeOwned(
    path.join(identityDirectory(attempt), `${input.phase}.json`),
    observation,
  );
  return result;
}

function retainedObservation(
  attempt: string,
  phase: "before" | "after",
  expected: BoundIdentity,
  protocolHash: string,
  port: number,
  currentLaunch: LaunchRecord,
  requestHash: string,
): BackendEvidence {
  const bytes = fs.readFileSync(
    path.join(identityDirectory(attempt), `${phase}.json`),
    "utf8",
  );
  const row = fields(JSON.parse(bytes), [
    "version",
    "phase",
    "protocolHash",
    "attempt",
    "port",
    "receipt",
    "launch",
    "facts",
  ]);
  if (row.version !== 2 || row.phase !== phase)
    throw new Error("Editing backend observation phase differs");
  same(row.attempt, path.resolve(attempt), "retained attempt");
  same(row.protocolHash, protocolHash, "retained protocol");
  same(row.port, port, "retained request lease");
  const receipt = fields(row.receipt, ["bytes", "sha256"]),
    launch = fields(row.launch, ["bytes", "sha256"]),
    raw = fields(row.facts, [
      "process",
      "ancestry",
      "listenerInode",
      "listenerFd",
      "cwd",
      "executable",
      "productionDist",
      "shareRegistry",
      "shareIdentity",
      "cleanupOwner",
      "health",
    ]);
  const receiptBytes = text(receipt.bytes),
    launchBytes = text(launch.bytes);
  same(hash(receiptBytes), digest(receipt.sha256), "retained receipt hash");
  same(hash(launchBytes), digest(launch.sha256), "retained launch hash");
  if (!Array.isArray(raw.ancestry) || raw.ancestry.length === 0)
    throw new Error("Editing backend retained ancestry missing");
  const health = object(raw.health);
  if (health.status !== 200 || health.ok !== true)
    throw new Error("Editing backend retained health differs");
  const facts: LiveFacts = {
    process: parseProcess(raw.process),
    ancestry: raw.ancestry.map(parseProcess),
    listenerInode: text(raw.listenerInode),
    listenerFd: text(raw.listenerFd),
    cwd: text(raw.cwd),
    executable: text(raw.executable),
    productionDist: text(raw.productionDist),
    shareRegistry: text(raw.shareRegistry),
    shareIdentity: text(raw.shareIdentity),
    cleanupOwner: parseCleanupOwner(raw.cleanupOwner),
    health: { status: 200, ok: true },
  };
  if (!/^\d+$/.test(facts.listenerInode) || !/^\d+$/.test(facts.listenerFd))
    throw new Error("Editing backend retained socket facts differ");
  const retainedLaunch = parseLaunch(launchBytes);
  same(retainedLaunch, currentLaunch, "retained launch");
  same(retainedLaunch.requestHash, requestHash, "request bytes");
  validateOwnership(
    parseReceipt(receiptBytes),
    retainedLaunch,
    facts,
    expected,
    protocolHash,
    attempt,
    port,
  );
  return evidence(
    {
      version: 2,
      phase,
      protocolHash,
      attempt: path.resolve(attempt),
      port,
      receipt: { bytes: receiptBytes, sha256: hash(receiptBytes) },
      launch: { bytes: launchBytes, sha256: hash(launchBytes) },
      facts,
    },
    bytes,
  );
}
export function admitRetainedBackend(
  attempt: string,
  protocolFile: string,
  protocolHash: string,
): BackendAdmission {
  try {
    const launch = parseLaunch(
      fs.readFileSync(
        path.join(identityDirectory(attempt), "launch.json"),
        "utf8",
      ),
    );
    const expected = boundIdentity(
      protocolIdentity(protocolFile, protocolHash),
      launch.cleanupOwner,
    );
    const requestBytes = fs.readFileSync(
      path.join(identityDirectory(attempt), "request.json"),
      "utf8",
    );
    const requestHash = hash(requestBytes);
    same(requestHash, launch.requestHash, "request bytes");
    const request = parseRequest(requestBytes);
    const requested = request.expected;
    same(
      requested,
      {
        ...expected,
        executable: fs.realpathSync(expected.executable),
        productionDist: fs.realpathSync(expected.productionDist),
      },
      "retained request expectations",
    );
    same(request.protocolHash, protocolHash, "retained request protocol");
    const port = request.port;
    const before = retainedObservation(
      attempt,
      "before",
      requested,
      protocolHash,
      port,
      launch,
      requestHash,
    );
    const after = retainedObservation(
      attempt,
      "after",
      requested,
      protocolHash,
      port,
      launch,
      requestHash,
    );
    continuous(before, after);
    const trial = object(
      JSON.parse(fs.readFileSync(path.join(attempt, "trial.json"), "utf8")),
    );
    same(trial.protocolHash, protocolHash, "trial protocol");
    same(trial.backend, { before, after }, "trial proof references");
    return { kind: "admitted", before, after };
  } catch (error) {
    return { kind: "rejected", reason: String(error) };
  }
}
