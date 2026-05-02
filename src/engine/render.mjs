import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import sharp from "sharp";

function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeFileName(value) {
  return String(value || "clip")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function downloadFile(url, targetFile) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "space-challenge-engine/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Download failed for ${url}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetFile, buffer);
}

async function downloadText(url, targetFile) {
  if (!url) {
    return null;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "space-challenge-engine/0.1"
      }
    });

    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    await fs.writeFile(targetFile, text);
    return text;
  } catch {
    return null;
  }
}

async function probeMedia(file) {
  const output = await new Promise((resolve, reject) => {
    const probe = spawn(ffprobe.path, [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      file
    ]);

    let stdout = "";
    let stderr = "";

    probe.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    probe.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    probe.on("error", reject);
    probe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });

  const data = JSON.parse(output);
  const video = (data.streams || []).find((stream) => stream.codec_type === "video") || {};
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;

  return {
    hasAudio: (data.streams || []).some((stream) => stream.codec_type === "audio"),
    width,
    height,
    duration: Number(video.duration || data.format?.duration || 0),
    aspectRatio: width && height ? Number((width / height).toFixed(3)) : null,
    orientation: width && height && height >= width ? "vertical" : "landscape"
  };
}

async function renderSvgPng(svg, outputFile) {
  await sharp(Buffer.from(svg)).png().toFile(outputFile);
}

function parseTimestamp(value) {
  const match = String(value || "").match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) {
    return null;
  }

  const [, hours, minutes, seconds, milliseconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;
}

function cleanCaptionText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]+\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCaptionCues(captionText) {
  return String(captionText || "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n").filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex === -1) {
        return null;
      }

      const [startRaw, endRaw] = lines[timingIndex].split("-->").map((part) => part.trim());
      const start = parseTimestamp(startRaw);
      const end = parseTimestamp(endRaw);
      const text = cleanCaptionText(lines.slice(timingIndex + 1).join(" "));

      if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
        return null;
      }

      return { start, end, text };
    })
    .filter(Boolean);
}

function endsSentence(value) {
  return /[.!?]["')\]]?$/.test(String(value || "").trim());
}

function chooseSentenceCompleteDuration(cues, targetDuration, sourceDuration) {
  if (!cues.length) {
    return null;
  }

  const sourceCap = sourceDuration > 0 ? Math.max(12, sourceDuration - 0.5) : 90;
  const maxDuration = Math.min(sourceCap, Math.max(45, Math.min(95, targetDuration + 32)));
  let buffer = "";

  for (const cue of cues) {
    if (cue.start > maxDuration) {
      break;
    }

    buffer = `${buffer} ${cue.text}`.trim();
    const completesSentence = endsSentence(buffer) || endsSentence(cue.text);

    if (completesSentence) {
      const boundary = Number(Math.min(sourceCap, cue.end + 0.65).toFixed(2));
      if (boundary >= targetDuration) {
        return boundary;
      }
      buffer = "";
    }
  }

  return Number(Math.min(sourceCap, maxDuration).toFixed(2));
}

async function completeDurationFromCaptions({ candidate, jobDir, baseDuration, sourceDuration, index }) {
  const captionFile = path.join(jobDir, `${String(index + 1).padStart(2, "0")}-source-captions.srt`);
  const captionText = await downloadText(candidate.captionsUrl, captionFile);
  const cues = parseCaptionCues(captionText);
  const captionDuration = chooseSentenceCompleteDuration(cues, baseDuration, sourceDuration);

  if (!captionDuration || captionDuration <= baseDuration + 0.2) {
    return null;
  }

  return {
    duration: captionDuration,
    cueCount: cues.length,
    reason: `Extended from ${baseDuration}s to ${captionDuration}s so source audio reaches a transcript sentence boundary.`
  };
}

async function refineDurationsForCompletion({ plan, selected, clipDetails, jobDir, logger }) {
  const refinements = [];

  for (let index = 0; index < plan.beatSheet.length; index += 1) {
    const beat = plan.beatSheet[index];
    const candidate = selected[index];
    const clip = clipDetails[index];
    const baseDuration = beat.duration;
    const sourceCap = clip.duration > 0 ? Math.max(12, clip.duration - 0.5) : 180;
    let finalDuration = Math.min(baseDuration, sourceCap);
    let reason = "Kept content-aware duration; no transcript boundary extension was available.";

    const captionRefinement = await completeDurationFromCaptions({
      candidate,
      jobDir,
      baseDuration: finalDuration,
      sourceDuration: clip.duration,
      index
    });

    if (captionRefinement) {
      finalDuration = Math.min(captionRefinement.duration, sourceCap);
      reason = captionRefinement.reason;
    }

    beat.duration = Number(finalDuration.toFixed(2));
    refinements.push({
      clip: candidate.title,
      sourceDuration: clip.duration,
      plannedBeforeCompletion: baseDuration,
      finalDuration: beat.duration,
      reason
    });
  }

  const plannedDurationSeconds = plan.beatSheet.reduce((sum, beat) => Number((sum + beat.duration).toFixed(2)), 0);
  plan.plannedDurationSeconds = plannedDurationSeconds;
  plan.durationPolicy = {
    ...(plan.durationPolicy || {}),
    completionMode: "transcript-boundary",
    selectedSeconds: plannedDurationSeconds,
    refinements
  };

  logger(`Timing refined for idea completion: ${plannedDurationSeconds}s.`);
}

function getCardHeight({ lineCount, fontSize, lineHeight, padY = 24, label = true }) {
  const labelHeight = label ? 28 : 0;
  const gap = label ? 18 : 0;
  return padY * 2 + labelHeight + gap + lineCount * lineHeight;
}

function renderOverlayCard({ x, y, width, label, lines, fontSize, lineHeight, fill, stroke, textFill, labelFill }) {
  const padX = 26;
  const padY = 24;
  const height = getCardHeight({ lineCount: lines.length, fontSize, lineHeight, padY, label: Boolean(label) });
  const textStartY = y + padY + (label ? 28 + 18 : 0) + fontSize;

  return `
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="22" fill="${fill}" stroke="${stroke}" stroke-width="3" />
    ${
      label
        ? `<text x="${x + padX}" y="${y + padY + 22}" fill="${labelFill}" font-size="18" font-family="Arial, Segoe UI, sans-serif" font-weight="800">${escapeXml(label)}</text>`
        : ""
    }
    ${lines
      .map(
        (line, index) =>
          `<text x="${x + padX}" y="${textStartY + index * lineHeight}" fill="${textFill}" font-size="${fontSize}" font-family="Arial, Segoe UI, sans-serif" font-weight="800">${escapeXml(line)}</text>`
      )
      .join("")}
  `;
}

async function createLearningOverlayAssets(jobDir, plan) {
  const overlayFile = path.join(jobDir, "learning-overlay.png");
  const descriptionText = `${plan.script.setupLine} ${plan.script.factLine}`;
  let fontSize = 28;
  let lineHeight = 35;
  let descriptionLines = wrapText(descriptionText, 32);

  if (descriptionLines.length > 9) {
    fontSize = 24;
    lineHeight = 31;
    descriptionLines = wrapText(descriptionText, 38);
  }

  if (descriptionLines.length > 11) {
    fontSize = 21;
    lineHeight = 28;
    descriptionLines = wrapText(descriptionText, 44);
  }

  const descriptionHeight = getCardHeight({ lineCount: descriptionLines.length, fontSize, lineHeight });
  const descriptionY = Math.max(720, 1280 - descriptionHeight - 96);

  const svg = `
    <svg width="720" height="1280" viewBox="0 0 720 1280" xmlns="http://www.w3.org/2000/svg">
      ${renderOverlayCard({
        x: 34,
        y: descriptionY,
        width: 652,
        label: "WHAT IT IS",
        lines: descriptionLines,
        fontSize,
        lineHeight,
        fill: "#FFF9E8",
        stroke: "#FFF9E8",
        textFill: "#111827",
        labelFill: "#16796F"
      })}
    </svg>
  `;

  await renderSvgPng(svg, overlayFile);
  return { lessonFile: overlayFile };
}

async function createOverlayAssets(jobDir, plan) {
  return createLearningOverlayAssets(jobDir, plan);
}

async function createDocumentaryOverlayAssets(jobDir, plan) {
  const overlayFiles = [];

  for (let index = 0; index < plan.documentary.chapters.length; index += 1) {
    const chapter = plan.documentary.chapters[index];
    const titleLines = wrapText(chapter.title, 32).slice(0, 2);
    const textLines = wrapText(chapter.onScreenText, 54).slice(0, 2);
    const overlayFile = path.join(jobDir, `documentary-chapter-${String(index + 1).padStart(2, "0")}.png`);

    const svg = `
      <svg width="1280" height="210" viewBox="0 0 1280 210" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="1280" height="210" fill="#071018" fill-opacity="0.78" />
        <rect x="42" y="34" width="96" height="32" rx="5" fill="#D9891B" />
        <text x="62" y="57" fill="#FFFFFF" font-size="18" font-family="Arial, Segoe UI, sans-serif" font-weight="800">PART ${index + 1}</text>
        ${titleLines
          .map(
            (line, lineIndex) =>
              `<text x="160" y="${58 + lineIndex * 40}" fill="#FFFFFF" font-size="34" font-family="Arial, Segoe UI, sans-serif" font-weight="800">${escapeXml(line)}</text>`
          )
          .join("")}
        ${textLines
          .map(
            (line, lineIndex) =>
              `<text x="160" y="${140 + lineIndex * 30}" fill="#D7DEDB" font-size="24" font-family="Arial, Segoe UI, sans-serif">${escapeXml(line)}</text>`
          )
          .join("")}
      </svg>
    `;

    await renderSvgPng(svg, overlayFile);
    overlayFiles.push(overlayFile);
  }

  return overlayFiles;
}

function videoChainForClip(clip, index, duration) {
  const fadeOutStart = Math.max(0, duration - 0.16).toFixed(2);

  if (clip.orientation === "vertical") {
    return `[${index}:v]trim=duration=${duration},setpts=PTS-STARTPTS,scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=60,fade=t=in:st=0:d=0.08,fade=t=out:st=${fadeOutStart}:d=0.16[v${index}]`;
  }

  return [
    `[${index}:v]trim=duration=${duration},setpts=PTS-STARTPTS,split=2[src${index}a][src${index}b]`,
    `[src${index}a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=28,eq=brightness=-0.12:saturation=0.72[bg${index}]`,
    `[src${index}b]scale=720:1280:force_original_aspect_ratio=decrease,setsar=1[fg${index}]`,
    `[bg${index}][fg${index}]overlay=(W-w)/2:(H-h)/2,fps=60,fade=t=in:st=0:d=0.08,fade=t=out:st=${fadeOutStart}:d=0.16[v${index}]`
  ].join(";");
}

function videoChainForDocumentaryClip(clip, index, duration) {
  const fadeOutStart = Math.max(0, duration - 0.28).toFixed(2);

  if (clip.orientation === "vertical") {
    return [
      `[${index}:v]trim=duration=${duration},setpts=PTS-STARTPTS,split=2[docsrc${index}a][docsrc${index}b]`,
      `[docsrc${index}a]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=24,eq=brightness=-0.14:saturation=0.72[docbg${index}]`,
      `[docsrc${index}b]scale=1280:720:force_original_aspect_ratio=decrease,setsar=1[docfg${index}]`,
      `[docbg${index}][docfg${index}]overlay=(W-w)/2:(H-h)/2,fps=30,fade=t=in:st=0:d=0.16,fade=t=out:st=${fadeOutStart}:d=0.28[docvbase${index}]`
    ].join(";");
  }

  return `[${index}:v]trim=duration=${duration},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=30,fade=t=in:st=0:d=0.16,fade=t=out:st=${fadeOutStart}:d=0.28[docvbase${index}]`;
}

function audioChainForClip(clip, index, duration) {
  const fadeOutStart = Math.max(0, duration - 0.22).toFixed(2);

  if (clip.hasAudio) {
    return `[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${index === 2 ? 1.08 : 1},afade=t=in:st=0:d=0.12,afade=t=out:st=${fadeOutStart}:d=0.22[a${index}]`;
  }

  return `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration}[a${index}]`;
}

function audioChainForDocumentaryClip(clip, index, duration) {
  const fadeOutStart = Math.max(0, duration - 0.35).toFixed(2);

  if (clip.hasAudio) {
    return `[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=0.92,afade=t=in:st=0:d=0.18,afade=t=out:st=${fadeOutStart}:d=0.35[doca${index}]`;
  }

  return `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration}[doca${index}]`;
}

function buildFilterGraph(clips, durations, overlays) {
  const videoChains = [];
  const audioChains = [];
  const concatInputs = [];

  clips.forEach((clip, index) => {
    videoChains.push(videoChainForClip(clip, index, durations[index]));
    audioChains.push(audioChainForClip(clip, index, durations[index]));
    concatInputs.push(`[v${index}][a${index}]`);
  });

  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  const lessonInput = clips.length;

  return [
    ...videoChains,
    ...audioChains,
    `${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[basev][basea]`,
    `[basev][${lessonInput}:v]overlay=x=0:y=0:shortest=1:enable='between(t,0,${totalDuration})'[vlesson]`,
    "[vlesson]setsar=1[vout]"
  ].join(";");
}

function buildDocumentaryFilterGraph(clips, durations) {
  const videoChains = [];
  const audioChains = [];
  const overlayChains = [];
  const concatInputs = [];
  const overlayOffset = clips.length;

  clips.forEach((clip, index) => {
    videoChains.push(videoChainForDocumentaryClip(clip, index, durations[index]));
    audioChains.push(audioChainForDocumentaryClip(clip, index, durations[index]));
    overlayChains.push(`[${overlayOffset + index}:v]trim=duration=${durations[index]},setpts=PTS-STARTPTS[docov${index}]`);
    overlayChains.push(
      `[docvbase${index}][docov${index}]overlay=x=0:y=510:shortest=1:enable='between(t,0,16)'[docv${index}]`
    );
    concatInputs.push(`[docv${index}][doca${index}]`);
  });

  return [
    ...videoChains,
    ...audioChains,
    ...overlayChains,
    `${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[docvraw][doca]`,
    "[docvraw]setsar=1[vout]"
  ].join(";");
}

async function runFfmpeg(args, onLog) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onLog(text.trim());
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

export async function renderVideo({ jobId, jobDir, outputDir, plan, logger = () => {} }) {
  const selected = plan.selectedCandidates;
  const clipFiles = [];

  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    const clipFile = path.join(jobDir, `${String(index + 1).padStart(2, "0")}-${safeFileName(candidate.nasaId)}.mp4`);
    logger(`Downloading clip ${index + 1}/${selected.length}: ${candidate.title}`);
    await downloadFile(candidate.mp4Url, clipFile);
    clipFiles.push(clipFile);
  }

  const clipDetails = [];
  for (const clipFile of clipFiles) {
    clipDetails.push(await probeMedia(clipFile));
  }

  await refineDurationsForCompletion({ plan, selected, clipDetails, jobDir, logger });

  const overlays = await createOverlayAssets(jobDir, plan);
  const durations = plan.beatSheet.map((beat) => beat.duration);
  const outputFile = path.join(outputDir, `${jobId}.mp4`);
  const clips = clipFiles.map((file, index) => ({ file, ...clipDetails[index] }));
  const filterGraph = buildFilterGraph(clips, durations, overlays);
  const overlayInputs = ["-loop", "1", "-i", overlays.lessonFile];

  const args = [
    "-y",
    ...clipFiles.flatMap((file) => ["-i", file]),
    ...overlayInputs,
    "-filter_complex",
    filterGraph,
    "-map",
    "[vout]",
    "-map",
    "[basea]",
    "-t",
    String(durations.reduce((sum, value) => sum + value, 0)),
    "-r",
    "60",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outputFile
  ];

  logger("Rendering final vertical short with local ffmpeg.");
  await runFfmpeg(args, (line) => {
    if (line.includes("frame=") || line.includes("time=")) {
      logger(line);
    }
  });

  return {
    outputFile,
    qualityChecks: clips.map((clip, index) => ({
      title: selected[index].title,
      width: clip.width,
      height: clip.height,
      orientation: clip.orientation,
      aspectRatio: clip.aspectRatio,
      hasAudio: clip.hasAudio,
      verticalTreatment:
        clip.orientation === "vertical"
          ? "native vertical crop"
          : "blurred 9:16 canvas with original frame centered",
      audioTreatment: clip.hasAudio ? "short fade-in and fade-out applied" : "silent bed generated"
    }))
  };
}

export async function renderDocumentaryVideo({ jobId, jobDir, outputDir, plan, logger = () => {} }) {
  const chapters = plan.documentary.chapters;
  const fileById = new Map();

  for (const chapter of chapters) {
    const candidate = chapter.sourceClip || plan.selectedCandidates[0];
    if (!candidate || fileById.has(candidate.nasaId)) {
      continue;
    }

    const clipFile = path.join(jobDir, `doc-${String(fileById.size + 1).padStart(2, "0")}-${safeFileName(candidate.nasaId)}.mp4`);
    logger(`Downloading documentary source: ${candidate.title}`);
    await downloadFile(candidate.mp4Url, clipFile);
    fileById.set(candidate.nasaId, clipFile);
  }

  const clipFiles = chapters.map((chapter) => fileById.get((chapter.sourceClip || plan.selectedCandidates[0]).nasaId));
  const clipDetails = [];

  for (const clipFile of clipFiles) {
    clipDetails.push(await probeMedia(clipFile));
  }

  const overlays = await createDocumentaryOverlayAssets(jobDir, plan);
  const durations = chapters.map((chapter) => Math.max(6, Number(((chapter.endMinute - chapter.startMinute) * 60).toFixed(2))));
  const clips = clipFiles.map((file, index) => ({ file, ...clipDetails[index] }));
  const outputFile = path.join(outputDir, `${jobId}-documentary.mp4`);
  const filterGraph = buildDocumentaryFilterGraph(clips, durations);
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);

  const args = [
    "-y",
    ...clipFiles.flatMap((file) => ["-stream_loop", "-1", "-i", file]),
    ...overlays.flatMap((file) => ["-loop", "1", "-i", file]),
    "-filter_complex",
    filterGraph,
    "-map",
    "[vout]",
    "-map",
    "[doca]",
    "-t",
    String(totalDuration),
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    outputFile
  ];

  logger(`Rendering documentary video draft (${Math.round(totalDuration / 60)} min) with local ffmpeg.`);
  await runFfmpeg(args, (line) => {
    if (line.includes("frame=") || line.includes("time=")) {
      logger(line);
    }
  });

  return {
    outputFile,
    qualityChecks: clips.map((clip, index) => ({
      title: chapters[index].sourceClip?.title || plan.selectedCandidates[0]?.title,
      width: clip.width,
      height: clip.height,
      orientation: clip.orientation,
      aspectRatio: clip.aspectRatio,
      hasAudio: clip.hasAudio,
      verticalTreatment:
        clip.orientation === "vertical"
          ? "blurred 16:9 documentary canvas with original frame centered"
          : "native 16:9 documentary crop",
      audioTreatment: clip.hasAudio ? "loop-safe chapter audio with short fades" : "silent bed generated"
    }))
  };
}
