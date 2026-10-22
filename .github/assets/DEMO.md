# Browser demo

`npm run demo:render` records five real application states using `scripts/example-session.mjs`: topic selection, question, chosen answer, explanation and source evidence. It uses synthetic committed code and fixed loopback model responses, with external page requests blocked. It does not measure model accuracy.

Requires `npm ci`, the Playwright Chromium install documented in CLAUDE.md and ffmpeg. On a Mac where downloaded Chromium cannot launch, use `DEMO_BROWSER_CHANNEL=chrome npm run demo:render`; this launches a fresh browser profile, not the signed-in user profile.

The existing still screenshots remain in the README. No application behavior changes.
