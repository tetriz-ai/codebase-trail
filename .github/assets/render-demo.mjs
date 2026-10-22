// Copyright 2026 Workloom Solutions Private Limited
// SPDX-License-Identifier: MIT
// Capture the real learning UI with committed synthetic source and a fixed local model.
import '../../scripts/test-safety.mjs';
import { withExampleSession } from '../../scripts/example-session.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= process.platform === 'win32' ? join(tmpdir(), 'codebase-trail-playwright') : '/tmp/codebase-trail-playwright';
const { chromium, expect } = await import('@playwright/test');
const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'codebase-trail-demo-'));
const browser = await chromium.launch({ ...(process.env.DEMO_BROWSER_CHANNEL ? { channel: process.env.DEMO_BROWSER_CHANNEL } : {}) });
try {
  await withExampleSession(async (_call, { base }) => {
    const page = await browser.newPage({ viewport: { width: 1160, height: 920 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    // Keep the app unchanged and block every non-loopback resource.
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(base);
    await page.locator('#scope').selectOption('lld');
    await expect(page.locator('#generate')).toBeEnabled({ timeout: 30_000 });
    const frames = [];
    async function capture(label, focus) {
      await focus.scrollIntoViewIfNeeded();
      const file = join(temporary, `frame-${frames.length}.png`);
      if (frames.length === 0) {
        const bar = await focus.boundingBox();
        await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1160, height: Math.ceil(bar.y + bar.height + 12) } });
      } else {
        await page.screenshot({ path: file });
      }
      frames.push({ file, label });
    }
    await capture('Choose what to learn', page.locator('.bar'));
    await page.locator('#generate').click();
    await expect(page.locator('#item h2')).toHaveText('Which component can be affected by a change to the worker?', { timeout: 60_000 });
    await capture('Answer before revealing the explanation', page.locator('#item'));
    await page.locator('.option[data-option="A"]').click();
    await capture('Make your prediction', page.locator('#submit'));
    await page.locator('#submit').click();
    await expect(page.locator('#reveal')).toContainText('The API imports the worker.');
    await capture('Build the mental model', page.locator('#reveal'));
    await page.locator('.evidence-disclosure summary').click();
    await expect(page.locator('.evidence-disclosure')).toContainText('src/api.js');
    await capture('Check the source evidence', page.locator('.evidence-disclosure'));
    // Hold each real application state long enough to read at README width.
    const list = frames.map(frame => `file '${frame.file}'\nduration 3.5`).join('\n');
    await writeFile(join(temporary, 'frames.txt'), `${list}\nfile '${frames.at(-1).file}'\n`);
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', join(temporary, 'frames.txt'), '-vf', 'fps=5,scale=1000:793:force_original_aspect_ratio=decrease:flags=lanczos,pad=1000:793:(ow-iw)/2:(oh-ih)/2:color=0xf5f3ee,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0', join(root, '.github/assets/demo.gif')], { timeout: 60_000 });
    console.log('Captured 5 real UI states: topic, question, choice, explanation, source evidence. Synthetic checkout; fixed loopback model.');
  });
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
