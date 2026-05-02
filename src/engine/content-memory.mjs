import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.mjs";

const MEMORY_FILE = path.join(paths.dataDir, "content-memory.json");
const MAX_RUNS = 180;

const EXPLORATION_TOPICS = [
  { id: "rocket", query: "rocket launch countdown", terms: ["rocket", "launch", "booster", "countdown", "artemis"] },
  { id: "iss", query: "ISS spacewalk astronaut", terms: ["iss", "space station", "spacewalk", "astronaut"] },
  { id: "mars", query: "Mars rover surface", terms: ["mars", "rover", "jezero", "curiosity", "perseverance"] },
  { id: "moon", query: "Moon lunar mission", terms: ["moon", "lunar", "apollo", "artemis"] },
  { id: "webb", query: "Webb telescope nebula", terms: ["webb", "jwst", "infrared", "nebula"] },
  { id: "hubble", query: "Hubble galaxy deep space", terms: ["hubble", "galaxy", "deep field"] },
  { id: "jupiter", query: "Jupiter moon volcanic", terms: ["jupiter", "juno", "volcanic moon"] },
  { id: "saturn", query: "Saturn rings spacecraft", terms: ["saturn", "rings", "cassini"] },
  { id: "sun", query: "solar flare sun observatory", terms: ["solar", "sun", "flare", "corona"] },
  { id: "asteroid", query: "asteroid sample return", terms: ["asteroid", "sample", "osiris", "bennu"] }
];

function emptyMemory() {
  return {
    version: 1,
    runs: [],
    feedback: []
  };
}

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash >>> 0);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textHasTerm(text, term) {
  const normalizedTerm = normalizeText(term);
  if (normalizedTerm.includes(" ")) {
    return text.includes(normalizedTerm);
  }

  return new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`).test(text);
}

function candidateText(candidate, brief = {}) {
  return normalizeText([
    brief.topic,
    brief.angle,
    candidate?.title,
    candidate?.description,
    ...(candidate?.keywords || [])
  ].join(" "));
}

export function getTopicFamily(candidate, brief = {}) {
  const text = candidateText(candidate, brief);
  const scored = EXPLORATION_TOPICS.map((topic) => ({
    topic,
    hits: topic.terms.reduce((sum, term) => sum + (textHasTerm(text, term) ? 1 : 0), 0)
  })).sort((left, right) => right.hits - left.hits);

  return scored.find((item) => item.hits > 0)?.topic.id || "general-space";
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function runFromResult(result) {
  const candidate = result?.plan?.selectedCandidates?.[0];
  if (!candidate?.nasaId) {
    return null;
  }

  return {
    at: result.createdAt || new Date().toISOString(),
    jobId: result.jobId,
    nasaId: candidate.nasaId,
    title: candidate.title,
    center: candidate.center || "",
    topicFamily: getTopicFamily(candidate, result.brief),
    plannedDurationSeconds: result.plan?.plannedDurationSeconds || null,
    outputFile: result.outputs?.videoFile || null
  };
}

function normalizeRun(run) {
  return {
    ...run,
    topicFamily: getTopicFamily({ title: run.title, center: run.center }, {})
  };
}

async function seedRunsFromPastJobs(memory) {
  if (memory.runs?.length) {
    return memory;
  }

  try {
    const jobDirs = await fs.readdir(paths.jobsDir, { withFileTypes: true });
    const runs = [];
    for (const dir of jobDirs) {
      if (!dir.isDirectory()) {
        continue;
      }

      const result = await readJson(path.join(paths.jobsDir, dir.name, "result.json"), null);
      const run = runFromResult(result);
      if (run) {
        runs.push(run);
      }
    }

    return {
      ...memory,
      runs: runs.sort((left, right) => (left.at < right.at ? 1 : -1)).slice(0, MAX_RUNS)
    };
  } catch {
    return memory;
  }
}

export async function loadContentMemory() {
  await fs.mkdir(paths.dataDir, { recursive: true });
  const memory = await readJson(MEMORY_FILE, emptyMemory());
  return seedRunsFromPastJobs({
    ...emptyMemory(),
    ...memory,
    runs: Array.isArray(memory.runs) ? memory.runs.map(normalizeRun) : [],
    feedback: Array.isArray(memory.feedback) ? memory.feedback : []
  });
}

async function saveContentMemory(memory) {
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

export function pickExplorationSeeds(memory, brief = {}, count = 3) {
  const recentRuns = (memory.runs || []).slice(0, 30);
  const recentCounts = new Map();
  for (const run of recentRuns) {
    recentCounts.set(run.topicFamily, (recentCounts.get(run.topicFamily) || 0) + 1);
  }

  const currentTopic = normalizeText(`${brief.topic} ${brief.angle}`);
  return EXPLORATION_TOPICS
    .map((topic) => ({
      topic,
      score:
        -(recentCounts.get(topic.id) || 0) * 2 +
        (topic.terms.some((term) => textHasTerm(currentTopic, term)) ? 1.5 : 0) +
        (hashString(`${topic.id}:${new Date().toISOString().slice(0, 10)}`) % 100) / 100
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, count)
    .map((item) => item.topic.query);
}

export function rankCandidatesForDiversity(candidates, brief, memory) {
  const recentRuns = memory.runs || [];
  const recentClipIds = recentRuns.map((run) => run.nasaId);
  const recentFamilies = recentRuns.slice(0, 24).map((run) => run.topicFamily);
  const recentCenters = recentRuns.slice(0, 16).map((run) => run.center).filter(Boolean);
  const dayBucket = new Date().toISOString().slice(0, 10);

  return candidates
    .map((candidate) => {
      const family = getTopicFamily(candidate, brief);
      const exactUseIndex = recentClipIds.indexOf(candidate.nasaId);
      const familyCount = recentFamilies.filter((item) => item === family).length;
      const centerCount = recentCenters.filter((item) => item === candidate.center).length;
      const exactPenalty = exactUseIndex === -1 ? 0 : exactUseIndex < 5 ? 18 : exactUseIndex < 20 ? 10 : 5;
      const familyPenalty = Math.min(8, familyCount * 1.25);
      const centerPenalty = Math.min(3, centerCount * 0.4);
      const noveltyBonus = familyCount === 0 ? 2.5 : 0;
      const stableJitter = (hashString(`${candidate.nasaId}:${dayBucket}`) % 125) / 100;
      const diversityScore = Number(
        (candidate.score - exactPenalty - familyPenalty - centerPenalty + noveltyBonus + stableJitter).toFixed(3)
      );

      return {
        ...candidate,
        topicFamily: family,
        diversityScore,
        diversityNotes: {
          exactPenalty,
          familyPenalty: Number(familyPenalty.toFixed(2)),
          centerPenalty: Number(centerPenalty.toFixed(2)),
          noveltyBonus,
          stableJitter: Number(stableJitter.toFixed(2))
        }
      };
    })
    .sort((left, right) => right.diversityScore - left.diversityScore);
}

export async function recordContentRun(result) {
  const memory = await loadContentMemory();
  const run = runFromResult(result);
  if (!run) {
    return memory;
  }

  const nextRuns = [run, ...memory.runs.filter((item) => item.nasaId !== run.nasaId || item.jobId !== run.jobId)]
    .slice(0, MAX_RUNS);
  const nextMemory = {
    ...memory,
    runs: nextRuns
  };
  await saveContentMemory(nextMemory);
  return nextMemory;
}

export async function recordRetentionFeedback(feedback) {
  const memory = await loadContentMemory();
  const nextMemory = {
    ...memory,
    feedback: [
      {
        at: new Date().toISOString(),
        ...feedback
      },
      ...memory.feedback
    ].slice(0, 500)
  };

  await saveContentMemory(nextMemory);
  return nextMemory;
}
