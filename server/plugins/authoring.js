import fs from 'node:fs/promises';
import path from 'node:path';
import { pluginId } from './manifest.js';
import { resolveSafePath } from '../runtime/path-access.js';
import { inspectPackage, listPackages, managePackage } from './manager.js';

export const AUTHORING_GUIDE = `Minnow plugin API v1
Build a folder in the workspace containing plugin.json, ESM .mjs tool handlers, optional self-contained HTML panels, and optional SKILL.md files.
Read the full reference with minnow_docs_read path="manual/plugins.md" or invoke /build-plugin.
Manifest example:
{"apiVersion":1,"id":"hello","name":"Hello","version":"1.0.0","description":"A greeting tool and panel","tools":[{"id":"greet","description":"Greet a person","handler":"greet.mjs","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}],"panels":[{"id":"main","title":"Hello","entry":"panel.html"}],"connections":[],"skills":[]}
Handler: export default async function(args, ctx) { return {message: 'Hello ' + args.name}; }
ctx: {pluginId, workspaceRoot, dataDir, connections, signal}. connections[connectionId][fieldId] contains configured values; never log or return secrets. Native ESM handlers can import Node modules and use fetch. They are trusted local code, not a security sandbox. Each call runs in a fresh worker with a 30s default deadline (100–120000ms configurable), 128MiB V8 heap limit and 1MiB output cap. Use ctx.signal for fetch. Store durable data in ctx.dataDir. No background daemons or install scripts are run.
Tools appear as plugin__<id with hyphens replaced by underscores>__<tool id> and use Full/Ask/Off permissions. Disabled plugins cannot dispatch.
Panels are self-contained HTML in a sandboxed iframe. Inline JS/CSS and data: images are allowed; network, host DOM, storage, popups and navigation capabilities are not granted. await minnow.callTool('greet', {name:'Ada'}) invokes only this plugin's declared tools through the normal approval flow. No secrets or host tokens are sent to panels.
Connections: [{id:'service',label:'Service',fields:[{id:'token',label:'API token',secret:true,required:true}]}]. Users configure these in Settings → Plugins; values are encrypted at rest and secret fields are never returned to the UI. OAuth can be implemented by native handlers; automatic OAuth provisioning is not part of API v1.
Skills: [{id:'helper',path:'skills/helper/SKILL.md'}]; frontmatter name must be plugin-<plugin id>-helper. Enabled package skills join the normal slash catalog.
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
  };
  await fs.writeFile(path.join(target, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(target, 'greet.mjs'), "export default async function greet(args, ctx) {\n  return { message: `Hello, ${args.name}!`, workspace: ctx.workspaceRoot };\n}\n");
  await fs.writeFile(path.join(target, 'panel.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Greeting</title><style>body{font:14px system-ui;margin:24px}label,input,button{display:block;margin-block:12px}input,button{font:inherit;padding:8px}</style><h1>Greeting</h1><label for="name">Your name</label><input id="name" value="Ada"><button id="greet">Say hello</button><pre id="result" role="status"></pre><script>document.querySelector("#greet").onclick=async()=>{const button=document.querySelector("#greet");button.disabled=true;try{document.querySelector("#result").textContent=await minnow.callTool("greet",{name:document.querySelector("#name").value});}catch(error){document.querySelector("#result").textContent=error.message;}finally{button.disabled=false;}};</script></html>');
  await fs.writeFile(path.join(target, 'README.md'), `# ${id}\n\n${AUTHORING_GUIDE}\n`);
  return { path: target, installed: false, next: 'Edit and validate with plugin_inspect, then activate with plugin_manage install.' };
}

export async function pluginManage(args) {
  return args.action === 'scaffold' ? scaffoldPackage(args) : managePackage(args);
}
