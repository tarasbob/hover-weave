/** Trusted Node host entry point; this module must never enter a client graph. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERIFICATION_LIMITS, type CompetitionSelection } from "./manifest";
import { VerificationError, type VerifiedFlight, type VerificationCode } from "./verify";

let activeWorkers = 0;
const MAX_WORKERS = 2;

/**
 * One bounded child process per replay, at most two per host process. Deploy
 * with a bounded job queue; rejection under load is deliberately fail-closed.
 */
export async function verifyFlightInWorker(
  text: string,
  selection: CompetitionSelection,
  options: { receivedAt?: number; timeoutMs?: number } = {},
): Promise<VerifiedFlight> {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > VERIFICATION_LIMITS.bytes) {
    throw new VerificationError("payload", "Flight exceeds the 2 MiB payload limit");
  }
  if (typeof selection.seasonId !== "string" || typeof selection.courseId !== "string" ||
    selection.seasonId.length > 100 || selection.courseId.length > 100) {
    throw new VerificationError("course", "Malformed course selection");
  }
  if (activeWorkers >= MAX_WORKERS) throw new VerificationError("unavailable", "Verification workers are busy");
  const receivedAt = options.receivedAt ?? Date.now();
  const timeoutMs = options.timeoutMs ?? VERIFICATION_LIMITS.wallTimeMs;
  if (!Number.isSafeInteger(receivedAt) || !Number.isInteger(timeoutMs) || timeoutMs <= 0 ||
    timeoutMs > VERIFICATION_LIMITS.wallTimeMs) throw new VerificationError("unavailable", "Invalid trusted worker policy");
  activeWorkers++;
  let spawned = false;
  try {
    return await new Promise<VerifiedFlight>((resolve, reject) => {
      // The source entry point and tsx runtime ship together in the verifier
      // deployment; neither path nor executable comes from the submitted file.
      const worker = spawn(process.execPath, [
        `--max-old-space-size=${VERIFICATION_LIMITS.heapMb}`, "--import", "tsx",
        fileURLToPath(new URL("./worker.ts", import.meta.url)),
        selection.seasonId, selection.courseId, String(receivedAt),
      ], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        stdio: ["pipe", "pipe", "ignore"],
      });
      spawned = true;
      let output = "";
      let settled = false;
      const finish = (error?: VerificationError, result?: VerifiedFlight) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(() => {
        worker.kill("SIGKILL");
        finish(new VerificationError("timeout", "Verification worker exceeded its wall-clock budget"));
      }, timeoutMs);
      worker.on("error", () => finish(new VerificationError("unavailable", "Verification worker could not start")));
      worker.stdout.setEncoding("utf8");
      worker.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 16_384) {
          worker.kill("SIGKILL");
          finish(new VerificationError("unavailable", "Verification worker output exceeded its limit"));
        }
      });
      worker.stdin.on("error", () => { /* Worker rejection can close input early. */ });
      worker.on("close", (code) => {
        // Keep the slot occupied until the process is actually reaped, even
        // when a timeout already rejected the caller's promise.
        activeWorkers--;
        if (settled) return;
        try {
          const response = JSON.parse(output) as {
            result?: VerifiedFlight;
            error?: { code: VerificationCode; message: string };
          };
          if (response.error) finish(new VerificationError(response.error.code, response.error.message));
          else if (code === 0 && response.result?.verified === true) finish(undefined, response.result);
          else finish(new VerificationError("unavailable", "Verification worker did not return a result"));
        } catch { finish(new VerificationError("unavailable", "Verification worker failed")); }
      });
      worker.stdin.end(text, "utf8");
    });
  } finally {
    if (!spawned) activeWorkers--;
  }
}
