/** Unit tests for cron conversion and transactional systemd installation. */
import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
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
  enabled: boolean
  active: boolean
  calls: string[]
}

function fakeRunner(state: FakeState, failure?: FailurePoint): SystemdCommandRunner {
  return (command) => {
    state.calls.push(command)
    if (command.includes("is-enabled")) return Buffer.from(state.enabled ? "enabled\n" : "disabled\n")
    if (command.includes("is-active")) return Buffer.from(state.active ? "active\n" : "inactive\n")
    if (failure === "daemon-reload" && command.endsWith("daemon-reload") && state.calls.filter((call) => call.endsWith("daemon-reload")).length === 1) throw new Error(failure)
    if (failure === "enable" && command.includes(" enable ")) throw new Error(failure)
    if (failure === "start" && command.includes(" start ") && state.calls.filter((call) => call.includes(" start ")).length === 1) throw new Error(failure)
    if (command.includes(" enable ")) state.enabled = true
    if (command.includes(" disable ")) state.enabled = false
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
    mkdir: mkdirSync,
    readFile: readFileSync,
    rename: renameSync,
    stat: statSync,
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

function install(root: string, state: FakeState, failure?: FailurePoint): void {
  installSystemdUnits({
    unitDir: root,
    serviceUnit: "job.service",
    timerUnit: "job.timer",
    serviceContent: "new service",
    timerContent: "new timer",
    run: fakeRunner(state, failure),
    fileSystem: failingFileSystem(failure),
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
    const state: FakeState = { enabled: false, active: false, calls: [] }
    install(root, state)
    expect(readFileSync(join(root, "job.service"), "utf8")).toBe("new service")
    expect(statSync(join(root, "job.timer")).mode & 0o777).toBe(0o644)
    expect(state.enabled).toBe(true)
    expect(state.active).toBe(true)
  })

  for (const failure of ["first-write", "second-write", "second-chmod", "daemon-reload", "enable", "start"] as FailurePoint[]) {
    test(`clean install rolls back ${failure} failure`, () => {
      const root = sandbox()
      const state: FakeState = { enabled: false, active: false, calls: [] }
      expect(() => install(root, state, failure)).toThrow(failure)
      expect(existsSync(join(root, "job.service"))).toBe(false)
      expect(existsSync(join(root, "job.timer"))).toBe(false)
      expect(state.enabled).toBe(false)
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
      const state: FakeState = { enabled: true, active: true, calls: [] }
      expect(() => install(root, state, failure)).toThrow(failure)
      expect(readFileSync(service, "utf8")).toBe("old service")
      expect(readFileSync(timer, "utf8")).toBe("old timer")
      expect(statSync(service).mode & 0o777).toBe(0o600)
      expect(statSync(timer).mode & 0o777).toBe(0o640)
      expect(state.enabled).toBe(true)
      expect(state.active).toBe(true)
    })
  }

  test("never references or mutates an unscoped legacy unit", () => {
    const root = sandbox()
    const legacy = join(root, "opencode-job-legacy.timer")
    writeFileSync(legacy, "legacy")
    const state: FakeState = { enabled: false, active: false, calls: [] }
    install(root, state)
    expect(readFileSync(legacy, "utf8")).toBe("legacy")
    expect(state.calls.some((call) => call.includes("legacy"))).toBe(false)
  })
})
