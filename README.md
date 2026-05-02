# astro-shorts-engine

Autonomous astrophysics YouTube Shorts generator for one-idea learning Shorts.

## Current Production Loop

The scheduled GitHub Action wakes up hourly, then an adaptive posting policy decides whether to render/upload:

1. Pick a diverse space topic from the content policy.
2. Discover real NASA footage through public NASA media APIs.
3. Render one continuous 9:16 Short with one lower `WHAT IT IS` card and original source audio only.
4. Write a `scripts_output/*.json` handoff that the existing YouTube uploader can read.
5. Upload through the existing `YOUTUBE_TOKEN` and `YOUTUBE_CLIENT_SECRET` secrets.
6. Commit the rendered status, video, and learning data back to the repo.

The adaptive gate guarantees at least one post per local day when the learned posting window opens. It can add extra posts only when recent retention/performance supports it, the current hour is a learned stronger slot, and the spacing floor has passed. Manual workflow runs can bypass the gate, disable upload, or choose `public`, `unlisted`, or `private` privacy.

## Adaptive Posting

The policy reads `data/performance_history.json`, `data/strategy.json`, and uploaded records in `scripts_output`.

It uses:

- `average_view_percentage` when YouTube Analytics provides it.
- `avg_view_duration_seconds`, views, likes, comments, and existing `performance_score`.
- Local day/hour in `America/New_York` so the best posting window can differ by weekday.
- A minimum daily post target, a maximum adaptive cap, and a minimum spacing floor.

Optional workflow environment knobs:

- `ADAPTIVE_MIN_POSTS_PER_DAY`, default `1`.
- `ADAPTIVE_MAX_POSTS_PER_DAY`, default `4`.
- `ADAPTIVE_MIN_GAP_HOURS`, default `4`.
- `ADAPTIVE_TIMEZONE`, default `America/New_York`.
- `FORCE_GENERATE=true` to bypass the gate for manual testing.

## Local Commands

```powershell
npm.cmd install
npm.cmd run auto:draft
npm.cmd run auto:github
```

`auto:draft` creates a safe upload draft under `data/upload-queue` and does not call YouTube.

`auto:github` applies the adaptive posting gate. Use `FORCE_GENERATE=true npm.cmd run auto:github` to force a local render test.

## Legacy Scripts

The older Python idea, formatter, and MoviePy renderer scripts remain in `scripts/` as a fallback/reference path, but the active GitHub generation workflow now calls the Node learning-short renderer. Background music is disabled by default there too; set `ALLOW_BACKGROUND_MUSIC=true` only if you intentionally want the old music behavior. The Python YouTube uploader and analytics agent are still active so the existing secrets and YouTube learning loop do not have to be rebuilt.
