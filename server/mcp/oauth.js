import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { readEncryptedJsonFile, writeEncryptedJsonFile } from '../security/secret-box.js';

const providers = new Map();

/** SDK-backed discovery, registration, PKCE and refresh; credentials stay on disk encrypted. */
export async function getMcpOAuthProvider(id, url, onAuthorized, oauth = {}) {
  const key = `${getMinnowHome()}:${id}:${url}:${JSON.stringify(oauth)}`;
  if (providers.has(key)) return providers.get(key);
  const file = path.join(getMinnowHome(), 'mcp', 'oauth', `${crypto.createHash('sha256').update(key).digest('hex')}.json`);
  const saved = await readEncryptedJsonFile(file, {});
  let listener;
  let timer;
  let state;
  let verifier;
  let redirectUrl = saved.redirectUrl;
  let authorizationUrl;
  let finishAuth;
  let pending = false;
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(saved);
    writes = writes.catch(() => {}).then(() => writeEncryptedJsonFile(file, snapshot));
    return writes;
  };
  function stop() {
    clearTimeout(timer);
    listener?.close();
    listener = undefined;
    authorizationUrl = undefined;
    state = undefined;
    verifier = undefined;
  }
  async function prepare() {
    if (oauth.grantType === 'client_credentials') return;
    if (listener) return;
    state = crypto.randomBytes(32).toString('hex');
    listener = http.createServer(async (req, res) => {
      const callback = new URL(req.url ?? '/', redirectUrl);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (callback.pathname !== '/callback' || callback.searchParams.get('state') !== state || pending) {
        res.writeHead(400).end('Invalid sign-in callback.');
        return;
      }
      pending = true;
      try {
        if (callback.searchParams.has('error')) throw new Error('Sign-in was declined. Try again in Minnow.');
        const code = callback.searchParams.get('code');
        if (!code || !finishAuth) throw new Error('Missing authorization code.');
        await finishAuth(code);
        res.end('Connected. You can return to Minnow.');
        stop();
        void onAuthorized().catch(() => {});
      } catch {
        res.writeHead(400).end('Sign-in did not complete. Return to Minnow and try again.');
        stop();
      } finally { pending = false; }
    });
    // Reuse the registered loopback port across restarts when it is available.
    const port = redirectUrl ? Number(new URL(redirectUrl).port) : 0;
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', resolve);
      });
    } catch (error) {
      stop();
      if (error.code !== 'EADDRINUSE') throw error;
      // A different application took the old callback port. Register the new URI.
      redirectUrl = undefined;
      delete saved.client;
      return prepare();
    }
    listener.unref();
    redirectUrl = `http://127.0.0.1:${listener.address().port}/callback`;
    saved.redirectUrl = redirectUrl;
    await persist();
    timer = setTimeout(stop, 10 * 60 * 1000);
    timer.unref();
  }
  const provider = {
    get redirectUrl() { return oauth.grantType === 'client_credentials' ? undefined : redirectUrl; },
    clientMetadataUrl: oauth.clientMetadataUrl,
    get clientMetadata() {
      return { client_name: 'Minnow', redirect_uris: redirectUrl ? [redirectUrl] : [], grant_types: oauth.grantType === 'client_credentials' ? ['client_credentials'] : ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: oauth.clientSecret ? 'client_secret_post' : 'none', ...(oauth.scope ? { scope: oauth.scope } : {}) };
    },
    state: () => state,
    clientInformation: () => oauth.clientId ? { client_id: oauth.clientId, ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}) } : saved.client,
    async saveClientInformation(client) { saved.client = client; await persist(); },
    tokens: () => saved.tokens,
    async saveTokens(tokens) { saved.tokens = tokens; await persist(); },
    discoveryState: () => saved.discovery,
    async saveDiscoveryState(discovery) {
      if (saved.discovery && saved.discovery.authorizationServerUrl !== discovery.authorizationServerUrl) {
        delete saved.client;
        delete saved.tokens;
      }
      saved.discovery = discovery;
      await persist();
    },
    async redirectToAuthorization(url) { authorizationUrl = url.href; },
    saveCodeVerifier(value) { verifier = value; },
    codeVerifier() { if (!verifier) throw new Error('Sign-in expired. Try again.'); return verifier; },
    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'client') delete saved.client;
      if (scope === 'all' || scope === 'tokens') delete saved.tokens;
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
      if (scope === 'all' || scope === 'discovery') delete saved.discovery;
      await persist();
    },
    prepare,
    get authorizationUrl() { return authorizationUrl; },
    setFinishAuth(fn) { finishAuth = fn; },
    close: stop,
  };
  providers.set(key, provider);
  return provider;
}

export function closeMcpOAuth() {
  for (const provider of providers.values()) provider.close();
  providers.clear();
}
