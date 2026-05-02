import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { paths, defaults } from "../config.mjs";
import { discoverCandidates } from "./nasa-client.mjs";
import { selectFacts } from "./facts.mjs";
import { buildDocumentaryPlan, buildProductionPlan } from "./story-planner.mjs";
import {
  loadContentMemory,
  pickExplorationSeeds,
  rankCandidatesForDiversity,
  recordContentRun
} from "./content-memory.mjs";
import { renderDocumentaryVideo, renderVideo } from "./render.mjs";

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, number));
}

export function normalizeBrief(input) {
  const allowedTypes = new Set(["learning_short", "documentary"]);
  const productionType = allowedTypes.has(input.productionType) ? input.productionType : "learning_short";
  const isDocumentary = productionType === "documentary";

  return {
    productionType,
    topic: cleanText(input.topic, "ISS launch"),
    angle: cleanText(input.angle, "Teach one clear idea about what this real footage shows."),
    hook: cleanText(input.hook, "What is this NASA footage showing?"),
    endingQuestion: isDocumentary ? cleanText(input.endingQuestion, "What should part two explain next?") : "",
    shortDurationSeconds: clampNumber(input.shortDurationSeconds, 12, 180, defaults.durationSeconds),
    documentaryMinutes: clampNumber(input.documentaryMinutes, 3, 60, 12),
    preferAudioNarrative: Boolean(input.preferAudioNarrative),
    protectLandscape: input.protectLandscape !== false
  };
}

async function persistResult(jobDir, payload) {
  await fs.writeFile(path.join(jobDir, "result.json"), JSON.stringify(payload, null, 2));
}

async function writeDocumentaryScript(jobDir, plan, factPack) {
  const file = path.join(jobDir, "documentary-script.md");
  const lines = [
    `# ${plan.script.hookLine}`,
    "",
    `Target length: ${plan.documentary.targetMinutes} minutes`,
    `Estimated narration: ${plan.documentary.estimatedWords} words`,
    "",
    "## Source Facts",
    ...factPack.facts.map((fact) => `- ${fact.text} (${fact.source})`),
    "",
    "## Chapters",
    ...plan.documentary.chapters.flatMap((chapter) => [
      "",
      `### ${chapter.startMinute}-${chapter.endMinute} min: ${chapter.title}`,
      `Narration goal: ${chapter.narrationGoal}`,
      `On-screen text: ${chapter.onScreenText}`,
      `B-roll need: ${chapter.brollNeed}`,
      `Primary source clip: ${chapter.sourceClip?.title || "TBD"}`
    ]),
    "",
    "## Edit Notes",
    ...plan.editorNotes.map((note) => `- ${note}`)
  ];

  await fs.writeFile(file, lines.join("\n"));
  return file;
}

function buildDiscoveryOptions(brief, memory, extra = {}) {
  return {
    ...extra,
    explorationSeeds: pickExplorationSeeds(memory, brief),
    verticalBias: brief.productionType !== "documentary",
    learningBias: brief.productionType === "learning_short",
    documentaryBias: brief.productionType === "documentary"
  };
}

function averageAudioPotential(candidates) {
  return candidates.reduce((sum, candidate) => sum + candidate.audioPotential, 0) / Math.max(candidates.length, 1);
}

export async function runPipeline(rawBrief, progress = () => {}) {
  const brief = normalizeBrief(rawBrief);
  const jobId = nanoid(10);
  const jobDir = path.join(paths.jobsDir, jobId);
  const contentMemory = await loadContentMemory();

  await fs.mkdir(jobDir, { recursive: true });
  progress({ at: nowIso(), stage: "brief", message: "Locked the creative brief." });
  progress({
    at: nowIso(),
    stage: "strategy",
    message: "Loaded content memory so recent clips and overused topics are penalized before selection."
  });

  let candidates = await discoverCandidates(
    brief,
    buildDiscoveryOptions(brief, contentMemory, { audioBias: false }),
    (message) => progress({ at: nowIso(), stage: "research", message })
  );

  if (!candidates.length) {
    throw new Error("No usable NASA video candidates were found for this brief.");
  }

  let factPack = selectFacts(brief, candidates);
  candidates = rankCandidatesForDiversity(candidates, brief, contentMemory);
  factPack = selectFacts(brief, candidates);
  progress({
    at: nowIso(),
    stage: "strategy",
    message: `Diversity rerank selected: ${candidates[0]?.title || "no clip"}`
  });

  if (brief.productionType === "documentary") {
    if (brief.preferAudioNarrative && averageAudioPotential(candidates) < 0.52) {
      progress({
        at: nowIso(),
        stage: "research",
        message: "Documentary outline needed more source audio. Searching for mission-control, interview, and crew-communication material."
      });

      candidates = await discoverCandidates(
        brief,
        buildDiscoveryOptions(brief, contentMemory, { audioBias: true }),
        (message) => progress({ at: nowIso(), stage: "research", message })
      );

      factPack = selectFacts(brief, candidates);
      candidates = rankCandidatesForDiversity(candidates, brief, contentMemory);
      factPack = selectFacts(brief, candidates);
    }

    const plan = buildDocumentaryPlan(brief, candidates, factPack);
    const scriptFile = await writeDocumentaryScript(jobDir, plan, factPack);
    const render = await renderDocumentaryVideo({
      jobId,
      jobDir,
      outputDir: paths.outputDir,
      plan,
      logger: (message) => progress({ at: nowIso(), stage: "render", message })
    });

    const result = {
      jobId,
      createdAt: nowIso(),
      brief,
      challenge: null,
      factPack,
      plan,
      outputs: {
        videoFile: render.outputFile,
        scriptFile,
        packageFile: path.join(jobDir, "result.json")
      },
      qualityChecks: render.qualityChecks,
      leaderKit: {
        pinnedComment: `${plan.script.factLine} What should part two explain next?`,
        replyTemplates: factPack.replies,
        disclosure: factPack.disclosure
      }
    };

    await persistResult(jobDir, result);
    await recordContentRun(result);
    progress({
      at: nowIso(),
      stage: "done",
      message: `Documentary video saved to ${render.outputFile}; script package saved to ${scriptFile}.`
    });

    return result;
  }

  let plan = buildProductionPlan(brief, candidates, factPack);

  if (plan.audioAssessment.needsAudioReplan) {
    progress({
      at: nowIso(),
      stage: "research",
      message: "Story leaned too hard on narration. Widening search toward clips with stronger built-in audio."
    });

    candidates = await discoverCandidates(
      brief,
      buildDiscoveryOptions(brief, contentMemory, { audioBias: true }),
      (message) => progress({ at: nowIso(), stage: "research", message })
    );

    factPack = selectFacts(brief, candidates);
    candidates = rankCandidatesForDiversity(candidates, brief, contentMemory);
    factPack = selectFacts(brief, candidates);
    plan = buildProductionPlan(brief, candidates, factPack, { replannedForAudio: true });
  }

  progress({
    at: nowIso(),
    stage: "edit",
    message: `Selected ${plan.selectedCandidates.length} clip and planned a complete single-idea learning short.`
  });

  const render = await renderVideo({
    jobId,
    jobDir,
    outputDir: paths.outputDir,
    plan,
    logger: (message) => progress({ at: nowIso(), stage: "render", message })
  });

  const outputVideo = render.outputFile;
  const result = {
    jobId,
    createdAt: nowIso(),
    brief,
    challenge: null,
    factPack,
    plan,
    outputs: {
      videoFile: outputVideo
    },
    qualityChecks: render.qualityChecks,
    leaderKit: {
      pinnedComment:
        `${plan.script.factLine} What should this lesson explain next?`,
      replyTemplates: factPack.replies,
      disclosure: factPack.disclosure
    }
  };

  await persistResult(jobDir, result);
  await recordContentRun(result);

  progress({
    at: nowIso(),
    stage: "done",
    message: `Render complete. Final video saved to ${outputVideo}.`
  });

  return result;
}
