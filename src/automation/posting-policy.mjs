import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../config.mjs";

const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_MIN_POSTS_PER_DAY = 1;
const DEFAULT_MAX_POSTS_PER_DAY = 4;
const DEFAULT_MIN_GAP_HOURS = 4;
const DEFAULT_LATEST_MINIMUM_HOUR = 18;

const FALLBACK_WINDOWS = {
  Mon: [11, 18],
  Tue: [11, 18],
  Wed: [11, 18],
  Thu: [11, 19],
  Fri: [11, 17, 20],
  Sat: [10, 13, 19],
  Sun: [10, 13, 18]
};

function numberEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function normalizeBool(value) {
  return ["1", "true", "yes", "y"].includes(String(value || "").toLowerCase());
}

function readNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function localParts(date = new Date(), timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    hour: Number(parts.hour)
  };
}

function hoursBetween(later, earlier) {
  return Math.max(0, (later.getTime() - earlier.getTime()) / (1000 * 60 * 60));
}

function scorePerformance(item) {
  const metrics = item.metrics || {};
  const views = readNumber(metrics.views);
  const likes = readNumber(metrics.likes);
  const comments = readNumber(metrics.comments);
  const averageViewDuration = readNumber(metrics.avg_view_duration_seconds || metrics.averageViewDuration);
  const averageViewPercentage = readNumber(
    metrics.average_view_percentage ||
      metrics.averageViewPercentage ||
      metrics.averageViewPercentagePercent
  );
  const performanceScore = readNumber(item.performance_score);

  return (
    performanceScore * 26 +
    Math.log10(views + 1) * 5 +
    averageViewDuration * 0.45 +
    averageViewPercentage * 0.18 +
    likes * 0.22 +
    comments * 1.15
  );
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) {
    return 0;
  }

  return sorted[Math.floor(sorted.length / 2)];
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) {
    return 0;
  }

  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

async function readScriptPosts(timezone) {
  const scriptsDir = path.join(paths.rootDir, "scripts_output");

  try {
    const files = await fs.readdir(scriptsDir);
    const posts = [];

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }

      const data = await readJson(path.join(scriptsDir, file), null);
      if (!data || data.status !== "uploaded") {
        continue;
      }

      const timestamp = data.uploaded_at || data.youtube?.uploaded_at || data.rendered_at;
      if (!timestamp) {
        continue;
      }

      const at = new Date(timestamp);
      if (!Number.isFinite(at.getTime())) {
        continue;
      }

      posts.push({
        at,
        source: "script",
        videoId: data.youtube?.video_id || file,
        title: data.youtube?.title || data.idea?.title || data.idea?.topic || file,
        ...localParts(at, timezone)
      });
    }

    return posts;
  } catch {
    return [];
  }
}

function historyPosts(performanceHistory, timezone) {
  return performanceHistory
    .map((item) => {
      const at = new Date(item.published_at || item.analyzed_at || item.uploaded_at || "");
      if (!Number.isFinite(at.getTime())) {
        return null;
      }

      return {
        at,
        source: "analytics",
        videoId: item.video_id || `${item.title}-${item.published_at}`,
        title: item.title,
        reward: scorePerformance(item),
        metrics: item.metrics || {},
        ...localParts(at, timezone)
      };
    })
    .filter(Boolean);
}

function dedupePosts(posts) {
  const seen = new Set();
  return posts
    .sort((left, right) => right.at - left.at)
    .filter((post) => {
      const key = post.videoId || `${post.title}:${post.at.toISOString()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function hourlyStats(posts) {
  const buckets = new Map();

  for (const post of posts) {
    if (!Number.isFinite(post.reward)) {
      continue;
    }

    for (const key of [`${post.weekday}:${post.hour}`, `any:${post.hour}`]) {
      const bucket = buckets.get(key) || { count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += post.reward;
      buckets.set(key, bucket);
    }
  }

  return buckets;
}

function bucketScore(buckets, key) {
  const bucket = buckets.get(key);
  if (!bucket) {
    return null;
  }

  return bucket.total / bucket.count + Math.min(3, Math.log2(bucket.count + 1));
}

function bestHourForDay({ buckets, weekday }) {
  const fallback = FALLBACK_WINDOWS[weekday] || [11, 18];
  const candidates = Array.from(new Set([...fallback, ...Array.from({ length: 24 }, (_item, hour) => hour)]));

  const ranked = candidates
    .map((hour) => ({
      hour,
      score:
        bucketScore(buckets, `${weekday}:${hour}`) ??
        bucketScore(buckets, `any:${hour}`) ??
        (fallback.includes(hour) ? 4 : 0)
    }))
    .sort((left, right) => right.score - left.score);

  return ranked[0] || { hour: fallback[0], score: 0 };
}

function strongHoursForDay({ buckets, weekday }) {
  const fallback = new Set(FALLBACK_WINDOWS[weekday] || [11, 18]);
  const scored = Array.from({ length: 24 }, (_item, hour) => ({
    hour,
    score:
      bucketScore(buckets, `${weekday}:${hour}`) ??
      bucketScore(buckets, `any:${hour}`) ??
      (fallback.has(hour) ? 4 : 0)
  }));
  const threshold = median(scored.map((item) => item.score)) || 4;

  return new Set(scored.filter((item) => item.score >= threshold && item.score > 0).map((item) => item.hour));
}

function momentum(performancePosts) {
  const rewards = performancePosts.map((post) => post.reward).filter(Number.isFinite);
  const recent = rewards.slice(0, 10);
  const baseline = median(rewards.slice(0, 60));
  const recentAverage = average(recent);
  const retentionAverage = average(
    performancePosts
      .slice(0, 10)
      .map((post) => readNumber(post.metrics?.average_view_percentage || post.metrics?.averageViewPercentage))
      .filter((value) => value > 0)
  );

  return {
    baseline,
    recentAverage,
    retentionAverage,
    multiplier: baseline > 0 ? recentAverage / baseline : recentAverage > 0 ? 1 : 0
  };
}

export async function evaluatePostingDecision(options = {}) {
  const timezone = process.env.ADAPTIVE_TIMEZONE || DEFAULT_TIMEZONE;
  const now = options.now || new Date();
  const force = Boolean(options.force) || normalizeBool(process.env.FORCE_GENERATE);
  const minPostsPerDay = numberEnv("ADAPTIVE_MIN_POSTS_PER_DAY", DEFAULT_MIN_POSTS_PER_DAY, 1, 8);
  const maxPostsPerDay = numberEnv("ADAPTIVE_MAX_POSTS_PER_DAY", DEFAULT_MAX_POSTS_PER_DAY, 1, 8);
  const minGapHours = numberEnv("ADAPTIVE_MIN_GAP_HOURS", DEFAULT_MIN_GAP_HOURS, 1, 12);
  const latestMinimumHour = numberEnv("ADAPTIVE_LATEST_MINIMUM_HOUR", DEFAULT_LATEST_MINIMUM_HOUR, 8, 23);
  const performanceHistory = await readJson(path.join(paths.dataDir, "performance_history.json"), []);
  const performancePosts = historyPosts(Array.isArray(performanceHistory) ? performanceHistory : [], timezone);
  const scriptPosts = await readScriptPosts(timezone);
  const posts = dedupePosts([...scriptPosts, ...performancePosts]);
  const nowLocal = localParts(now, timezone);
  const todaysPosts = posts.filter((post) => post.dateKey === nowLocal.dateKey);
  const lastPost = posts[0] || null;
  const buckets = hourlyStats(performancePosts);
  const bestHour = bestHourForDay({ buckets, weekday: nowLocal.weekday });
  const strongHours = strongHoursForDay({ buckets, weekday: nowLocal.weekday });
  const currentHourIsStrong = strongHours.has(nowLocal.hour);
  const recentMomentum = momentum(performancePosts);
  const adaptiveMax =
    recentMomentum.multiplier >= 1.55 || recentMomentum.retentionAverage >= 70
      ? maxPostsPerDay
      : recentMomentum.multiplier >= 1.18 || recentMomentum.retentionAverage >= 55
      ? Math.min(maxPostsPerDay, 2)
      : minPostsPerDay;
  const effectiveMaxPosts = Math.max(minPostsPerDay, adaptiveMax);
  const hoursSinceLastPost = lastPost ? hoursBetween(now, lastPost.at) : Infinity;

  const context = {
    timezone,
    localDate: nowLocal.dateKey,
    localWeekday: nowLocal.weekday,
    localHour: nowLocal.hour,
    postsToday: todaysPosts.length,
    minPostsPerDay,
    maxPostsPerDay: effectiveMaxPosts,
    minGapHours,
    bestHourForToday: bestHour.hour,
    currentHourIsStrong,
    hoursSinceLastPost: Number.isFinite(hoursSinceLastPost) ? Number(hoursSinceLastPost.toFixed(2)) : null,
    momentum: {
      baseline: Number(recentMomentum.baseline.toFixed(2)),
      recentAverage: Number(recentMomentum.recentAverage.toFixed(2)),
      retentionAverage: Number(recentMomentum.retentionAverage.toFixed(2)),
      multiplier: Number(recentMomentum.multiplier.toFixed(2))
    }
  };

  if (force) {
    return {
      shouldPost: true,
      reason: "Manual force enabled, bypassing adaptive timing gate.",
      context
    };
  }

  if (todaysPosts.length < minPostsPerDay) {
    if (nowLocal.hour >= bestHour.hour || nowLocal.hour >= latestMinimumHour) {
      return {
        shouldPost: true,
        reason: "Minimum daily post has not been met and the learned daily posting window is open.",
        context
      };
    }

    return {
      shouldPost: false,
      reason: `Waiting for today's learned posting window near ${bestHour.hour}:00 ${timezone}.`,
      context
    };
  }

  if (todaysPosts.length >= effectiveMaxPosts) {
    return {
      shouldPost: false,
      reason: "Adaptive daily cap reached for current performance level.",
      context
    };
  }

  if (hoursSinceLastPost < minGapHours) {
    return {
      shouldPost: false,
      reason: `Last post is too recent; waiting for the ${minGapHours} hour spacing floor.`,
      context
    };
  }

  if (!currentHourIsStrong) {
    return {
      shouldPost: false,
      reason: "Current hour is not one of the learned stronger posting windows.",
      context
    };
  }

  if (effectiveMaxPosts <= minPostsPerDay) {
    return {
      shouldPost: false,
      reason: "Recent retention/performance does not justify extra posts beyond the daily minimum yet.",
      context
    };
  }

  return {
    shouldPost: true,
    reason: "Performance and timing both support an extra post today.",
    context
  };
}
