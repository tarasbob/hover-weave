/** Private child-process entry point. Only the trusted parent invokes this. */
import { VERIFICATION_LIMITS } from "./manifest";
import { VerificationError, verifyCompetitionFlight } from "./verify";

async function main(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > VERIFICATION_LIMITS.bytes) throw new VerificationError("payload", "Flight exceeds the 2 MiB payload limit");
      chunks.push(buffer);
    }
    const result = verifyCompetitionFlight(Buffer.concat(chunks).toString("utf8"), {
      seasonId: process.argv[2], courseId: process.argv[3],
    }, Number(process.argv[4]));
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) {
    const failure = error instanceof VerificationError ? error :
      new VerificationError("unavailable", "Verification failed internally");
    process.stdout.write(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
    process.exitCode = 1;
  }
}

void main();
