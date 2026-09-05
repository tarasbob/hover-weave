/** Operator CLI: never trust a client-supplied verdict from this same command. */
import { open } from "node:fs/promises";
import { COMPETITION_SEASONS, VERIFICATION_LIMITS, competitionCourseKey } from "../src/game/competition/manifest";
import { verifyFlightInWorker } from "../src/game/competition/server";
import { VerificationError } from "../src/game/competition/verify";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--list") {
    console.log(JSON.stringify(COMPETITION_SEASONS.map((season) => ({
      ...season,
      courses: season.courses.map((course) => ({ ...course, courseKey: competitionCourseKey(season, course) })),
    })), null, 2));
    return;
  }
  if (args.length !== 3) {
    throw new Error("Usage: npm run verify:flight -- <season-id> <course-id> <recording.flight> | --list");
  }
  const [seasonId, courseId, path] = args;
  const file = await open(path, "r");
  let payload: string;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > VERIFICATION_LIMITS.bytes) {
      throw new VerificationError("payload", "Expected a regular .flight file of at most 2 MiB");
    }
    // A bounded read also handles a file that grows after stat; no unbounded
    // readFile or special-device read occurs at the operator boundary.
    const buffer = Buffer.alloc(VERIFICATION_LIMITS.bytes + 1);
    let read = 0;
    while (read < buffer.length) {
      const result = await file.read(buffer, read, buffer.length - read, read);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    if (read > VERIFICATION_LIMITS.bytes) throw new VerificationError("payload", "Flight exceeds the 2 MiB payload limit");
    payload = buffer.subarray(0, read).toString("utf8");
  } finally { await file.close(); }
  console.log(JSON.stringify(await verifyFlightInWorker(payload, { seasonId, courseId }), null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    verified: false,
    code: error instanceof VerificationError ? error.code : "usage",
    error: error instanceof Error ? error.message : "Verification failed",
  }));
  process.exitCode = 1;
});
