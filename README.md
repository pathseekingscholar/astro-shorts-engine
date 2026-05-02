# astro-shorts-engine

Autonomous astrophysics YouTube Shorts generator for one-idea learning Shorts.

## Current Production Loop

The scheduled GitHub Action runs once per day and now uses the learning-short engine:

1. Pick a diverse space topic from the content policy.
2. Discover real NASA footage through public NASA media APIs.
3. Render one continuous 9:16 Short with one lower `WHAT IT IS` card.
4. Write a `scripts_output/*.json` handoff that the existing YouTube uploader can read.
5. Upload through the existing `YOUTUBE_TOKEN` and `YOUTUBE_CLIENT_SECRET` secrets.
6. Commit the rendered status, video, and learning data back to the repo.

Manual workflow runs can disable upload or choose `public`, `unlisted`, or `private` privacy. Scheduled runs keep the existing public-upload behavior unless the workflow is changed.

## Local Commands

```powershell
npm.cmd install
npm.cmd run auto:draft
npm.cmd run auto:github
```

`auto:draft` creates a safe upload draft under `data/upload-queue` and does not call YouTube.

`auto:github` renders a Short into `videos_output` and writes a rendered `scripts_output` record for the Python uploader.

## Legacy Scripts

The older Python idea, formatter, and MoviePy renderer scripts remain in `scripts/` as a fallback/reference path, but the active GitHub generation workflow now calls the Node learning-short renderer. The Python YouTube uploader and analytics agent are still active so the existing secrets and YouTube learning loop do not have to be rebuilt.
