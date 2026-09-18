import puppeteer from 'puppeteer';
const OUT = process.env.OUT;
const W = Number(process.env.W || 390), H = Number(process.env.H || 844);
const routes = process.argv.slice(2);
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, isMobile: W < 800, hasTouch: W < 800, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 200)));
let first = true;
for (const r of routes) {
  const [name, hash, script] = r.split('|');
  if (!first && process.env.RELOAD) { await page.goto('about:blank'); }
  if (first || process.env.RELOAD) { await page.goto(`http://localhost:9611/#/workspaces`, { waitUntil: 'networkidle2', timeout: 90000 }); await new Promise((res) => setTimeout(res, 2500)); first = false; }
  await page.evaluate((h) => { location.hash = h; }, hash);
  await new Promise((res) => setTimeout(res, 2500));
  if (script) { try { await page.evaluate(script); } catch (e) { console.log('SCRIPTERR', name, String(e).slice(0,200)); } await new Promise((res) => setTimeout(res, 1500)); }
  const info = await page.evaluate(() => {
    const vw = innerWidth;
    const over = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const rc = el.getBoundingClientRect();
      if (rc.width === 0 || rc.height === 0) continue;
      if (rc.right > vw + 1 && rc.left < vw && el.offsetParent !== null) {
        over.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0,2).join('.')}#${el.id} r=${Math.round(rc.right)} w=${Math.round(rc.width)}`);
      }
    }
    return { cls: document.documentElement.className, hash: location.hash, over: over.slice(0, 15) };
  });
  console.log('==', name, JSON.stringify(info));
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
await browser.close();
