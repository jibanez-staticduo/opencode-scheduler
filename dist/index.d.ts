/**
 * OpenCode Scheduler Plugin
 *
 * Schedule recurring jobs using launchd (Mac), systemd (Linux), schtasks (Windows), or cron fallback.
 * Jobs are stored under ~/.config/opencode/scheduler/ (scoped by workdir).
 *
 * Features:
 * - Survives reboots
 * - Catches up on missed runs (if computer was asleep)
 * - Cross-platform (Mac + Linux + Windows)
 * - Working directory support for MCP configs
 * - Environment variable injection (PATH for node/npx)
 */
import type { Plugin } from "@opencode-ai/plugin";
import { execSync } from "child_process";
declare function jobFilePath(scopeId: string, slug: string): string;
type OpencodeRunFormat = "default" | "json";
interface JobRunSpec {
    prompt?: string;
    command?: string;
    arguments?: string;
    files?: string[];
    agent?: string;
    model?: string;
    variant?: string;
    title?: string;
    share?: boolean;
    continue?: boolean;
    session?: string;
    runFormat?: OpencodeRunFormat;
    attachUrl?: string;
    port?: number;
}
type JobInvocation = {
    command: string;
    args: string[];
};
interface Job {
    scopeId?: string;
    slug: string;
    name: string;
    schedule: string;
    prompt?: string;
    attachUrl?: string;
    run?: JobRunSpec;
    invocation?: JobInvocation;
    timeoutSeconds?: number;
    source?: string;
    workdir?: string;
    createdAt: string;
    updatedAt?: string;
    lastRunAt?: string;
    lastRunExitCode?: number;
    lastRunError?: string;
    lastRunSource?: "manual" | "scheduled";
    lastRunStatus?: "running" | "success" | "failed";
}
declare function cronToSystemdCalendars(cron: string): string[];
declare function withSystemdRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
declare function systemdRunEnv(): NodeJS.ProcessEnv;
type SystemdCommandRunner = (command: string, options?: Parameters<typeof execSync>[1]) => ReturnType<typeof execSync>;
declare function createSystemdTimer(job: Job): string;
declare function installSystemdJob(job: Job): void;
declare function uninstallSystemdJob(job: Job): void;
declare function saveJob(job: Job): void;
declare function deleteJobFile(job: Job): void;
export declare const SchedulerPlugin: Plugin;
export default SchedulerPlugin;
export type { SystemdCommandRunner };
export declare const __test__: {
    cronToSystemdCalendars: typeof cronToSystemdCalendars;
    createSystemdTimer: typeof createSystemdTimer;
    withSystemdRuntimeEnv: typeof withSystemdRuntimeEnv;
    systemdRunEnv: typeof systemdRunEnv;
    installSystemdJob: typeof installSystemdJob;
    uninstallSystemdJob: typeof uninstallSystemdJob;
    saveJob: typeof saveJob;
    deleteJobFile: typeof deleteJobFile;
    jobFilePath: typeof jobFilePath;
    SYSTEMD_USER_DIR: string;
    SCOPES_DIR: string;
    setSystemdCommandRunner(runner: SystemdCommandRunner | null): void;
};
