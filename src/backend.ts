export type LinuxSchedulerBackend = "systemd" | "cron"

export interface SystemdFallbackDependencies {
  installSystemd: () => void
  isCronAvailable: () => boolean
  installCron: () => void
}

export function installSystemdWithCronFallback(dependencies: SystemdFallbackDependencies): LinuxSchedulerBackend {
  try {
    dependencies.installSystemd()
    return "systemd"
  } catch (error) {
    if (!dependencies.isCronAvailable()) throw error
    dependencies.installCron()
    return "cron"
  }
}
