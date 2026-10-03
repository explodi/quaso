// SPDX-License-Identifier: MIT
import { spawn as startProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

export interface CommandStatus {
  code: number;
  success: boolean;
  signal: string | null;
}
type Stdio = "inherit" | "piped" | "null";
interface Options {
  signal?: AbortSignal;
  args?: string[];
  cwd?: string | URL;
  env?: Record<string, string | undefined>;
  clearEnv?: boolean;
  stdin?: Stdio;
  stdout?: Stdio;
  stderr?: Stdio;
}

/** Starts subprocesses with explicit environment and output ownership. */
export class Command {
  constructor(
    private executable: string | URL,
    private options: Options = {},
  ) {}
  spawn() {
    const options = this.options;
    const mode = (value: Stdio | undefined) =>
      value === "piped" ? "pipe" : value === "null" ? "ignore" : "inherit";
    const child = startProcess(
      this.executable instanceof URL ? fileURLToPath(this.executable) : this.executable,
      options.args ?? [],
      {
        signal: options.signal,
        cwd: options.cwd,
        env: options.clearEnv ? options.env : { ...process.env, ...options.env },
        stdio: [mode(options.stdin), mode(options.stdout), mode(options.stderr)],
      },
    );
    const status = new Promise<CommandStatus>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve({ code: code ?? 1, success: code === 0, signal }),
      );
    });
    const output = async () => {
      const bytes = async (stream: Readable | null) =>
        stream
          ? new Uint8Array(
              await new Response(
                Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>,
              ).arrayBuffer(),
            )
          : new Uint8Array();
      const [result, stdout, stderr] = await Promise.all([
        status,
        bytes(child.stdout),
        bytes(child.stderr),
      ]);
      return { ...result, stdout, stderr };
    };
    return {
      output,
      pid: child.pid!,
      status,
      get stdout() {
        return child.stdout
          ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>)
          : null!;
      },
      get stderr() {
        return child.stderr
          ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>)
          : null!;
      },
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        child.kill(signal);
      },
    };
  }
  async output() {
    return new Command(this.executable, { stdout: "piped", stderr: "piped", ...this.options })
      .spawn()
      .output();
  }
}
