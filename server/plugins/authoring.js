import fs from 'node:fs/promises';
import path from 'node:path';
import { pluginId } from './manifest.js';
import { resolveSafePath } from '../runtime/path-access.js';
import { inspectPackage, listPackages, managePackage } from './manager.js';

export const AUTHORING_GUIDE = `Minnow plugin API v1
Build a folder in any user workspace containing plugin.json, ESM .mjs tool handlers, optional self-contained HTML panels, optional trusted UI modules, and optional SKILL.md files. You do not need the Minnow source workspace to build an extension.
Read the full reference with minnow_docs_read path="manual/plugins.md" or invoke /build-plugin.
Manifest example:
{"apiVersion":1,"id":"hello","name":"Hello","version":"1.0.0","description":"A greeting tool and panel","tools":[{"id":"greet","description":"Greet a person","handler":"greet.mjs","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}],"panels":[{"id":"main","title":"Hello","entry":"panel.html"}],"connections":[],"skills":[]}
Handler: export default async function(args, ctx) { return {message: 'Hello ' + args.name}; }
ctx: {pluginId, workspaceRoot, dataDir, connections, signal}. connections[connectionId][fieldId] contains configured values; never log or return secrets. Native ESM handlers can import Node modules and use fetch. They are trusted local code, not a security sandbox. Each call runs in a fresh worker with a 30s default deadline (100–120000ms configurable), 128MiB V8 heap limit and 1MiB output cap. Use ctx.signal for fetch. Store durable data in ctx.dataDir. No background daemons or install scripts are run.
Tools appear as plugin__<id with hyphens replaced by underscores>__<tool id> and use Full/Ask/Off permissions. Disabled plugins cannot dispatch.
Panels are self-contained HTML in a sandboxed iframe. Inline JS/CSS and data: images are allowed; network, host DOM, storage, popups and navigation capabilities are not granted. await minnow.callTool('greet', {name:'Ada'}) invokes only this plugin's declared tools through the normal approval flow. No secrets or host tokens are sent to panels.
UI: add ui:{entry:'ui.mjs'} to the manifest. The bundled module exports default function activate(ctx), optionally returning a cleanup function. This is trusted code running in Minnow's document with DOM and authenticated API access. It can add arbitrary DOM/UI using document or ctx.mount(selector,render,position), where position is append/prepend/before/after and render returns a new HTMLElement or {element,dispose}. ctx.mountSlot(name,render,position) targets stable slots: menubar, chat.throughput, chat.message-throughput, chat.message-metrics. Mounts follow core rerenders. Use --mn-* CSS tokens and accessible controls.
ctx.registerApp({id:'main',name:'My app',icon:'grid',description:'...'},root=>{...}) adds a namespaced app to the rail, router and app command palette; return cleanup from its lazy mount callback. The result has id and launch(). ctx.registerMenu('actions',target=>[{id:'open',label:'Open',onSelect:()=>app.launch()}],{kinds:['menubar.plugins','app.rail']}) adds menu rows; registered contextual targets include chat-message and terminal-selection. ctx.registerCommand({id:'open',title:'Open',group:'Plugins',run:()=>app.launch()}) adds a command palette action. ctx.openMenu(options) opens a custom registered menu.
ctx.getChatUsage(chatId?) and ctx.onChatUsage(callback,chatId?) expose copied metrics in this renderer's workspace; omitted chatId follows the active chat. Snapshots contain chatId,workspacePath,streaming,totals (promptTokens,completionTokens,totalTokens,costUsd,completionCount),bySource,current last/live stats and latest completed ledger entry. Cumulative totals count completed requests only, including repeated prompts; never add successive snapshots or live estimates together. ctx.getWorkspaceUsage() and ctx.onWorkspaceUsage(callback) expose totals across retained chats in this workspace. Clear resets a chat ledger; deleted chats are excluded. Missing provider usage is not counted.
UI ctx.callTool invokes only this package's declared tools with ordinary permission and pinned-release checks. ctx.signal aborts on unload. Register subscriptions/listeners/timers and direct DOM cleanup with ctx.onCleanup(fn). Built-in mounts, apps, menus, commands and usage subscriptions clean up on reload/disable/remove. Bundle UI dependencies into its single .mjs entry (no relative imports); settings panels keep their isolated API. Native and UI code both require trust.
Connections: [{id:'service',label:'Service',fields:[{id:'token',label:'API token',secret:true,required:true}]}]. Users configure these in Settings → Plugins; values are encrypted at rest and secret fields are never returned to the UI. OAuth can be implemented by native handlers; automatic OAuth provisioning is not part of API v1.
Skills: [{id:'helper',path:'skills/helper/SKILL.md'}]; frontmatter name must be plugin-<plugin id>-helper. Enabled package skills join the normal slash catalog.
Direct / commands: ctx.registerSlashCommand({id:'tokens',alias:'tokens',label:'Token usage',description:'Open token totals',run:({args,chatId,workspacePath})=>app.launch()}). The canonical name is /plugin-<package>--tokens; optional short aliases cannot shadow built-in commands, skills or other aliases. Commands appear in the composer picker and execute locally before model selection/generation, even during streaming. Use bundled slash skills for agent workflows shared with headless CLI. Disable/reload/remove revoke direct commands along with other UI contributions.
Workflow: scaffold with plugin_manage action=scaffold id=hello path=plugins/hello; edit files with workspace tools; plugin_inspect path=plugins/hello validates without executing code; plugin_manage action=install path=plugins/hello activates live. Later use update with id and path, or reload with id to copy the original source again. Invalid updates preserve the active release. Disable/remove revoke contributions and stop active handlers. Remove deletes connections but retains plugin data. Mutations are blocked in Plan mode.
Packages are limited to 256 files / 8 MiB. No symbolic links, traversal, absolute file entries, npm install hooks or remote downloads. Bundle dependencies into ESM first. Install only code the user trusts; do not invent credentials or weaken permissions. Test tool behavior and error handling before installing.`;

export async function inspectPlugins(args = {}) {
  if (args.path) return inspectPackage(args.path);
  if (args.docs === true) return { guide: AUTHORING_GUIDE };
  return listPackages();
}

export async function scaffoldPackage(args) {
  const id = pluginId(args.id);
  const target = resolveSafePath(args.path ?? `plugins/${id}`, { write: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  resolveSafePath(await fs.realpath(path.dirname(target)), { write: true });
  await fs.mkdir(target);
  const manifest = {
    apiVersion: 1, id, name: id, version: '1.0.0', description: 'A custom Minnow plugin',
    tools: [{ id: 'greet', description: 'Return a greeting', handler: 'greet.mjs', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } }],
    panels: [{ id: 'main', title: 'Greeting', entry: 'panel.html' }], connections: [], skills: [],
    ui: { entry: 'ui.mjs' },
  };
  await fs.writeFile(path.join(target, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(target, 'greet.mjs'), "export default async function greet(args, ctx) {\n  return { message: `Hello, ${args.name}!`, workspace: ctx.workspaceRoot };\n}\n");
  await fs.writeFile(path.join(target, 'ui.mjs'), `export default function activate(ctx) {
  const app = ctx.registerApp({id:'main',name:'${id}',icon:'grid'}, root => {
    root.style.cssText = 'padding:24px;overflow:auto';
    const heading = document.createElement('h1'); heading.textContent = '${id}';
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Say hello';
    const output = document.createElement('p'); output.setAttribute('role','status');
    button.onclick = async () => {
      button.disabled = true;
      try { output.textContent = await ctx.callTool('greet',{name:'Ada'}); }
      catch (error) { output.textContent = error.message; }
      finally { button.disabled = false; }
    };
    root.append(heading,button,output);
  });
  ctx.registerMenu('main', () => [{id:'open',label:'Open ${id}',onSelect:()=>app.launch()}], {kinds:['menubar.plugins']});
  ctx.registerSlashCommand({id:'open',label:'Open ${id}',description:'Open the ${id} app',run:()=>app.launch()});
}
`);
  await fs.writeFile(path.join(target, 'panel.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Greeting</title><style>body{font:14px system-ui;margin:24px}label,input,button{display:block;margin-block:12px}input,button{font:inherit;padding:8px}</style><h1>Greeting</h1><label for="name">Your name</label><input id="name" value="Ada"><button id="greet">Say hello</button><pre id="result" role="status"></pre><script>document.querySelector("#greet").onclick=async()=>{const button=document.querySelector("#greet");button.disabled=true;try{document.querySelector("#result").textContent=await minnow.callTool("greet",{name:document.querySelector("#name").value});}catch(error){document.querySelector("#result").textContent=error.message;}finally{button.disabled=false;}};</script></html>');
  await fs.writeFile(path.join(target, 'README.md'), `# ${id}\n\n${AUTHORING_GUIDE}\n`);
  return { path: target, installed: false, next: 'Edit and validate with plugin_inspect, then activate with plugin_manage install.' };
}

export async function pluginManage(args) {
  return args.action === 'scaffold' ? scaffoldPackage(args) : managePackage(args);
}
