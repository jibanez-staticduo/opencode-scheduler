import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import type { ExecSyncOptions } from "child_process";
export type SystemdCommandRunner = (command: string, options?: ExecSyncOptions) => Buffer | string;
export interface RuntimeEnvDependencies {
    exists: (path: string) => boolean;
    uid: () => number | undefined;
}
export declare function withSystemdRuntimeEnv(env: NodeJS.ProcessEnv, dependencies?: RuntimeEnvDependencies): NodeJS.ProcessEnv;
export interface SystemdInstallRequest {
    unitDir: string;
    serviceUnit: string;
    timerUnit: string;
    serviceContent: string;
    timerContent: string;
    run: SystemdCommandRunner;
    fileSystem?: SystemdFileSystem;
}
export interface SystemdFileSystem {
    chmod: typeof chmodSync;
    exists: typeof existsSync;
    mkdir: typeof mkdirSync;
    readFile: typeof readFileSync;
    rename: typeof renameSync;
    stat: typeof statSync;
    unlink: typeof unlinkSync;
    writeFile: typeof writeFileSync;
}
export declare function installSystemdUnits(request: SystemdInstallRequest): void;
