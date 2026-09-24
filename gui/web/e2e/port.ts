import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type PortEnvironment = Record<string, string | undefined>;

const MIN_PORT = 1;
const MAX_PORT = 65_535;

export interface E2ePortLease {
  port: number;
  release(): void;
}

export interface PortLeaseOwner {
  pid: number;
  token: string;
}

export interface ObservedPortLease {
  generation: string;
  owner: PortLeaseOwner | undefined;
}

function leasePath(port: number, lockDir = os.tmpdir()): string {
  return path.join(lockDir, `sharecut-e2e-port-${port}.lock`);
}

function ownerPath(lease: string): string {
  return path.join(lease, "owner.json");
}

export function configuredE2ePort(
  env: PortEnvironment = process.env,
): number | undefined {
  const raw = env.DAW_E2E_PORT;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `DAW_E2E_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}`,
    );
  }
  return port;
}

export async function findAvailableLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a loopback port for Playwright");
  }
  return address.port;
}

function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readOwner(lease: string): PortLeaseOwner | undefined {
  try {
    const value = JSON.parse(
      fs.readFileSync(ownerPath(lease), "utf8"),
    ) as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      !Number.isInteger((value as PortLeaseOwner).pid) ||
      (value as PortLeaseOwner).pid < 1 ||
      typeof (value as PortLeaseOwner).token !== "string" ||
      !(value as PortLeaseOwner).token
    ) {
      return undefined;
    }
    return value as PortLeaseOwner;
  } catch {
    return undefined;
  }
}

function directoryIdentity(directory: string): string | undefined {
  try {
    const stat = fs.lstatSync(directory);
    return [stat.dev, stat.ino, stat.mode, stat.birthtimeMs].join(":");
  } catch {
    return undefined;
  }
}

function generationFor(identity: string): string {
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function observePortLeaseAt(
  lease: string,
  afterOwnerRead?: () => void,
): ObservedPortLease | undefined {
  const before = directoryIdentity(lease);
  if (!before) {
    return undefined;
  }
  const owner = readOwner(lease);
  afterOwnerRead?.();
  const after = directoryIdentity(lease);
  if (!after || before !== after) {
    return undefined;
  }
  return { generation: generationFor(before), owner };
}

export function observePortLease(
  port: number,
  lockDir = os.tmpdir(),
  afterOwnerRead?: () => void,
): ObservedPortLease | undefined {
  return observePortLeaseAt(leasePath(port, lockDir), afterOwnerRead);
}

function renameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY";
}

function quarantine(
  lease: string,
  observed: ObservedPortLease | undefined,
): boolean {
  if (!observed) {
    return false;
  }
  const tombstone = `${lease}.tombstone-${observed.generation}`;
  if (fs.existsSync(tombstone)) {
    return false;
  }
  const current = observePortLeaseAt(lease);
  if (!current || current.generation !== observed.generation) {
    return false;
  }
  try {
    fs.renameSync(lease, tombstone);
  } catch (error) {
    if (renameConflict(error)) {
      return false;
    }
    throw error;
  }
  const moved = observePortLeaseAt(tombstone);
  if (moved?.generation === observed.generation) {
    // Retain this fence so a delayed observer cannot move a replacement.
    return true;
  }
  try {
    fs.renameSync(tombstone, lease);
  } catch (error) {
    if (!renameConflict(error)) {
      throw error;
    }
  }
  return false;
}

export function reclaimObservedPortLease(
  port: number,
  lockDir: string,
  observed: ObservedPortLease | undefined,
): boolean {
  return quarantine(leasePath(port, lockDir), observed);
}

export function createPortLease(
  port: number,
  lockDir = os.tmpdir(),
  token: string = crypto.randomUUID(),
  beforePublish?: () => void,
): E2ePortLease | undefined {
  const lease = leasePath(port, lockDir);
  const candidate = `${lease}.candidate-${token}`;
  const owner: PortLeaseOwner = { pid: process.pid, token };
  try {
    fs.mkdirSync(candidate);
    fs.writeFileSync(ownerPath(candidate), `${JSON.stringify(owner)}\n`);
    beforePublish?.();
    fs.renameSync(candidate, lease);
  } catch (error) {
    fs.rmSync(candidate, { recursive: true, force: true });
    if (!renameConflict(error)) {
      throw error;
    }
    const observed = observePortLeaseAt(lease);
    if (!observed?.owner || !ownerAlive(observed.owner.pid)) {
      quarantine(lease, observed);
    }
    return undefined;
  }
  return {
    port,
    release: () => {
      const current = readOwner(lease);
      if (current?.token !== token) {
        return;
      }
      const released = `${lease}.released-${token}`;
      try {
        fs.renameSync(lease, released);
        if (readOwner(released)?.token === token) {
          fs.rmSync(released, { recursive: true, force: true });
        }
      } catch (error) {
        if (!renameConflict(error)) {
          throw error;
        }
      }
    },
  };
}

async function leasePort(
  port: number,
  lockDir?: string,
): Promise<E2ePortLease | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const lease = createPortLease(port, lockDir);
    if (lease) {
      return lease;
    }
  }
  return undefined;
}

export async function acquireE2ePortLease(
  env: PortEnvironment = process.env,
  findPort: () => Promise<number> = findAvailableLoopbackPort,
  lockDir?: string,
): Promise<E2ePortLease> {
  const explicit = configuredE2ePort(env);
  if (explicit !== undefined) {
    const lease = await leasePort(explicit, lockDir);
    if (!lease) {
      throw new Error(
        `DAW_E2E_PORT ${explicit} is already leased by another Playwright run`,
      );
    }
    return lease;
  }
  for (;;) {
    const port = await findPort();
    const lease = await leasePort(port, lockDir);
    if (lease) {
      env.DAW_E2E_PORT = String(port);
      return lease;
    }
  }
}
