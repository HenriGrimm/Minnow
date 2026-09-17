import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
const [dir, per = '4'] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png') && !f.startsWith('sheet')).sort();
const n = Number(per);
const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
for (let i = 0; i < files.length; i += n) {
  const group = files.slice(i, i + n);
  const html = `<body style="margin:0;background:#444;display:flex;gap:6px;font:14px sans-serif;color:#fff">${group.map((f) => `<div><div>${f}</div><img src="data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}" style="width:390px"></div>`).join('')}</body>`;
  await page.setViewport({ width: n * 396, height: 870 });
  await page.setContent(html);
  await page.screenshot({ path: path.join(dir, `sheet-${String(i / n).padStart(2, '0')}.png`) });
}
await browser.close();
console.log(Math.ceil(files.length / n), 'sheets');
