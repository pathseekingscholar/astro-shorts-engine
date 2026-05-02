import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.mjs";
import { runPipeline } from "../engine/orchestrator.mjs";
import { buildUploadDraft, chooseNextBrief } from "./growth-policy.mjs";

async function main() {
  await fs.mkdir(paths.jobsDir, { recursive: true });
  await fs.mkdir(paths.outputDir, { recursive: true });

  const brief = await chooseNextBrief();
  const logs = [];
  const result = await runPipeline(brief, (entry) => {
    logs.push(entry);
    console.log(`[${entry.stage}] ${entry.message}`);
  });

  const queueDir = path.join(paths.dataDir, "upload-queue");
  await fs.mkdir(queueDir, { recursive: true });

  const uploadDraft = buildUploadDraft(result, brief);
  const queueFile = path.join(queueDir, `${result.jobId}.json`);
  await fs.writeFile(
    queueFile,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        brief,
        uploadDraft,
        logs
      },
      null,
      2
    )
  );

  console.log("");
  console.log(`Draft video: ${result.outputs.videoFile}`);
  console.log(`Upload queue item: ${queueFile}`);
  console.log("Status: pending approval; no YouTube upload was attempted.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
