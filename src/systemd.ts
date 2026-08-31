import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
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

interface FileSnapshot {
  path: string
  existed: boolean
  content?: Buffer
  mode?: number
}

export interface SystemdInstallRequest {
  unitDir: string
  serviceUnit: string
  timerUnit: string
  serviceContent: string
  timerContent: string
  run: SystemdCommandRunner
  fileSystem?: SystemdFileSystem
}

export interface SystemdFileSystem {
  chmod: typeof chmodSync
  exists: typeof existsSync
  mkdir: typeof mkdirSync
  readFile: typeof readFileSync
  rename: typeof renameSync
  stat: typeof statSync
  unlink: typeof unlinkSync
  writeFile: typeof writeFileSync
}

const defaultFileSystem: SystemdFileSystem = {
  chmod: chmodSync,
  exists: existsSync,
  mkdir: mkdirSync,
  readFile: readFileSync,
  rename: renameSync,
  stat: statSync,
  unlink: unlinkSync,
  writeFile: writeFileSync,
}

function snapshotFile(path: string, fileSystem: SystemdFileSystem): FileSnapshot {
  if (!fileSystem.exists(path)) return { path, existed: false }
  return {
    path,
    existed: true,
    content: fileSystem.readFile(path),
    mode: fileSystem.stat(path).mode & 0o777,
  }
}

let temporaryFileSequence = 0

function atomicReplace(path: string, content: string | Buffer, mode: number, fileSystem: SystemdFileSystem): void {
  temporaryFileSequence += 1
  const temporaryPath = `${path}.tmp-${process.pid}-${temporaryFileSequence}`
  try {
    fileSystem.writeFile(temporaryPath, content, { mode })
    fileSystem.chmod(temporaryPath, mode)
    fileSystem.rename(temporaryPath, path)
    fileSystem.chmod(path, mode)
  } finally {
    try {
      fileSystem.unlink(temporaryPath)
    } catch {}
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

function queryTimerState(run: SystemdCommandRunner, timerUnit: string, query: "is-enabled" | "is-active"): boolean {
  let output = ""
  try {
    output = commandOutput(run(`systemctl --user ${query} ${timerUnit}`, { stdio: ["ignore", "pipe", "ignore"] }))
  } catch (error) {
    output = commandOutput(error)
  }
  return query === "is-enabled"
    ? ["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"].includes(output)
    : ["active", "activating", "reloading"].includes(output)
}

function restoreFile(snapshot: FileSnapshot, fileSystem: SystemdFileSystem): void {
  if (!snapshot.existed) {
    try {
      fileSystem.unlink(snapshot.path)
    } catch {}
    return
  }
  atomicReplace(snapshot.path, snapshot.content ?? Buffer.alloc(0), snapshot.mode ?? 0o644, fileSystem)
}

function bestEffort(action: () => void): void {
  try {
    action()
  } catch {}
}

export function installSystemdUnits(request: SystemdInstallRequest): void {
  const fileSystem = request.fileSystem ?? defaultFileSystem
  fileSystem.mkdir(request.unitDir, { recursive: true })
  const servicePath = join(request.unitDir, request.serviceUnit)
  const timerPath = join(request.unitDir, request.timerUnit)
  const serviceSnapshot = snapshotFile(servicePath, fileSystem)
  const timerSnapshot = snapshotFile(timerPath, fileSystem)
  const wasEnabled = queryTimerState(request.run, request.timerUnit, "is-enabled")
  const wasActive = queryTimerState(request.run, request.timerUnit, "is-active")

  try {
    atomicReplace(servicePath, request.serviceContent, 0o644, fileSystem)
    atomicReplace(timerPath, request.timerContent, 0o644, fileSystem)
    request.run("systemctl --user daemon-reload")
    request.run(`systemctl --user enable ${request.timerUnit}`)
    request.run(`systemctl --user start ${request.timerUnit}`)
  } catch (error) {
    if (!wasActive) bestEffort(() => request.run(`systemctl --user stop ${request.timerUnit}`, { stdio: "ignore" }))
    if (!wasEnabled) bestEffort(() => request.run(`systemctl --user disable ${request.timerUnit}`, { stdio: "ignore" }))
    bestEffort(() => restoreFile(serviceSnapshot, fileSystem))
    bestEffort(() => restoreFile(timerSnapshot, fileSystem))
    bestEffort(() => request.run("systemctl --user daemon-reload", { stdio: "ignore" }))
    if (wasEnabled) bestEffort(() => request.run(`systemctl --user enable ${request.timerUnit}`, { stdio: "ignore" }))
    if (wasActive) bestEffort(() => request.run(`systemctl --user start ${request.timerUnit}`, { stdio: "ignore" }))
    throw error
  }
}
