import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.mjs";
import { runPipeline } from "../engine/orchestrator.mjs";
import { buildUploadDraft, chooseNextBrief } from "./growth-policy.mjs";

const DEFAULT_HASHTAGS = ["#Space", "#NASA", "#Science", "#Astrophysics", "#Shorts"];

function slugify(value) {
  return String(value || "learning_short")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "learning_short";
}

function toRepoPath(filePath) {
  return path.relative(paths.rootDir, filePath).replace(/\\/g, "/");
}

function buildLegacyScriptRecord(result, brief, uploadDraft) {
  const candidate = result.plan.selectedCandidates[0] || {};
  const factTexts = (result.factPack?.facts || []).map((fact) => fact.text);
  const title = uploadDraft.title || result.plan.script.hookLine || "Astrophysics Short";
  const renderedAt = new Date().toISOString();

  return {
    idea: {
      topic: brief.topic,
      topic_family: candidate.topicFamily || brief.armId || "learning_short",
      hook: result.plan.script.hookLine,
      facts: factTexts,
      payoff: result.plan.script.factLine,
      title,
      hashtags: DEFAULT_HASHTAGS,
      generated_at: result.createdAt,
      status: "formatted",
      strategy_based: true
    },
    script: {
      total_duration: result.plan.plannedDurationSeconds,
      scenes: [
        {
          scene_number: 1,
          start_time: 0,
          duration: result.plan.plannedDurationSeconds,
          text: result.plan.script.factLine,
          text_position: "bottom",
          text_size: "medium",
          visual: candidate.title || "Real NASA source footage",
          animation: "none"
        }
      ],
      background_style: "real_nasa_footage",
      thumbnail_text: title
    },
    upload: {
      title,
      description: uploadDraft.description,
      tags: uploadDraft.tags
    },
    learning_short: {
      job_id: result.jobId,
      arm_id: brief.armId,
      source_title: candidate.title || null,
      source_nasa_id: candidate.nasaId || null,
      source_url: candidate.nasaId ? `https://images.nasa.gov/details/${candidate.nasaId}` : null,
      source_media_url: candidate.mp4Url || null,
      planned_duration_seconds: result.plan.plannedDurationSeconds,
      duration_policy: result.plan.durationPolicy,
      what_it_is_card: result.plan.script.factLine,
      quality_checks: result.qualityChecks,
      leader_kit: result.leaderKit
    },
    formatted_at: result.createdAt,
    rendered_at: renderedAt,
    video_path: toRepoPath(result.outputs.videoFile),
    status: "rendered"
  };
}

async function main() {
  await fs.mkdir(paths.jobsDir, { recursive: true });
  await fs.mkdir(paths.outputDir, { recursive: true });

  const brief = await chooseNextBrief();
  const logs = [];

  const result = await runPipeline(brief, (entry) => {
    logs.push(entry);
    console.log(`[${entry.stage}] ${entry.message}`);
  });

  const uploadDraft = buildUploadDraft(result, brief);

  const scriptsDir = path.join(paths.rootDir, "scripts_output");
  await fs.mkdir(scriptsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  const scriptPath = path.join(scriptsDir, `${slugify(brief.topic)}_${timestamp}.json`);
  const scriptRecord = buildLegacyScriptRecord(result, brief, uploadDraft);

  await fs.writeFile(scriptPath, JSON.stringify(scriptRecord, null, 2));

  const queueDir = path.join(paths.dataDir, "upload-queue");
  await fs.mkdir(queueDir, { recursive: true });
  await fs.writeFile(
    path.join(queueDir, `${result.jobId}.json`),
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
  console.log(`Learning short video: ${toRepoPath(result.outputs.videoFile)}`);
  console.log(`Uploader handoff: ${toRepoPath(scriptPath)}`);
  console.log("Status: rendered; ready for the existing YouTube uploader.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
