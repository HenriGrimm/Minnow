import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Opt in: exercises actual npm installs, Chromium and Git against a scratch home.
test('calculator, CSV converter and image resizer build, verify and survive restart', { skip: process.env.MINNOW_REEF_E2E !== '1', timeout: 1200000 }, async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reef-pipeline-')));
  process.env.MINNOW_HOME = home;
  const { createApp, appRoot, updateApp, readApp } = await import('../../server/reef/store.js');
  const { buildApp } = await import('../../server/reef/pipeline.js');
  const { launchApp, stopApp } = await import('../../server/reef/runtime.js');
  const { ensureToolchain } = await import('../../server/reef/toolchain.js');
  const { queueExport } = await import('../../server/reef/exports.js');
  const { command } = await import('../../server/reef/process.js');
  const controller = new AbortController();
  const fixtures = [
    {
      name: 'Calculator',
      source: `document.querySelector('#app')!.innerHTML = '<h1>Calculator</h1><label>First<input id="a" type="number"></label><label>Second<input id="b" type="number"></label><button id="sum">Add</button><output id="result"></output>'; document.querySelector('#sum')!.addEventListener('click',()=>{document.querySelector('#result')!.textContent=String(Number((document.querySelector('#a') as HTMLInputElement).value)+Number((document.querySelector('#b') as HTMLInputElement).value));});`,
      scenario: [{ action: 'fill', selector: '#a', value: '17' }, { action: 'fill', selector: '#b', value: '25' }, { action: 'click', selector: '#sum' }, { action: 'text', selector: '#result', contains: '42' }],
      test: `import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from '../backend.mjs'; test('adds decimal and negative values',()=>{assert.equal(sum(-2, 2.5),.5)});`,
      backend: `export const sum=(a,b)=>Number(a)+Number(b); export function handle(req,res){res.end('ok')}`,
    },
    {
      name: 'CSV converter',
      source: `document.querySelector('#app')!.innerHTML='<h1>CSV to JSON</h1><label>CSV<textarea id="csv"></textarea></label><button id="convert">Convert</button><output id="result"></output>'; document.querySelector('#convert')!.addEventListener('click',()=>{const [head,...lines]=(document.querySelector('#csv') as HTMLTextAreaElement).value.trim().split('\\n');document.querySelector('#result')!.textContent=JSON.stringify(lines.map(line=>Object.fromEntries(head.split(',').map((key,i)=>[key,line.split(',')[i]]))));});`,
      scenario: [{ action: 'fill', selector: '#csv', value: 'name,count\nMinnow,3' }, { action: 'click', selector: '#convert' }, { action: 'text', selector: '#result', contains: '"name":"Minnow"' }],
      test: `import test from 'node:test';import assert from 'node:assert/strict';import {convert} from '../backend.mjs';test('empty CSV has no rows',()=>assert.deepEqual(convert(''),[]));test('maps columns',()=>assert.deepEqual(convert('a,b\\n1,2'),[{a:'1',b:'2'}]));`,
      backend: `export function convert(csv){if(!csv.trim())return [];const [h,...rows]=csv.trim().split('\\n');return rows.map(row=>Object.fromEntries(h.split(',').map((key,i)=>[key,row.split(',')[i]])))};export function handle(req,res){res.end('ok')}`,
    },
    {
      name: 'Image resizer',
      source: `document.querySelector('#app')!.innerHTML='<h1>Image resizer</h1><label>Image<input id="image" type="file" accept="image/*"></label><label>Width<input id="width" type="number" value="32"></label><button id="resize">Resize</button><output id="result"></output><canvas id="canvas"></canvas>';document.querySelector('#resize')!.addEventListener('click',async()=>{const file=(document.querySelector('#image') as HTMLInputElement).files?.[0];if(!file)return;const image=new Image();const url=URL.createObjectURL(file);image.src=url;await image.decode();const canvas=document.querySelector('#canvas') as HTMLCanvasElement;canvas.width=Number((document.querySelector('#width') as HTMLInputElement).value);canvas.height=Math.round(image.height*canvas.width/image.width);canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);URL.revokeObjectURL(url);document.querySelector('#result')!.textContent=canvas.width+' × '+canvas.height;});`,
      scenario: [{ action: 'file', selector: '#image', value: 'sample.svg' }, { action: 'fill', selector: '#width', value: '32' }, { action: 'click', selector: '#resize' }, { action: 'text', selector: '#result', contains: '32 × 16' }],
      test: `import test from 'node:test';import assert from 'node:assert/strict';import {height} from '../backend.mjs';test('retains aspect ratio',()=>assert.equal(height(100,50,32),16));`,
      backend: `export const height=(w,h,next)=>Math.round(h*next/w);export function handle(req,res){res.end('ok')}`,
    },
  ];
  try {
    for (const fixture of fixtures) {
      const app = await createApp({ prompt: fixture.name, modelId: 'fixture' });
      const run = { id: randomUUID(), prompt: fixture.name };
      let implementations = 0;
      const agent = async ({ workspace, phase }) => {
        if (phase === 'plan') return { text: 'Implement the requested utility and functional tests.' };
        implementations++;
        await fs.writeFile(path.join(workspace, 'src/main.ts'), fixture.source);
        await fs.writeFile(path.join(workspace, 'backend.mjs'), fixture.backend);
        await fs.mkdir(path.join(workspace, 'test/fixtures'), { recursive: true });
        await fs.writeFile(path.join(workspace, 'test/core.test.mjs'), fixture.test);
        await fs.writeFile(path.join(workspace, 'test/fixtures/sample.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="red"/></svg>');
        await fs.writeFile(path.join(workspace, 'reef.scenarios.json'), JSON.stringify([{ name: fixture.name, steps: fixture.scenario }]));
        if (fixture.name === 'Calculator' && implementations === 1) await fs.appendFile(path.join(workspace, 'src/main.ts'), '\nconst broken:');
        return { text: 'Implemented.' };
      };
      const stages = [];
      const release = await buildApp({ app, run, baseUrl: 'http://unused', signal: controller.signal, stage: async state => { stages.push(state); }, log: text => process.stderr.write(text), agent });
      assert.ok(stages.includes('checking')); assert.equal(stages.at(-1), 'promoting');
      if (fixture.name === 'Calculator') { assert.ok(stages.includes('repairing')); assert.equal(implementations, 2); }
      await updateApp(app.id, row => { row.release = release; });
      const tools = await ensureToolchain();
      const first = await launchApp(app.id, tools);
      assert.equal((await fetch(first.url)).status, 200); await stopApp(app.id);
      const second = await launchApp(app.id, tools);
      assert.equal((await fetch(second.url)).status, 200); await stopApp(app.id);
      assert.equal((await readApp(app.id)).release.commit, release.commit);
      assert.ok((await fs.readFile(path.join(appRoot(app.id), 'repo', '.git', 'config'), 'utf8')).includes('[core]'));
      if (fixture.name === 'Calculator' && process.env.MINNOW_REEF_EXPORT_E2E === '1') {
        const item = await queueExport(app.id, { method: 'local', target: process.platform });
        let outcome;
        for (let attempt = 0; attempt < 600; attempt++) {
          outcome = (await readApp(app.id)).exports.find(value => value.id === item.id);
          if (['ready', 'failed'].includes(outcome.status)) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        assert.equal(outcome.status, 'ready', `${outcome.error}\n${outcome.log}`);
        assert.ok((await fs.stat(path.join(appRoot(app.id), 'exports', item.id, outcome.filename))).size > 1000000);
        if (process.platform === 'win32') {
          const output = path.join(appRoot(app.id), 'exports', item.id, 'source', 'release');
          const executable = (await fs.readdir(output)).find(name => name.endsWith('.exe'));
          assert.ok(executable, 'portable executable exists');
          await command(path.join(output, executable), ['--reef-smoke-test'], { timeout: 120000 });
        } else {
          const output = path.join(appRoot(app.id), 'exports', item.id, 'source', 'release');
          const directories = await fs.readdir(output);
          let executable;
          if (process.platform === 'linux') {
            const unpacked = directories.find(name => /^linux.*-unpacked$/.test(name));
            executable = path.join(output, unpacked, 'reef-utility');
          } else {
            const unpacked = directories.find(name => /^mac(?:-|$)/.test(name));
            executable = path.join(output, unpacked, 'Calculator.app', 'Contents', 'MacOS', 'Calculator');
          }
          await command(executable, ['--reef-smoke-test'], { timeout: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
        }
      }
    }
  } finally { controller.abort(); await fs.rm(home, { recursive: true, force: true }); }
});
