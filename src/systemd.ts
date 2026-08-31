import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { join } from "path"
import type { ExecSyncOptions } from "child_process"

export type SystemdCommandRunner = (command: string, options?: ExecSyncOptions) => Buffer | string

export interface RuntimeEnvDependencies {
  exists: (path: string) => boolean
  uid: () => number | undefined
}

const defaultRuntimeEnvDependencies: RuntimeEnvDependencies = {
  exists: existsSync,
  uid: () => process.getuid?.(),
}

export function withSystemdRuntimeEnv(
  env: NodeJS.ProcessEnv,
  dependencies: RuntimeEnvDependencies = defaultRuntimeEnvDependencies
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env }
  if (!next.XDG_RUNTIME_DIR) {
    const uid = dependencies.uid()
    if (typeof uid === "number") {
      const runtimeDir = `/run/user/${uid}`
      if (dependencies.exists(runtimeDir)) next.XDG_RUNTIME_DIR = runtimeDir
    }
  }
  if (!next.DBUS_SESSION_BUS_ADDRESS && next.XDG_RUNTIME_DIR) {
    const busPath = join(next.XDG_RUNTIME_DIR, "bus")
    if (dependencies.exists(busPath)) next.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`
  }
  return next
}

type FileSnapshot =
  | { path: string; type: "missing" }
  | { path: string; type: "regular"; content: Buffer; mode: number }
  | { path: string; type: "symlink"; target: string }

type UnitFileState =
  | "enabled"
  | "enabled-runtime"
  | "disabled"
  | "static"
  | "indirect"
  | "masked"
  | "masked-runtime"
  | "linked"
  | "linked-runtime"
  | "alias"
  | "not-found"

export interface SystemdInstallRequest {
  unitDir: string
  lockDir?: string
  serviceUnit: string
  timerUnit: string
  serviceContent: string
  timerContent: string
  run: SystemdCommandRunner
  fileSystem?: SystemdFileSystem
  lock?: Partial<SystemdLockOptions>
}

export interface SystemdFileSystem {
  chmod: typeof chmodSync
  exists: typeof existsSync
  lstat: typeof lstatSync
  mkdir: typeof mkdirSync
  readFile: typeof readFileSync
  readlink: typeof readlinkSync
  rename: typeof renameSync
  rm: typeof rmSync
  stat: typeof statSync
  symlink: typeof symlinkSync
  unlink: typeof unlinkSync
  writeFile: typeof writeFileSync
}

const defaultFileSystem: SystemdFileSystem = {
  chmod: chmodSync,
  exists: existsSync,
  lstat: lstatSync,
  mkdir: mkdirSync,
  readFile: readFileSync,
  readlink: readlinkSync,
  rename: renameSync,
  rm: rmSync,
  stat: statSync,
  symlink: symlinkSync,
  unlink: unlinkSync,
  writeFile: writeFileSync,
}

interface SystemdLockOptions {
  timeoutMs: number
  staleAfterMs: number
  pollMs: number
  now: () => number
  pid: number
  isPidAlive: (pid: number) => boolean
  sleep: (milliseconds: number) => void
}

const sleepArray = new Int32Array(new SharedArrayBuffer(4))
const defaultLockOptions: SystemdLockOptions = {
  timeoutMs: 10_000,
  staleAfterMs: 60_000,
  pollMs: 25,
  now: Date.now,
  pid: process.pid,
  isPidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  sleep(milliseconds) {
    Atomics.wait(sleepArray, 0, 0, milliseconds)
  },
}

function snapshotFile(path: string, fileSystem: SystemdFileSystem): FileSnapshot {
  let stats: ReturnType<typeof lstatSync>
  try {
    stats = fileSystem.lstat(path)
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return { path, type: "missing" }
    throw error
  }
  if (stats.isSymbolicLink()) return { path, type: "symlink", target: fileSystem.readlink(path) }
  if (stats.isFile()) {
    return { path, type: "regular", content: fileSystem.readFile(path), mode: stats.mode & 0o777 }
  }
  throw new Error(`Unsupported systemd unit node type at ${path}; refusing to mutate it`)
}

let temporaryFileSequence = 0

function temporaryPath(path: string): string {
  temporaryFileSequence += 1
  return `${path}.tmp-${process.pid}-${temporaryFileSequence}`
}

function atomicReplace(path: string, content: string | Buffer, mode: number, fileSystem: SystemdFileSystem): void {
  const temporary = temporaryPath(path)
  try {
    fileSystem.writeFile(temporary, content, { mode })
    fileSystem.chmod(temporary, mode)
    fileSystem.rename(temporary, path)
    fileSystem.chmod(path, mode)
  } finally {
    removeNode(temporary, fileSystem)
  }
}

function atomicSymlink(path: string, target: string, fileSystem: SystemdFileSystem): void {
  const temporary = temporaryPath(path)
  try {
    fileSystem.symlink(target, temporary)
    fileSystem.rename(temporary, path)
  } finally {
    removeNode(temporary, fileSystem)
  }
}

function removeNode(path: string, fileSystem: SystemdFileSystem): void {
  try {
    fileSystem.unlink(path)
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error
  }
}

function commandOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString().trim()
  if (typeof value === "string") return value.trim()
  if (typeof value === "object" && value !== null && "stdout" in value) {
    const stdout = (value as { stdout?: unknown }).stdout
    if (Buffer.isBuffer(stdout)) return stdout.toString().trim()
    if (typeof stdout === "string") return stdout.trim()
  }
  return ""
}

function queryUnitFileState(run: SystemdCommandRunner, timerUnit: string): UnitFileState {
  let output = ""
  try {
    output = commandOutput(run(`systemctl --user is-enabled ${timerUnit}`, { stdio: ["ignore", "pipe", "ignore"] }))
  } catch (error) {
    output = commandOutput(error)
  }
  const supported: UnitFileState[] = [
    "enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime",
    "linked", "linked-runtime", "alias", "not-found",
  ]
  if (supported.includes(output as UnitFileState)) return output as UnitFileState
  const unrecoverable = ["generated", "transient", "bad"]
  if (unrecoverable.includes(output)) {
    throw new Error(`Cannot safely restore ${timerUnit} from systemd unit-file state ${output}; refusing to mutate it`)
  }
  throw new Error(`Unable to determine ${timerUnit} unit-file state: ${output || "no status returned"}`)
}

function queryActiveState(run: SystemdCommandRunner, timerUnit: string): boolean {
  let output = ""
  try {
    output = commandOutput(run(`systemctl --user is-active ${timerUnit}`, { stdio: ["ignore", "pipe", "ignore"] }))
  } catch (error) {
    output = commandOutput(error)
  }
  if (["active", "activating", "reloading"].includes(output)) return true
  if (["inactive", "failed", "deactivating", "unknown"].includes(output)) return false
  throw new Error(`Unable to determine whether ${timerUnit} is active: ${output || "no status returned"}`)
}

function restoreFile(snapshot: FileSnapshot, fileSystem: SystemdFileSystem): void {
  if (snapshot.type === "missing") {
    removeNode(snapshot.path, fileSystem)
  } else if (snapshot.type === "symlink") {
    atomicSymlink(snapshot.path, snapshot.target, fileSystem)
  } else {
    atomicReplace(snapshot.path, snapshot.content, snapshot.mode, fileSystem)
  }
}

function bestEffort(action: () => void): void {
  try {
    action()
  } catch {}
}

function restoreUnitFileState(run: SystemdCommandRunner, timerUnit: string, state: UnitFileState): void {
  if (state === "enabled") run(`systemctl --user enable ${timerUnit}`, { stdio: "ignore" })
  if (state === "enabled-runtime") run(`systemctl --user enable --runtime ${timerUnit}`, { stdio: "ignore" })
  if (state === "disabled") run(`systemctl --user disable ${timerUnit}`, { stdio: "ignore" })
  // linked, masked, static, indirect, alias and not-found are represented by
  // the restored filesystem node or by immutable unit metadata. Running
  // enable/disable here would change their exact prior state.
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}

function readLockMetadata(lockPath: string, fileSystem: SystemdFileSystem): { pid?: number; timestamp?: number } {
  try {
    const parsed = JSON.parse(fileSystem.readFile(join(lockPath, "owner.json"), "utf8")) as unknown
    if (typeof parsed !== "object" || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return {
      pid: typeof record.pid === "number" ? record.pid : undefined,
      timestamp: typeof record.timestamp === "number" ? record.timestamp : undefined,
    }
  } catch {
    return {}
  }
}

function acquireLock(
  lockRoot: string,
  timerUnit: string,
  fileSystem: SystemdFileSystem,
  overrides?: Partial<SystemdLockOptions>
): () => void {
  const options = { ...defaultLockOptions, ...overrides }
  fileSystem.mkdir(lockRoot, { recursive: true })
  const lockPath = join(lockRoot, `${timerUnit}.lock`)
  const startedAt = options.now()
  while (true) {
    try {
      fileSystem.mkdir(lockPath)
      try {
        fileSystem.writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: options.pid, timestamp: options.now() }))
      } catch (error) {
        fileSystem.rm(lockPath, { recursive: true, force: true })
        throw error
      }
      return () => fileSystem.rm(lockPath, { recursive: true, force: true })
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error
      const metadata = readLockMetadata(lockPath, fileSystem)
      const timestamp = metadata.timestamp ?? fileSystem.lstat(lockPath).mtimeMs
      const oldEnough = options.now() - timestamp >= options.staleAfterMs
      const ownerAlive = metadata.pid !== undefined && options.isPidAlive(metadata.pid)
      if (oldEnough && !ownerAlive) {
        fileSystem.rm(lockPath, { recursive: true, force: true })
        continue
      }
      if (options.now() - startedAt >= options.timeoutMs) {
        throw new Error(`Timed out waiting ${options.timeoutMs}ms for systemd install lock ${lockPath}`)
      }
      options.sleep(options.pollMs)
    }
  }
}

export function installSystemdUnits(request: SystemdInstallRequest): void {
  const fileSystem = request.fileSystem ?? defaultFileSystem
  const releaseLock = acquireLock(
    request.lockDir ?? join(request.unitDir, ".opencode-scheduler-locks"),
    request.timerUnit,
    fileSystem,
    request.lock
  )
  try {
    fileSystem.mkdir(request.unitDir, { recursive: true })
    const servicePath = join(request.unitDir, request.serviceUnit)
    const timerPath = join(request.unitDir, request.timerUnit)
    const serviceSnapshot = snapshotFile(servicePath, fileSystem)
    const timerSnapshot = snapshotFile(timerPath, fileSystem)
    const unitFileState = queryUnitFileState(request.run, request.timerUnit)
    const wasActive = queryActiveState(request.run, request.timerUnit)

    let enabledByAttempt = false
    try {
      atomicReplace(servicePath, request.serviceContent, 0o644, fileSystem)
      atomicReplace(timerPath, request.timerContent, 0o644, fileSystem)
      request.run("systemctl --user daemon-reload")
      request.run(`systemctl --user enable ${request.timerUnit}`)
      enabledByAttempt = true
      request.run(`systemctl --user start ${request.timerUnit}`)
    } catch (error) {
      if (!wasActive) bestEffort(() => request.run(`systemctl --user stop ${request.timerUnit}`, { stdio: "ignore" }))
      if (enabledByAttempt) bestEffort(() => request.run(`systemctl --user disable ${request.timerUnit}`, { stdio: "ignore" }))
      bestEffort(() => restoreFile(serviceSnapshot, fileSystem))
      bestEffort(() => restoreFile(timerSnapshot, fileSystem))
      bestEffort(() => request.run("systemctl --user daemon-reload", { stdio: "ignore" }))
      bestEffort(() => restoreUnitFileState(request.run, request.timerUnit, unitFileState))
      if (wasActive) bestEffort(() => request.run(`systemctl --user start ${request.timerUnit}`, { stdio: "ignore" }))
      throw error
    }
  } finally {
    releaseLock()
  }
}
