export type LinuxSchedulerBackend = "systemd" | "cron";
export interface SystemdFallbackDependencies {
    installSystemd: () => void;
    isCronAvailable: () => boolean;
    installCron: () => void;
}
export declare function installSystemdWithCronFallback(dependencies: SystemdFallbackDependencies): LinuxSchedulerBackend;
