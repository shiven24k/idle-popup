import { execFile } from "child_process";

/**
 * Run a small helper command. Resolves to trimmed stdout, or null when the
 * command is missing, fails or times out. Never rejects, so platform probes
 * can be chained without try/catch noise.
 */
export function run(cmd: string, args: string[], timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, encoding: "utf8" },
      (err, stdout) => resolve(err ? null : String(stdout).trim())
    );
  });
}
