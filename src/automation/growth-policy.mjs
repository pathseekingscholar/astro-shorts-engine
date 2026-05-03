import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.mjs";
import { loadContentMemory, pickExplorationSeeds } from "../engine/content-memory.mjs";

const PERFORMANCE_FILE = path.join(paths.dataDir, "performance_history.json");
const STRATEGY_FILE = path.join(paths.dataDir, "strategy.json");

const TOPIC_ARMS = [
  {
    id: "rocket-audio",
    topic: "rocket launch",
    angle: "Explain why real launch footage feels intense even before anything dramatic happens.",
    titleStyle: "what-is",
    analyticsFamilies: ["travel_time", "general"],
    keywords: ["rocket", "launch", "booster", "artemis"]
  },
  {
    id: "iss-human-scale",
    topic: "ISS spacewalk",
    angle: "Teach the one detail that makes human spaceflight look unreal in real mission footage.",
    titleStyle: "hidden-detail",
    analyticsFamilies: ["general", "planetary_facts"],
    keywords: ["iss", "space station", "spacewalk", "astronaut"]
  },
  {
    id: "mars-surface",
    topic: "Mars rover",
    angle: "Show what real rover footage reveals about the Martian surface.",
    titleStyle: "what-is",
    analyticsFamilies: ["planetary_facts", "scale_comparison"],
    keywords: ["mars", "rover", "perseverance", "curiosity"]
  },
  {
    id: "webb-nebula",
    topic: "Webb telescope nebula",
    angle: "Explain what the viewer is actually seeing in a real deep-space image sequence.",
    titleStyle: "scale-reveal",
    analyticsFamilies: ["scale_comparison", "general"],
    keywords: ["webb", "jwst", "nebula", "telescope"]
  },
  {
    id: "hubble-galaxy",
    topic: "Hubble galaxy",
    angle: "Turn a real space image into one clear idea about distance, light, or scale.",
    titleStyle: "scale-reveal",
    analyticsFamilies: ["scale_comparison", "general", "travel_time"],
    keywords: ["hubble", "galaxy", "milky way", "andromeda"]
  },
  {
    id: "jupiter-moon",
    topic: "Jupiter volcanic moon",
    angle: "Explain why this planetary footage looks so strange compared with Earth.",
    titleStyle: "hidden-detail",
    analyticsFamilies: ["planetary_facts", "extreme_conditions"],
    keywords: ["jupiter", "io", "moon", "volcanic"]
  },
  {
    id: "solar-flare",
    topic: "solar flare",
    angle: "Teach what real solar footage is showing without over-narrating it.",
    titleStyle: "what-is",
    analyticsFamilies: ["extreme_conditions", "general"],
    keywords: ["sun", "solar", "flare", "corona"]
  },
  {
    id: "asteroid-sample",
    topic: "asteroid sample return",
    angle: "Explain the mission idea behind real asteroid footage in one clean takeaway.",
    titleStyle: "mission-why",
    analyticsFamilies: ["general", "planetary_facts"],
    keywords: ["asteroid", "bennu", "sample", "osiris"]
  }
];

const TITLE_STYLES = {
  "what-is": (topic) => `What is this ${topic} footage showing?`,
  "hidden-detail": (topic) => `The detail most people miss in this ${topic} footage`,
  "scale-reveal": (topic) => `This ${topic} footage is bigger than it looks`,
  "mission-why": (topic) => `Why this ${topic} footage matters`
};

function scoreFeedback(feedback) {
  const retention = Number(feedback.averageViewPercentage || feedback.retention || 0);
  const views = Number(feedback.views || 0);
  const comments = Number(feedback.comments || 0);
  const likes = Number(feedback.likes || 0);
  return retention * 0.55 + Math.log10(views + 1) * 8 + comments * 1.8 + likes * 0.35;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function summarizeFeedback(memory) {
  const byArm = new Map();
  for (const item of memory.feedback || []) {
    if (!item.armId) {
      continue;
    }

    const current = byArm.get(item.armId) || { count: 0, total: 0 };
    current.count += 1;
    current.total += scoreFeedback(item);
    byArm.set(item.armId, current);
  }

  return byArm;
}

function videoMatchesArm(video, arm) {
  const family = String(video.topic_family || "").toLowerCase();
  if (arm.analyticsFamilies.includes(family)) {
    return true;
  }

  const text = `${video.title || ""} ${video.description || ""}`.toLowerCase();
  return arm.keywords.some((keyword) => text.includes(keyword));
}

function scoreAnalyticsVideo(video) {
  const metrics = video.metrics || {};
  const retention = Number(metrics.avg_view_duration_seconds || metrics.averageViewDuration || 0);
  const views = Number(metrics.views || 0);
  const score = Number(video.performance_score || 0);
  return 12 + score * 18 + Math.log10(views + 1) * 4 + Math.min(8, retention / 8);
}

function summarizeAnalytics(performanceHistory) {
  const byArm = new Map();
  for (const arm of TOPIC_ARMS) {
    const matches = performanceHistory.filter((video) => videoMatchesArm(video, arm));
    if (!matches.length) {
      continue;
    }

    byArm.set(arm.id, {
      count: matches.length,
      total: matches.reduce((sum, video) => sum + scoreAnalyticsVideo(video), 0)
    });
  }
  return byArm;
}

function combinedFeedback(manualFeedback, analyticsFeedback, armId) {
  const manual = manualFeedback.get(armId) || { count: 0, total: 0 };
  const analytics = analyticsFeedback.get(armId) || { count: 0, total: 0 };
  return {
    count: manual.count + analytics.count,
    total: manual.total + analytics.total
  };
}

function strategyBonus(strategy, arm) {
  const suggested = strategy.suggested_next || [];
  const avoid = strategy.avoid_topics || [];
  const isSuggested = suggested.some((family) => arm.analyticsFamilies.includes(String(family).toLowerCase()));
  const isAvoided = avoid.some((item) => arm.analyticsFamilies.includes(String(item.topic || item).toLowerCase()));
  return (isSuggested ? 2.5 : 0) - (isAvoided ? 4 : 0);
}

function recentArmPenalty(memory, arm) {
  return (memory.runs || [])
    .slice(0, 20)
    .reduce((sum, run) => sum + (run.topicFamily && arm.topic.includes(run.topicFamily) ? 1.2 : 0), 0);
}

export async function chooseNextBrief() {
  const memory = await loadContentMemory();
  const performanceHistory = await readJson(PERFORMANCE_FILE, []);
  const strategy = await readJson(STRATEGY_FILE, {});
  const feedbackByArm = summarizeFeedback(memory);
  const analyticsByArm = summarizeAnalytics(Array.isArray(performanceHistory) ? performanceHistory : []);
  const totalFeedback = [...TOPIC_ARMS].reduce(
    (sum, arm) => sum + combinedFeedback(feedbackByArm, analyticsByArm, arm.id).count,
    0
  );
  const dayBucket = new Date().toISOString().slice(0, 10);
  const explorationSeeds = pickExplorationSeeds(memory, {}, 2);

  const ranked = TOPIC_ARMS.map((arm, index) => {
    const feedback = combinedFeedback(feedbackByArm, analyticsByArm, arm.id);
    const meanReward = feedback.count ? feedback.total / feedback.count : 18;
    const explorationBonus = Math.sqrt(Math.log(totalFeedback + 2) / (feedback.count + 1)) * 6;
    const rotationBonus = explorationSeeds.some((seed) => seed.toLowerCase().includes(arm.topic.split(" ")[0])) ? 4 : 0;
    const dailyJitter = ((index + dayBucket.length) % 7) * 0.13;

    return {
      arm,
      score:
        meanReward +
        explorationBonus +
        rotationBonus +
        strategyBonus(strategy, arm) +
        dailyJitter -
        recentArmPenalty(memory, arm)
    };
  }).sort((left, right) => right.score - left.score);

  const selected = ranked[0].arm;
  return {
    armId: selected.id,
    productionType: "learning_short",
    topic: selected.topic,
    angle: selected.angle,
    hook: TITLE_STYLES[selected.titleStyle](selected.topic),
    shortDurationSeconds: 30,
    documentaryMinutes: 12,
    preferAudioNarrative: true,
    protectLandscape: true
  };
}

export function buildUploadDraft(result, brief) {
  const title = result.plan.script.hookLine.slice(0, 95);
  const sourceClip = result.plan.selectedCandidates[0]?.title || null;
  const sourceId = result.plan.selectedCandidates[0]?.nasaId || null;
  const sourceUrl = sourceId ? `https://images.nasa.gov/details/${sourceId}` : null;
  const description = [
    result.plan.script.whatItIsLine || result.plan.script.setupLine,
    "",
    result.plan.script.factLine,
    "",
    sourceClip ? `Source clip: ${sourceClip}` : "Source clip: NASA public media",
    sourceUrl ? `NASA source page: ${sourceUrl}` : "Source material: NASA public media and science pages.",
    result.leaderKit.disclosure,
    "",
    "#Space #NASA #Science #Astrophysics #Shorts"
  ].join("\n");

  return {
    status: "pending_approval",
    platform: "youtube",
    videoFile: result.outputs.videoFile,
    title,
    description,
    tags: ["space", "nasa", "science", "astrophysics", "shorts"],
    madeFrom: {
      jobId: result.jobId,
      armId: brief.armId,
      topic: brief.topic,
      sourceClip,
      sourceUrl: sourceUrl || result.plan.selectedCandidates[0]?.mp4Url || null
    },
    note:
      "This queue item is safe-by-default. Review it before enabling any YouTube upload script."
  };
}
