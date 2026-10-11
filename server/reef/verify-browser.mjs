// Host-owned verification: the generated app cannot replace this harness.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [playwrightPath, url, scenariosFile, screenshot] = process.argv.slice(2);
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const scenarios = JSON.parse(await fs.readFile(scenariosFile, 'utf8'));
if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 20) throw new Error('Provide 1–20 meaningful browser scenarios');
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of scenarios) {
    if (!Array.isArray(scenario.steps) || scenario.steps.length > 50 || !scenario.steps.some(s => s.action === 'text') || !scenario.steps.some(s => ['fill', 'click', 'select', 'file'].includes(s.action))) throw new Error('Each scenario needs an interaction and a visible result assertion');
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    for (const step of scenario.steps) {
      if (typeof step.selector !== 'string' || step.selector.length > 500) throw new Error('Invalid scenario selector');
      const locator = page.locator(step.selector);
      if (step.action === 'fill') await locator.fill(String(step.value));
      else if (step.action === 'click') await locator.click();
      else if (step.action === 'select') await locator.selectOption(String(step.value));
      else if (step.action === 'file') {
        const fixtures = path.join(path.dirname(scenariosFile), 'test', 'fixtures');
        const fixture = path.resolve(fixtures, String(step.value));
        const relative = path.relative(fixtures, fixture);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Upload fixtures must be inside test/fixtures');
        const realRoot = await fs.realpath(fixtures), realFile = await fs.realpath(fixture);
        if (path.relative(realRoot, realFile).startsWith('..')) throw new Error('Upload fixture escapes the project');
        if ((await fs.stat(realFile)).size > 10 * 1024 * 1024) throw new Error('Upload fixture exceeds 10 MiB');
        await locator.setInputFiles(realFile);
      }
      else if (step.action === 'text') {
        if (typeof step.contains !== 'string' || !step.contains.trim()) throw new Error('An assertion must specify expected text');
        await locator.waitFor({ state: 'visible' });
        await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text), { selector: step.selector, text: step.contains });
      } else throw new Error(`Unsupported scenario action: ${step.action}`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    await page.screenshot({ path: screenshot });
    await page.close();
  }
} finally { await browser.close(); }
