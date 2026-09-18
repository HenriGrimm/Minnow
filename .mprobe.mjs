import puppeteer from 'puppeteer';
const [hash, script, shot] = process.argv.slice(2);
const W = Number(process.env.W || 390), H = Number(process.env.H || 844);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, isMobile: W < 800, hasTouch: W < 800, deviceScaleFactor: Number(process.env.DPR||1) });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
await page.goto(`http://localhost:9611/#/workspaces`, { waitUntil: "networkidle2", timeout: 90000 }); await new Promise((r) => setTimeout(r, 4000)); await page.evaluate((h) => { location.hash = h; }, hash);
await new Promise((r) => setTimeout(r, 3000));
const steps = script ? script.split('\n@@\n') : [];
for (const s of steps) {
  try { const v = await page.evaluate(`(async()=>{${s}})()`); if (v !== undefined) console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1)); } catch (e) { console.log('ERR', String(e).slice(0, 300)); }
  await new Promise((r) => setTimeout(r, 1200));
}
if (shot) { const clip = process.env.CLIP ? JSON.parse(process.env.CLIP) : undefined; await page.screenshot({ path: shot, clip }); }
await browser.close();
