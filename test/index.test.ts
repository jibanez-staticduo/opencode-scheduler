/**
 * Unit tests for the fork fixes in src/index.ts.
 *
 * Covers:
 *  1. cronToSystemdCalendars: no invalid "* " wildcard-weekday prefix; all
 *     generated OnCalendar expressions parse with `systemd-analyze calendar`
 *     on Linux hosts that have it.
 *  2. installSystemdJob: unit files are rolled back when a systemctl step
 *     fails, so a failed install never orphans units (the caller removes the
 *     job JSON via deleteJobFile when installJob throws).
 *  3. withSystemdRuntimeEnv: XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS are
 *     derived for systemctl when the parent process lacks them.
 *
 * Run with: bun test
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, statSync } from "fs"
import { join } from "path"
import { homedir, platform } from "os"
import { spawnSync } from "child_process"
import { __test__ } from "../src/index"

const {
  cronToSystemdCalendars,
  createSystemdTimer,
  installSystemdJob,
  uninstallSystemdJob,
  saveJob,
  deleteJobFile,
  jobFilePath,
  withSystemdRuntimeEnv,
  SCOPES_DIR,
  setSystemdCommandRunner,
} = __test__

// === helpers ============================================================

const TEST_SCOPE = "unittest-forkfix"
const UNIT_PREFIX = `opencode-job-${TEST_SCOPE}-`
const LOGS_SCOPE_DIR = join(homedir(), ".config", "opencode", "logs", "scheduler", TEST_SCOPE)

type JobLike = Parameters<typeof installSystemdJob>[0]

function makeJob(slug: string, schedule = "30 8 * * 1"): JobLike {
  return {
    scopeId: TEST_SCOPE,
    slug,
    name: slug,
    schedule,
    prompt: "unit test",
    workdir: "/tmp",
    createdAt: new Date().toISOString(),
  }
}

// Derive the systemd user dir the same way the plugin does.
function systemdUserDir(): string {
  return join(homedir(), ".config", "systemd", "user")
}

function unitFile(slug: string, ext: "service" | "timer"): string {
  return join(systemdUserDir(), `${UNIT_PREFIX}${slug}.${ext}`)
}

function removeUnit(slug: string): void {
  for (const ext of ["service", "timer"] as const) {
    try {
      rmSync(unitFile(slug, ext))
    } catch {}
  }
}

const hasSystemdAnalyze =
  platform() === "linux" && spawnSync("systemd-analyze", ["--version"], { stdio: "ignore" }).status === 0

function calendarParses(calendar: string): boolean {
  return spawnSync("systemd-analyze", ["calendar", calendar], { stdio: "ignore" }).status === 0
}

afterAll(() => {
  setSystemdCommandRunner(null)
  for (const slug of ["rollback", "ok-install", "full-flow"]) {
    removeUnit(slug)
  }
  rmSync(join(SCOPES_DIR, TEST_SCOPE), { recursive: true, force: true })
  rmSync(LOGS_SCOPE_DIR, { recursive: true, force: true })
})

// === Fix 1: cron -> OnCalendar conversion ===============================

describe("cronToSystemdCalendars", () => {
  const cases: Array<[string, string[]]> = [
    ["0 9 * * *", ["*-*-* 09:00:00"]],
    ["0 */6 * * *", ["*-*-* 00:00:00", "*-*-* 06:00:00", "*-*-* 12:00:00", "*-*-* 18:00:00"]],
    ["30 8 * * 1", ["Mon *-*-* 08:30:00"]],
    ["0 10 6 9 *", ["*-09-06 10:00:00"]],
    ["0 9 13 * 5", ["*-*-13 09:00:00", "Fri *-*-* 09:00:00"]],
  ]

  for (const [cron, expected] of cases) {
    test(`converts "${cron}" to valid calendars`, () => {
      expect(cronToSystemdCalendars(cron)).toEqual(expected)
    })
  }

  test("never emits a wildcard weekday prefix", () => {
    const crons = [
      "0 9 * * *",
      "0 */6 * * *",
      "30 8 * * 1",
      "0 10 6 9 *",
      "0 9 13 * 5",
      "*/15 * * * *",
      "0 0 1 1 *",
      "0 0 * * 0",
      "15 3 1,15 * *",
      "0 12 * 3,6,9,12 *",
    ]
    for (const cron of crons) {
      for (const calendar of cronToSystemdCalendars(cron)) {
        // A leading "* " would mean a wildcard day-of-week, which systemd
        // rejects ("* *-09-06 10:00:00" does not parse).
        expect(calendar.startsWith("* ")).toBe(false)
      }
    }
  })

  test("every generated calendar parses with systemd-analyze calendar", () => {
    if (!hasSystemdAnalyze) return // non-Linux host without systemd-analyze
    const crons = [...cases.map(([cron]) => cron), "*/15 * * * *", "0 0 1 1 *", "0 0 * * 7", "5 4 15 6 3"]
    for (const cron of crons) {
      const calendars = cronToSystemdCalendars(cron)
      expect(calendars.length).toBeGreaterThan(0)
      for (const calendar of calendars) {
        expect(calendarParses(calendar)).toBe(true)
      }
    }
  })

  test("timer unit renders OnCalendar lines for all calendars", () => {
    const timer = createSystemdTimer(makeJob("ok-install", "0 10 6 9 *"))
    expect(timer).toContain("OnCalendar=*-09-06 10:00:00")
    expect(timer).not.toContain("OnCalendar=* ")
  })
})

// === Fix 3: systemctl environment =======================================

describe("withSystemdRuntimeEnv", () => {
  const uid = process.getuid?.()
  const realRuntimeDir = typeof uid === "number" ? `/run/user/${uid}` : undefined

  test("preserves an explicit XDG_RUNTIME_DIR", () => {
    const env = withSystemdRuntimeEnv({ XDG_RUNTIME_DIR: "/custom/runtime" })
    expect(env.XDG_RUNTIME_DIR).toBe("/custom/runtime")
    // /custom/runtime/bus does not exist, so no DBUS address is invented.
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })

  test("derives XDG_RUNTIME_DIR from /run/user/<uid> when missing", () => {
    if (!realRuntimeDir || !existsSync(realRuntimeDir)) return
    const env = withSystemdRuntimeEnv({ ...process.env, XDG_RUNTIME_DIR: undefined })
    expect(env.XDG_RUNTIME_DIR).toBe(realRuntimeDir)
  })

  test("derives DBUS_SESSION_BUS_ADDRESS when the bus socket exists", () => {
    if (!realRuntimeDir || !existsSync(join(realRuntimeDir, "bus"))) return
    const env = withSystemdRuntimeEnv({ XDG_RUNTIME_DIR: realRuntimeDir })
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${realRuntimeDir}/bus`)
  })

  test("keeps an explicit DBUS_SESSION_BUS_ADDRESS", () => {
    const env = withSystemdRuntimeEnv({
      XDG_RUNTIME_DIR: "/custom/runtime",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus",
    })
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/custom/bus")
  })
})

// === Fix 2: install rollback / no orphans ================================

describe("installSystemdJob failure handling", () => {
  test("rolls back unit files when systemctl fails (no orphan units)", () => {
    const slug = "rollback"
    removeUnit(slug)
    const calls: string[] = []
    setSystemdCommandRunner((command) => {
      calls.push(command)
      if (command.includes(" enable ")) {
        throw new Error("simulated systemctl failure")
      }
      return Buffer.alloc(0)
    })

    try {
      expect(() => installSystemdJob(makeJob(slug))).toThrow("simulated systemctl failure")
      // Units written before the failure must be gone.
      expect(existsSync(unitFile(slug, "service"))).toBe(false)
      expect(existsSync(unitFile(slug, "timer"))).toBe(false)
      // A daemon-reload is issued after the rollback to refresh systemd state.
      expect(calls.filter((c) => c.includes("daemon-reload")).length).toBeGreaterThanOrEqual(2)
    } finally {
      setSystemdCommandRunner(null)
      removeUnit(slug)
    }
  })

  test("failed install leaves neither units nor job JSON (full flow)", () => {
    const slug = "full-flow"
    removeUnit(slug)
    const job = makeJob(slug)
    // Same order as the schedule_job tool: persist JSON first, then install.
    saveJob(job)
    expect(existsSync(jobFilePath(TEST_SCOPE, slug))).toBe(true)
    // The unit's ExecStart reads the job JSON, so it must already exist here.
    expect(readFileSync(jobFilePath(TEST_SCOPE, slug), "utf-8")).toContain(slug)

    setSystemdCommandRunner((command) => {
      if (command.includes("daemon-reload")) {
        throw new Error("Failed to connect to bus")
      }
      return Buffer.alloc(0)
    })

    try {
      let installError: unknown = null
      try {
        installSystemdJob(job)
      } catch (error) {
        installError = error
      }
      expect(installError).not.toBeNull()
      // This mirrors the tool-level catch block: deleteJobFile(job).
      deleteJobFile(job)
      expect(existsSync(jobFilePath(TEST_SCOPE, slug))).toBe(false)
      expect(existsSync(unitFile(slug, "service"))).toBe(false)
      expect(existsSync(unitFile(slug, "timer"))).toBe(false)
    } finally {
      setSystemdCommandRunner(null)
      deleteJobFile(job)
      removeUnit(slug)
    }
  })

  test("successful install writes 0644 units and enables+starts the timer", () => {
    const slug = "ok-install"
    removeUnit(slug)
    const calls: string[] = []
    setSystemdCommandRunner((command) => {
      calls.push(command)
      return Buffer.alloc(0)
    })

    try {
      installSystemdJob(makeJob(slug))
      expect(existsSync(unitFile(slug, "service"))).toBe(true)
      expect(existsSync(unitFile(slug, "timer"))).toBe(true)
      expect((statSync(unitFile(slug, "service")).mode & 0o777)).toBe(0o644)
      expect((statSync(unitFile(slug, "timer")).mode & 0o777)).toBe(0o644)
      expect(calls.some((c) => c === "systemctl --user daemon-reload")).toBe(true)
      expect(calls.some((c) => c.includes("enable") && c.includes(UNIT_PREFIX + slug + ".timer"))).toBe(true)
      expect(calls.some((c) => c.includes("start") && c.includes(UNIT_PREFIX + slug + ".timer"))).toBe(true)

      // uninstall (stubbed systemctl) must remove the unit files.
      uninstallSystemdJob(makeJob(slug))
      expect(existsSync(unitFile(slug, "service"))).toBe(false)
      expect(existsSync(unitFile(slug, "timer"))).toBe(false)
    } finally {
      setSystemdCommandRunner(null)
      removeUnit(slug)
    }
  })
})
