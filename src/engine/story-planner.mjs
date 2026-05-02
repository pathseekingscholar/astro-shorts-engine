function sentenceCase(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  return text.charAt(0).toUpperCase() + text.slice(1);
}

function chooseVariedCandidates(candidates, targetCount = 3) {
  const selected = [];
  const seenBuckets = new Set();

  for (const candidate of candidates) {
    const bucket = [candidate.center, ...candidate.keywords.slice(0, 2)].join("|");
    if (!seenBuckets.has(bucket)) {
      selected.push(candidate);
      seenBuckets.add(bucket);
    }
    if (selected.length === targetCount) {
      break;
    }
  }

  const fallback = selected.length >= targetCount ? selected : candidates.slice(0, targetCount);

  while (fallback.length < targetCount && fallback.length > 0) {
    fallback.push(fallback[fallback.length - 1]);
  }

  return fallback;
}

function getLearningQuestion(brief) {
  return sentenceCase(
    brief.hook ||
      `Why does ${brief.topic} look so different when you see the real mission footage?`
  );
}

function countWords(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

const CONTENT_DURATION_RULES = [
  {
    id: "launch",
    terms: ["launch", "rocket", "countdown", "liftoff", "booster", "engine", "artemis"],
    ideal: 24,
    max: 34
  },
  {
    id: "human-spaceflight",
    terms: ["astronaut", "crew", "spacewalk", "iss", "station", "microgravity", "cockpit"],
    ideal: 28,
    max: 42
  },
  {
    id: "planetary-surface",
    terms: ["mars", "moon", "lunar", "rover", "crater", "surface", "sample"],
    ideal: 30,
    max: 48
  },
  {
    id: "solar-observatory",
    terms: ["solar", "sun", "flare", "corona", "sdo", "observatory"],
    ideal: 30,
    max: 48
  },
  {
    id: "deep-space",
    terms: ["nebula", "galaxy", "webb", "hubble", "infrared", "deep field", "jupiter", "saturn"],
    ideal: 34,
    max: 54
  },
  {
    id: "mission-overview",
    terms: ["this week", "overview", "documentary", "briefing", "explainer", "mission"],
    ideal: 36,
    max: 60
  }
];

function contentText(brief, candidate) {
  return [
    brief.topic,
    brief.angle,
    candidate?.title,
    candidate?.description,
    ...(candidate?.keywords || [])
  ]
    .join(" ")
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textHasTerm(text, term) {
  const normalizedTerm = String(term || "").toLowerCase();
  if (normalizedTerm.includes(" ")) {
    return text.includes(normalizedTerm);
  }

  return new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`).test(text);
}

function getContentDurationRule(brief, candidate) {
  const text = contentText(brief, candidate);
  const scored = CONTENT_DURATION_RULES.map((rule) => ({
    rule,
    hits: rule.terms.reduce((sum, term) => sum + (textHasTerm(text, term) ? 1 : 0), 0)
  })).sort((left, right) => right.hits - left.hits);

  return scored.find((item) => item.hits > 0)?.rule || {
    id: "general-space",
    terms: [],
    ideal: 28,
    max: 44
  };
}

function resolveLearningDuration(brief, script, candidate) {
  const target = brief.shortDurationSeconds;
  const whatItIsWords = countWords(`${script.setupLine} ${script.factLine}`);
  const rule = getContentDurationRule(brief, candidate);
  const readingFloor = Math.ceil(whatItIsWords / 2.25 + 5);
  const keywordComplexity = Math.min(8, Math.max(0, (candidate?.keywords?.length || 0) - 8) * 0.6);
  const audioBreathingRoom = candidate?.audioPotential >= 0.75 ? 3 : 0;
  const contentDuration = rule.ideal + keywordComplexity + audioBreathingRoom;
  const hintedDuration = target > rule.ideal ? Math.min(target, rule.max) : 0;
  const ideaDuration = Math.max(readingFloor, contentDuration, hintedDuration);

  return Number(Math.min(180, Math.max(12, Math.ceil(ideaDuration))).toFixed(2));
}

export function buildProductionPlan(brief, candidates, factPack, options = {}) {
  const { replannedForAudio = false } = options;
  const selected = candidates.slice(0, 1);
  const avgAudio = selected.reduce((sum, item) => sum + item.audioPotential, 0) / Math.max(selected.length, 1);
  const avgVisual = selected.reduce((sum, item) => sum + item.visualEnergy, 0) / Math.max(selected.length, 1);

  const hookLine = sentenceCase(brief.hook || getLearningQuestion(brief));
  const setupLine = sentenceCase(
    brief.angle ||
      `This short stays grounded in real NASA footage instead of generic space filler.`
  );
  const factLine = factPack.facts[0]?.text || "Real mission visuals usually outperform generic space loops.";
  const ctaLine = "";

  const narrationWordBudget = countWords([hookLine, setupLine, factLine].join(" "));
  const needsAudioReplan = Boolean(
    !replannedForAudio && brief.preferAudioNarrative && (avgAudio < 0.52 || narrationWordBudget > 32)
  );
  const durations = [resolveLearningDuration(brief, { hookLine, setupLine, factLine, ctaLine }, selected[0])];
  const durationRule = getContentDurationRule(brief, selected[0]);

  const beatSheet = [
    {
      name: "Single Clip Lesson",
      duration: durations[0],
      clip: selected[0],
      direction: "Let one interesting source clip continue while a single WHAT IT IS card explains the footage."
    }
  ];

  return {
    format: "learning_short",
    targetDurationSeconds: brief.shortDurationSeconds,
    plannedDurationSeconds: durations.reduce((sum, duration) => Number((sum + duration).toFixed(2)), 0),
    selectedCandidates: selected,
    audioAssessment: {
      averageAudioPotential: Number(avgAudio.toFixed(2)),
      averageVisualEnergy: Number(avgVisual.toFixed(2)),
      narrationWordBudget,
      needsAudioReplan,
      reason: replannedForAudio
        ? "The engine already widened the search around audio-rich footage and rebuilt the cut from those stronger candidates."
        : needsAudioReplan
        ? "The first cut still leans too much on narration, so the engine should widen the search for clips with stronger natural audio cues."
        : "The first cut has enough visual and audio energy to carry a short without over-explaining."
    },
    durationPolicy: {
      mode: "content-aware",
      rule: durationRule.id,
      userLengthInput: brief.shortDurationSeconds,
      selectedSeconds: durations[0],
      reason: `Duration follows the clip type (${durationRule.id}), metadata complexity, and natural audio potential instead of cutting to the exact slider value.`
    },
    beatSheet,
    script: {
      hookLine,
      setupLine,
      factLine,
      ctaLine
    },
    editorNotes: [
      "Use one continuous source clip so the viewer can settle into the footage.",
      "Only render the WHAT IT IS card on the video; do not add captions, CTA boxes, or extra overlays.",
      "Let real mission audio stay audible unless it distracts from the source footage."
    ]
  };
}

export function buildDocumentaryPlan(brief, candidates, factPack) {
  const selected = chooseVariedCandidates(candidates, 8);
  const minutes = brief.documentaryMinutes;
  const chapterCount = Math.max(4, Math.min(10, Math.round(minutes / 6)));
  const chapterMinutes = minutes / chapterCount;

  const chapters = Array.from({ length: chapterCount }, (_item, index) => {
    const candidate = selected[index % selected.length];
    const start = Number((index * chapterMinutes).toFixed(2));
    const end = Number((index === chapterCount - 1 ? minutes : Math.min(minutes, (index + 1) * chapterMinutes)).toFixed(2));
    const fact = factPack.facts[index % factPack.facts.length] || factPack.facts[0];

    return {
      title: [
        "The Image That Hooks Us",
        "What The Footage Is Actually Showing",
        "The Scale Problem",
        "The Human Mission Layer",
        "What Most Viewers Miss",
        "The Bigger Question",
        "Why This Still Matters",
        "Final Takeaway",
        "Open Loop For The Next Episode",
        "Source Notes"
      ][index],
      startMinute: start,
      endMinute: end,
      sourceClip: candidate,
      narrationGoal: `Turn ${candidate?.title || brief.topic} into one clear idea, then support it with a real mission detail.`,
      onScreenText: fact?.text || "Use the source footage to teach one idea at a time.",
      brollNeed: `Find supporting shots for ${candidate?.title || brief.topic}: wide establishing shot, detail insert, and one human or mission-control beat.`
    };
  });

  return {
    format: "documentary",
    selectedCandidates: selected,
    documentary: {
      targetMinutes: minutes,
      estimatedWords: minutes * 135,
      chapters,
      productionNotes: [
        "Documentary mode creates both a script package and a stitched 16:9 video draft.",
        "Use landscape NASA footage in documentary mode where it naturally fits the YouTube long-form frame.",
        "When a chapter depends too much on narration, search for mission audio, interviews, countdowns, or crew communication before writing more voiceover."
      ]
    },
    script: {
      hookLine: sentenceCase(brief.hook || `The real story behind ${brief.topic}.`),
      setupLine: sentenceCase(brief.angle || `A source-backed documentary arc built from real NASA footage.`),
      factLine: factPack.facts[0]?.text || "Real space footage becomes stronger when the science is clear.",
      ctaLine: "Next episode question: what should this story explain next?"
    },
    audioAssessment: {
      averageAudioPotential: Number(
        (selected.reduce((sum, item) => sum + item.audioPotential, 0) / Math.max(selected.length, 1)).toFixed(2)
      ),
      averageVisualEnergy: Number(
        (selected.reduce((sum, item) => sum + item.visualEnergy, 0) / Math.max(selected.length, 1)).toFixed(2)
      ),
      narrationWordBudget: minutes * 135,
      needsAudioReplan: false,
      reason: "Documentary mode builds an edit package first, then flags where natural audio should replace extra narration."
    },
    editorNotes: [
      "Use long-form pacing: one major question per chapter.",
      "Do not crop landscape source footage into vertical unless it becomes a separate Short.",
      "Keep source attributions close to the chapter notes so the final edit can stay trustworthy."
    ]
  };
}
