#!/usr/bin/env node
/**
 * Stand-in for tools/minnow-tailnet: same flags, env, stdout events, stdin
 * commands, and proxy headers, without Tailscale. Behaviour is chosen by env:
 *   FAKE_TAILNET_MODE        ready (default) | login | approval | crash
 *   FAKE_TAILNET_DNS         DNS name reported when ready
 *   FAKE_TAILNET_INGRESS     funnel (default) | tailnet
 *   FAKE_TAILNET_PORT_FILE   where to write the proxy's local port
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

const stateDir = arg('state-dir');
const target = new URL(arg('target'));
const funnel = process.argv.includes('--funnel');
const secret = process.env.MINNOW_INGRESS_SECRET ?? '';
const mode = process.env.FAKE_TAILNET_MODE ?? 'ready';
const dnsName = process.env.FAKE_TAILNET_DNS ?? 'minnow-test.tail1.ts.net';
const ingress = process.env.FAKE_TAILNET_INGRESS ?? (funnel ? 'funnel' : 'tailnet');

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'fake-node.json'), JSON.stringify({ hostname: arg('hostname'), target: arg('target'), funnel }));
emit({ event: 'starting' });

if (mode === 'crash') process.exit(3);

const proxy = http.createServer((req, res) => {
  const headers = { ...req.headers };
  for (const key of Object.keys(headers)) {
    if (key.startsWith('x-minnow-') || key.startsWith('x-forwarded-')) delete headers[key];
  }
  headers['x-minnow-ingress-secret'] = secret;
  headers['x-minnow-ingress'] = ingress;
  headers['x-forwarded-for'] = '203.0.113.7';
  const upstream = http.request(
    { host: target.hostname, port: target.port, method: req.method, path: req.url, headers },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.statusCode = 502;
    res.end();
  });
  req.pipe(upstream);
});

proxy.listen(0, '127.0.0.1', () => {
  const port = proxy.address().port;
  if (process.env.FAKE_TAILNET_PORT_FILE) fs.writeFileSync(process.env.FAKE_TAILNET_PORT_FILE, String(port));
  if (mode === 'login') {
    emit({ event: 'needs-login', authUrl: 'https://login.tailscale.com/a/fake' });
  } else if (mode === 'device-approval') {
    emit({ event: 'needs-approval', feature: 'device', url: 'https://login.tailscale.com/admin/machines' });
  } else if (mode === 'approval') {
    emit({ event: 'needs-approval', feature: 'funnel', url: 'https://login.tailscale.com/f/funnel?node=fake' });
  } else {
    emit({ event: 'ready', dnsName: `${dnsName}.`, url: `https://${dnsName}/`, funnel, loginName: 'henri@example.com', tailnet: 'example.com' });
  }
});

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (const line of input.split('\n').slice(0, -1)) {
    try {
      if (JSON.parse(line).cmd === 'logout') {
        fs.writeFileSync(path.join(stateDir, 'logged-out'), '1');
        emit({ event: 'stopped' });
        process.exit(0);
      }
    } catch {
      /* ignore */
    }
  }
  input = input.slice(input.lastIndexOf('\n') + 1);
});
process.stdin.on('end', () => {
  emit({ event: 'stopped' });
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
