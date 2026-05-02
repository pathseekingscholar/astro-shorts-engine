import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(srcDir, "..");

export const paths = {
  rootDir,
  srcDir,
  publicDir: path.join(rootDir, "public"),
  dataDir: path.join(rootDir, "data"),
  jobsDir: path.join(rootDir, "data", "jobs"),
  outputDir: path.join(rootDir, "videos_output"),
};

export const defaults = {
  width: 720,
  height: 1280,
  fps: 60,
  durationSeconds: 18,
  maxCandidates: 16,
  fontFamily: "Arial, Segoe UI, sans-serif",
};
