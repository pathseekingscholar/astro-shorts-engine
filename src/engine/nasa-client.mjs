const API_ROOT = "https://images-api.nasa.gov";

const VISUAL_TERMS = [
  "launch",
  "nebula",
  "galaxy",
  "spacewalk",
  "astronaut",
  "timelapse",
  "jupiter",
  "saturn",
  "mars",
  "moon",
  "webb",
  "hubble",
  "iss",
  "sun",
  "solar",
  "flare",
  "corona"
];

const AUDIO_TERMS = [
  "launch",
  "countdown",
  "mission control",
  "crew",
  "cockpit",
  "communication",
  "radio",
  "briefing",
  "spacewalk"
];

function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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

function keywordHits(text, terms) {
  return terms.reduce((count, term) => count + (textHasTerm(text, term) ? 1 : 0), 0);
}

function extractSearchTerms(value) {
  const stopWords = new Set([
    "about",
    "actually",
    "because",
    "explain",
    "footage",
    "showing",
    "teach",
    "viewer",
    "viewers",
    "without"
  ]);

  return unique(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 4 && !stopWords.has(token))
  ).slice(0, 4);
}

function topicAudioQueries(topic) {
  const normalizedTopic = normalizeText(topic);
  if (/rocket|launch|artemis|booster|spacewalk|iss|astronaut|crew/.test(normalizedTopic)) {
    return [
      `${topic} launch mission control`,
      `${topic} crew communication`
    ];
  }

  if (/solar|sun|flare|corona/.test(normalizedTopic)) {
    return [
      `${topic} solar dynamics observatory`,
      `${topic} sun observatory narrated`,
      `${topic} NASA visualization`
    ];
  }

  if (/mars|rover|moon|lunar|asteroid|sample/.test(normalizedTopic)) {
    return [
      `${topic} mission narrated`,
      `${topic} NASA mission overview`
    ];
  }

  return [
    `${topic} narrated NASA`,
    `${topic} mission overview`
  ];
}

function topicRelevanceTerms(brief) {
  const topic = normalizeText(brief.topic);
  const terms = [
    ...extractSearchTerms(brief.topic),
    ...extractSearchTerms(brief.angle)
  ];

  const synonymGroups = [
    {
      test: /solar|sun|flare|corona/,
      terms: ["solar flare", "flare", "sun", "corona", "solar dynamics observatory", "sdo", "soho", "stereo"]
    },
    {
      test: /rocket|launch|booster|artemis/,
      terms: ["rocket", "launch", "liftoff", "booster", "artemis", "engine"]
    },
    {
      test: /iss|spacewalk|astronaut|space station/,
      terms: ["iss", "space station", "spacewalk", "astronaut", "crew"]
    },
    {
      test: /mars|rover/,
      terms: ["mars", "rover", "perseverance", "curiosity", "jezero"]
    },
    {
      test: /webb|jwst|nebula/,
      terms: ["webb", "jwst", "nebula", "infrared"]
    },
    {
      test: /hubble|galaxy/,
      terms: ["hubble", "galaxy", "milky way", "andromeda", "deep field"]
    },
    {
      test: /jupiter|volcanic|io/,
      terms: ["jupiter", "io", "volcanic", "moon", "juno"]
    },
    {
      test: /asteroid|sample|bennu|osiris/,
      terms: ["asteroid", "sample", "bennu", "osiris-rex", "osiris"]
    }
  ];

  for (const group of synonymGroups) {
    if (group.test.test(topic)) {
      terms.push(...group.terms);
    }
  }

  return unique(terms).filter((term) => term.length > 2);
}

function topicRelevanceScore(candidate, brief) {
  const text = normalizeText(`${candidate.title} ${candidate.description} ${(candidate.keywords || []).join(" ")}`);
  const terms = topicRelevanceTerms(brief);
  const score = terms.reduce((sum, term) => {
    if (!textHasTerm(text, term)) {
      return sum;
    }

    return sum + (term.includes(" ") ? 1.5 : 1);
  }, 0);

  return Number(score.toFixed(2));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "space-challenge-engine/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`NASA request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function toHttps(url) {
  return String(url || "").replace(/^http:\/\//i, "https://");
}

function buildSearchQueries(brief, options = {}) {
  const topic = String(brief.topic || "space").trim() || "space";
  const angleTerms = extractSearchTerms(brief.angle);
  const queries = [
    topic,
    `${topic} nasa`,
    `${topic} video`,
    `${topic} real footage`,
    angleTerms.length ? `${topic} ${angleTerms.join(" ")}` : ""
  ];

  if (options.audioBias) {
    queries.push(...topicAudioQueries(topic));
  }

  if (options.verticalBias) {
    queries.push(`${brief.topic} shorts vertical`);
    queries.push(`${brief.topic} portrait video`);
    queries.push(`${brief.topic} social media`);
  }

  if (options.learningBias) {
    queries.push(`${brief.topic} explainer`);
    queries.push(`${brief.topic} mission overview`);
  }

  for (const seed of options.explorationSeeds || []) {
    queries.push(`${seed} NASA footage`);
    queries.push(`${seed} real space video`);
  }

  if (options.documentaryBias) {
    queries.push(`${brief.topic} documentary`);
    queries.push(`${brief.topic} interview`);
    queries.push(`${brief.topic} mission control`);
  }

  return unique(queries).slice(0, 9);
}

async function searchQuery(query) {
  const url = new URL(`${API_ROOT}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("media_type", "video");
  url.searchParams.set("page_size", "16");
  return fetchJson(url.toString());
}

function pickMp4Url(assetManifest) {
  const items = assetManifest?.collection?.items || [];
  const mp4s = items
    .map((item) => item.href)
    .filter((href) => href && href.toLowerCase().endsWith(".mp4"));

  const preferred =
    mp4s.find((href) => /~large/i.test(href)) ||
    mp4s.find((href) => /720|1080/i.test(href)) ||
    mp4s.find((href) => /~orig/i.test(href));

  return toHttps(preferred || mp4s[0] || null);
}

async function getCaptionsUrl(nasaId) {
  try {
  const data = await fetchJson(`${API_ROOT}/captions/${encodeURIComponent(nasaId)}`);
    return toHttps(data.location || null);
  } catch {
    return null;
  }
}

async function hydrateItem(rawItem) {
  const data = rawItem?.data?.[0] || {};
  const assetManifest = await fetchJson(`${API_ROOT}/asset/${encodeURIComponent(data.nasa_id)}`);
  const preview = toHttps(
    rawItem?.links?.find((link) => link.render === "image" || link.render === "video")?.href || null
  );
  const text = normalizeText(`${data.title} ${data.description} ${(data.keywords || []).join(" ")}`);
  const visualEnergy = clamp(keywordHits(text, VISUAL_TERMS) / 4, 0.15, 1);
  const audioPotential = clamp(keywordHits(text, AUDIO_TERMS) / 3, 0.1, 1);
  const mp4Url = pickMp4Url(assetManifest);

  if (!mp4Url) {
    return null;
  }

  return {
    nasaId: data.nasa_id,
    title: data.title || "Untitled NASA clip",
    description: data.description || "",
    keywords: data.keywords || [],
    previewUrl: preview,
    createdAt: data.date_created || null,
    center: data.center || "",
    mp4Url,
    captionsUrl: await getCaptionsUrl(data.nasa_id),
    visualEnergy,
    audioPotential
  };
}

function scoreCandidate(candidate, brief, audioBias = false) {
  const text = normalizeText(`${candidate.title} ${candidate.description} ${(candidate.keywords || []).join(" ")}`);
  const topicHits = topicRelevanceScore(candidate, brief);

  const base =
    topicHits * 1.8 +
    candidate.visualEnergy * 3.2 +
    candidate.audioPotential * (audioBias ? 4 : 2.4) +
    (candidate.captionsUrl ? 0.75 : 0) +
    (/short|vertical|portrait|reel/i.test(`${candidate.title} ${candidate.description}`) ? 1.1 : 0) +
    (/webb|hubble|artemis|apollo|iss|launch|mars/i.test(candidate.title) ? 0.8 : 0);

  return Number(base.toFixed(3));
}

export async function discoverCandidates(brief, options = {}, logger = () => {}) {
  const queries = buildSearchQueries(brief, options);
  logger(`Researching search angles: ${queries.join(" | ")}`);

  const rawItems = [];
  for (const query of queries) {
    const data = await searchQuery(query);
    rawItems.push(...(data?.collection?.items || []));
  }

  const deduped = unique(rawItems.map((item) => item?.data?.[0]?.nasa_id))
    .map((nasaId) => rawItems.find((item) => item?.data?.[0]?.nasa_id === nasaId))
    .filter(Boolean)
    .slice(0, options.maxHydrated || 28);

  logger(`Pulled ${deduped.length} candidate NASA video records.`);

  const hydrated = [];
  for (const item of deduped) {
    try {
      const candidate = await hydrateItem(item);
      if (candidate) {
        hydrated.push(candidate);
      }
    } catch (error) {
      logger(`Skipped one NASA asset during hydration: ${error.message}`);
    }
  }

  const ranked = hydrated
    .map((candidate) => ({
      ...candidate,
      topicRelevance: topicRelevanceScore(candidate, brief),
      score: scoreCandidate(candidate, brief, options.audioBias)
    }))
    .sort((left, right) => right.score - left.score);

  const relevant = ranked.filter((candidate) => candidate.topicRelevance >= 1.5);
  return (relevant.length ? relevant : ranked).slice(0, 12);
}
