import { cliHash } from './checkpoints.js';

/** Token refresh is not an account switch. Unknown credential formats remain conservative. */
export function cliAccountIdentity(data) {
  let record;
  try { record = JSON.parse(data); } catch { return cliHash(data); }
  const tokens = record.tokens ?? record.claudeAiOauth ?? record;
  const claims = token => {
    if (typeof token !== 'string') return null;
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { return null; }
  };
  const jwt = claims(tokens.id_token ?? tokens.idToken ?? tokens.access_token ?? tokens.accessToken);
  const account = tokens.account_id ?? tokens.accountId ?? jwt?.['https://api.openai.com/auth']?.chatgpt_account_id;
  const subject = jwt?.sub;
  if (account || subject) return cliHash({ account, subject, mode: record.auth_mode,
    apiKey: record.OPENAI_API_KEY ?? record.apiKey });
  return cliHash(data);
}
