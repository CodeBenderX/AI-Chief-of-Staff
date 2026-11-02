import { spawn } from "node:child_process";

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Sandbox {
  readonly kind: string;
  run(req: { language: "python" | "node" | "bash"; code: string; timeoutMs: number }): Promise<SandboxResult>;
}

/** Default: code execution is off until an isolated runtime is configured. */
export class DisabledSandbox implements Sandbox {
  readonly kind = "disabled";
  async run(): Promise<SandboxResult> {
    throw new Error("code execution is disabled: configure SANDBOX=docker to enable isolated execution");
  }
}

const IMAGES = { python: "python:3.12-alpine", node: "node:22-alpine", bash: "alpine:3.20" } as const;
const CMDS = { python: ["python", "-"], node: ["node", "-"], bash: ["sh", "-s"] } as const;
const MAX_OUTPUT = 64 * 1024;

/**
 * Runs untrusted code in a throwaway Docker container: no network, read-only
 * root filesystem, non-root user, capped CPU / memory / processes, hard timeout.
 * Never executes on the host itself.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker";
  constructor(private docker = "docker") {}

  run(req: { language: "python" | "node" | "bash"; code: string; timeoutMs: number }): Promise<SandboxResult> {
    const name = `aicos-sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const args = [
      "run", "--rm", "-i", "--name", name,
      "--network", "none",
      "--read-only", "--tmpfs", "/tmp:rw,size=32m",
      "--memory", "256m", "--memory-swap", "256m",
      "--cpus", "0.5", "--pids-limit", "64",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", "65534:65534",
      IMAGES[req.language], ...CMDS[req.language],
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.docker, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        spawn(this.docker, ["kill", name]).on("error", () => {});
        child.kill("SIGKILL");
      }, req.timeoutMs);
      child.stdout.on("data", (d) => (stdout = (stdout + d).slice(0, MAX_OUTPUT)));
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(0, MAX_OUTPUT)));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
      child.stdin.end(req.code);
    });
  }
}
