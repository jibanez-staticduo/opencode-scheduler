/** Unit tests for cron conversion and transactional systemd installation. */
import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn, spawnSync } from "child_process"
import { cronToSystemdCalendars } from "../src/cron"
import {
  installSystemdUnits,
  withSystemdRuntimeEnv,
  type SystemdCommandRunner,
  type SystemdFileSystem,
} from "../src/systemd"

const sandboxes = new Set<string>()

function sandbox(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-scheduler-test-"))
  sandboxes.add(path)
  return path
}

afterEach(() => {
  for (const path of sandboxes) rmSync(path, { recursive: true, force: true })
  sandboxes.clear()
})

describe("cronToSystemdCalendars", () => {
  const cases: Array<[string, string[]]> = [
    ["0 9 * * *", ["*-*-* 09:00:00"]],
    ["0 */6 * * *", ["*-*-* 00:00:00", "*-*-* 06:00:00", "*-*-* 12:00:00", "*-*-* 18:00:00"]],
    ["30 8 * * 1", ["Mon *-*-* 08:30:00"]],
    ["0 10 6 9 *", ["*-09-06 10:00:00"]],
    ["0 9 13 * 5", ["*-*-13 09:00:00", "Fri *-*-* 09:00:00"]],
  ]

  for (const [cron, expected] of cases) {
    test(`converts ${cron}`, () => expect(cronToSystemdCalendars(cron)).toEqual(expected))
  }

  const hasSystemdAnalyze = spawnSync("systemd-analyze", ["--version"], { stdio: "ignore" }).status === 0
  test.skipIf(!hasSystemdAnalyze)("emits calendars accepted by systemd-analyze", () => {
    for (const [cron] of cases) {
      for (const calendar of cronToSystemdCalendars(cron)) {
        expect(spawnSync("systemd-analyze", ["calendar", calendar], { stdio: "ignore" }).status).toBe(0)
      }
    }
  })
})

describe("withSystemdRuntimeEnv", () => {
  test("preserves inherited runtime and bus values", () => {
    const env = withSystemdRuntimeEnv(
      { XDG_RUNTIME_DIR: "/inherited", DBUS_SESSION_BUS_ADDRESS: "unix:path=/inherited/bus" },
      { uid: () => 42, exists: () => true }
    )
    expect(env.XDG_RUNTIME_DIR).toBe("/inherited")
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/inherited/bus")
  })

  test("derives runtime directory and bus", () => {
    const env = withSystemdRuntimeEnv({}, { uid: () => 42, exists: (path) => ["/run/user/42", "/run/user/42/bus"].includes(path) })
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/42")
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/42/bus")
  })

  test("does not derive values when runtime directory is absent", () => {
    const env = withSystemdRuntimeEnv({}, { uid: () => 42, exists: () => false })
    expect(env.XDG_RUNTIME_DIR).toBeUndefined()
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })

  test("does not derive a bus when the socket is absent", () => {
    const env = withSystemdRuntimeEnv({}, { uid: () => 42, exists: (path) => path === "/run/user/42" })
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/42")
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })
})

type FailurePoint = "first-write" | "second-write" | "second-chmod" | "daemon-reload" | "enable" | "start"

interface FakeState {
  unitFileState: string
  active: boolean
  calls: string[]
}

function fakeRunner(state: FakeState, failure?: FailurePoint): SystemdCommandRunner {
  return (command) => {
    state.calls.push(command)
    if (command.includes("is-enabled")) return Buffer.from(`${state.unitFileState}\n`)
    if (command.includes("is-active")) return Buffer.from(state.active ? "active\n" : "inactive\n")
    if (failure === "daemon-reload" && command.endsWith("daemon-reload") && state.calls.filter((call) => call.endsWith("daemon-reload")).length === 1) throw new Error(failure)
    if (failure === "enable" && command.includes(" enable ")) throw new Error(failure)
    if (failure === "start" && command.includes(" start ") && state.calls.filter((call) => call.includes(" start ")).length === 1) throw new Error(failure)
    if (command.includes(" enable --runtime ")) state.unitFileState = "enabled-runtime"
    else if (command.includes(" enable ")) state.unitFileState = "enabled"
    if (command.includes(" disable ")) state.unitFileState = "disabled"
    if (command.includes(" start ")) state.active = true
    if (command.includes(" stop ")) state.active = false
    return Buffer.alloc(0)
  }
}

function failingFileSystem(point?: FailurePoint): SystemdFileSystem | undefined {
  if (!point?.includes("write") && point !== "second-chmod") return undefined
  let writes = 0
  let chmods = 0
  return {
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
    writeFile: (path, data, options) => {
      writes += 1
      if ((point === "first-write" && writes === 1) || (point === "second-write" && writes === 2)) throw new Error(point)
      writeFileSync(path, data, options)
    },
    chmod: (path, mode) => {
      chmods += 1
      if (point === "second-chmod" && chmods === 2) throw new Error(point)
      chmodSync(path, mode)
    },
  }
}

function install(root: string, state: FakeState, failure?: FailurePoint, lock?: { timeoutMs?: number; staleAfterMs?: number; pollMs?: number }): void {
  installSystemdUnits({
    unitDir: root,
    serviceUnit: "job.service",
    timerUnit: "job.timer",
    serviceContent: "new service",
    timerContent: "new timer",
    run: fakeRunner(state, failure),
    fileSystem: failingFileSystem(failure),
    lock,
  })
}

describe("installSystemdUnits transaction", () => {
  test("aborts before mutation when prior timer state cannot be captured", () => {
    const root = sandbox()
    const service = join(root, "job.service")
    writeFileSync(service, "old service")
    const run: SystemdCommandRunner = () => {
      throw new Error("bus unavailable")
    }
    expect(() => installSystemdUnits({
      unitDir: root,
      serviceUnit: "job.service",
      timerUnit: "job.timer",
      serviceContent: "new service",
      timerContent: "new timer",
      run,
    })).toThrow("Unable to determine")
    expect(readFileSync(service, "utf8")).toBe("old service")
    expect(existsSync(join(root, "job.timer"))).toBe(false)
  })

  test("clean install writes 0644 files and starts an enabled timer", () => {
    const root = sandbox()
    const state: FakeState = { unitFileState: "disabled", active: false, calls: [] }
    install(root, state)
    expect(readFileSync(join(root, "job.service"), "utf8")).toBe("new service")
    expect(statSync(join(root, "job.timer")).mode & 0o777).toBe(0o644)
    expect(state.unitFileState).toBe("enabled")
    expect(state.active).toBe(true)
  })

  for (const failure of ["first-write", "second-write", "second-chmod", "daemon-reload", "enable", "start"] as FailurePoint[]) {
    test(`clean install rolls back ${failure} failure`, () => {
      const root = sandbox()
      const state: FakeState = { unitFileState: "disabled", active: false, calls: [] }
      expect(() => install(root, state, failure)).toThrow(failure)
      expect(existsSync(join(root, "job.service"))).toBe(false)
      expect(existsSync(join(root, "job.timer"))).toBe(false)
      expect(state.unitFileState).toBe("disabled")
      expect(state.active).toBe(false)
    })
  }

  for (const failure of ["second-write", "daemon-reload", "enable", "start"] as FailurePoint[]) {
    test(`update restores exact files, modes, and state after ${failure}`, () => {
      const root = sandbox()
      const service = join(root, "job.service")
      const timer = join(root, "job.timer")
      writeFileSync(service, "old service", { mode: 0o600 })
      writeFileSync(timer, "old timer", { mode: 0o640 })
      chmodSync(service, 0o600)
      chmodSync(timer, 0o640)
      const state: FakeState = { unitFileState: "enabled", active: true, calls: [] }
      expect(() => install(root, state, failure)).toThrow(failure)
      expect(readFileSync(service, "utf8")).toBe("old service")
      expect(readFileSync(timer, "utf8")).toBe("old timer")
      expect(statSync(service).mode & 0o777).toBe(0o600)
      expect(statSync(timer).mode & 0o777).toBe(0o640)
      expect(state.unitFileState).toBe("enabled")
      expect(state.active).toBe(true)
    })
  }

  test("never references or mutates an unscoped legacy unit", () => {
    const root = sandbox()
    const legacy = join(root, "opencode-job-legacy.timer")
    writeFileSync(legacy, "legacy")
    const state: FakeState = { unitFileState: "disabled", active: false, calls: [] }
    install(root, state)
    expect(readFileSync(legacy, "utf8")).toBe("legacy")
    expect(state.calls.some((call) => call.includes("legacy"))).toBe(false)
  })

  for (const target of ["/dev/null", "../units/original.timer"] as const) {
    for (const failure of ["first-write", "second-write", "second-chmod", "daemon-reload", "enable", "start"] as FailurePoint[]) {
      test(`restores symlink target ${target} after ${failure}`, () => {
        const root = sandbox()
        const service = join(root, "job.service")
        const timer = join(root, "job.timer")
        symlinkSync(target, service)
        symlinkSync(target, timer)
        const state: FakeState = {
          unitFileState: target === "/dev/null" ? "masked" : "linked",
          active: false,
          calls: [],
        }
        expect(() => install(root, state, failure)).toThrow(failure)
        expect(lstatSync(service).isSymbolicLink()).toBe(true)
        expect(lstatSync(timer).isSymbolicLink()).toBe(true)
        expect(readlinkSync(service)).toBe(target)
        expect(readlinkSync(timer)).toBe(target)
        expect(state.calls.some((call) => call.includes(" unmask "))).toBe(false)
      })
    }
  }

  for (const unitFileState of ["linked", "linked-runtime", "masked", "masked-runtime", "static", "indirect"] as const) {
    test(`does not enable or disable while restoring ${unitFileState} state`, () => {
      const root = sandbox()
      const target = unitFileState.startsWith("masked") ? "/dev/null" : "../units/job.timer"
      symlinkSync(target, join(root, "job.service"))
      symlinkSync(target, join(root, "job.timer"))
      const state: FakeState = { unitFileState, active: false, calls: [] }
      expect(() => install(root, state, "daemon-reload")).toThrow("daemon-reload")
      expect(readlinkSync(join(root, "job.timer"))).toBe(target)
      const rollbackCalls = state.calls.slice(state.calls.findIndex((call) => call.endsWith("daemon-reload")) + 1)
      expect(rollbackCalls.some((call) => call.includes(" enable ") || call.includes(" disable "))).toBe(false)
      expect(rollbackCalls.some((call) => call.includes(" unmask ") || call.includes(" link "))).toBe(false)
    })
  }

  test("rejects generated state before mutation", () => {
    const root = sandbox()
    const service = join(root, "job.service")
    writeFileSync(service, "old")
    const state: FakeState = { unitFileState: "generated", active: false, calls: [] }
    expect(() => install(root, state)).toThrow("Cannot safely restore")
    expect(readFileSync(service, "utf8")).toBe("old")
  })

  test("times out without breaking a live cross-process lock", () => {
    const root = sandbox()
    const lockRoot = join(root, "locks")
    const lockPath = join(lockRoot, "job.timer.lock")
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, timestamp: Date.now() - 120_000 }))
    const state: FakeState = { unitFileState: "disabled", active: false, calls: [] }
    expect(() => installSystemdUnits({
      unitDir: root,
      lockDir: lockRoot,
      serviceUnit: "job.service",
      timerUnit: "job.timer",
      serviceContent: "new service",
      timerContent: "new timer",
      run: fakeRunner(state),
      lock: { timeoutMs: 10, pollMs: 1, staleAfterMs: 1 },
    })).toThrow("Timed out waiting")
    expect(existsSync(lockPath)).toBe(true)
    expect(state.calls).toEqual([])
  })

  test("removes a dead stale lock and releases its own lock after failure", () => {
    const root = sandbox()
    const lockRoot = join(root, "locks")
    const lockPath = join(lockRoot, "job.timer.lock")
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 2147483647, timestamp: 0 }))
    const state: FakeState = { unitFileState: "disabled", active: false, calls: [] }
    expect(() => installSystemdUnits({
      unitDir: root,
      lockDir: lockRoot,
      serviceUnit: "job.service",
      timerUnit: "job.timer",
      serviceContent: "new service",
      timerContent: "new timer",
      run: fakeRunner(state, "daemon-reload"),
      lock: { timeoutMs: 20, pollMs: 1, staleAfterMs: 1 },
    })).toThrow("daemon-reload")
    expect(existsSync(lockPath)).toBe(false)
  })

  test("a second process cannot interleave with a live installer", async () => {
    const root = sandbox()
    const marker = join(root, "locked")
    const child = spawn("bun", [join(import.meta.dir, "fixtures", "systemd-lock-child.ts"), root, marker, "success"], {
      stdio: "ignore",
    })
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
        await Bun.sleep(5)
      }
      expect(existsSync(marker)).toBe(true)
      const state: FakeState = { unitFileState: "disabled", active: false, calls: [] }
      expect(() => installSystemdUnits({
        unitDir: root,
        lockDir: join(root, "locks"),
        serviceUnit: "job.service",
        timerUnit: "job.timer",
        serviceContent: "second service",
        timerContent: "second timer",
        run: fakeRunner(state),
        lock: { timeoutMs: 20, pollMs: 1 },
      })).toThrow("Timed out waiting")
      expect(state.calls).toEqual([])
      expect(readFileSync(join(root, "job.service"), "utf8")).toBe("child service")
    } finally {
      child.kill()
      await new Promise<void>((resolve) => child.once("exit", () => resolve()))
    }
  })

  test("a failed first process releases the lock before a successful second install", async () => {
    const root = sandbox()
    const marker = join(root, "locked")
    const child = spawn("bun", [join(import.meta.dir, "fixtures", "systemd-lock-child.ts"), root, marker, "fail"], {
      stdio: "ignore",
    })
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) await Bun.sleep(5)
    expect(existsSync(marker)).toBe(true)
    const childExit = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
    expect(childExit).not.toBe(0)
    const state: FakeState = { unitFileState: "disabled", active: false, calls: [] }
    installSystemdUnits({
      unitDir: root,
      lockDir: join(root, "locks"),
      serviceUnit: "job.service",
      timerUnit: "job.timer",
      serviceContent: "second service",
      timerContent: "second timer",
      run: fakeRunner(state),
      lock: { timeoutMs: 500, pollMs: 2 },
    })
    expect(readFileSync(join(root, "job.service"), "utf8")).toBe("second service")
    expect(readFileSync(join(root, "job.timer"), "utf8")).toBe("second timer")
  })
})
