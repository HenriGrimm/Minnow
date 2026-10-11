/** Shared validation for the workspace picker and clone endpoint. */
export function parseRemoteRepository(value) {
  const remote = typeof value === 'string' ? value.trim() : '';
  if (!remote || /[\s\u0000-\u001f\u007f\\]/.test(remote)) {
    throw new Error('Enter an HTTPS or SSH repository link');
  }
  let repositoryPath;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    let url;
    try { url = new URL(remote); } catch { throw new Error('Invalid repository link'); }
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname) {
      throw new Error('Use an HTTPS or SSH repository link');
    }
    if (url.password || (url.protocol !== 'ssh:' && url.username)) {
      throw new Error('Use a repository link without credentials; sign in with Git on this device');
    }
    if (url.search || url.hash) throw new Error('Use the repository clone link without a query or fragment');
    repositoryPath = url.pathname;
  } else {
    const match = remote.match(/^[\w.-]+@[\w.-]+:(.+)$/);
    if (!match) throw new Error('Enter an HTTPS or SSH repository link');
    repositoryPath = match[1];
  }
  const basename = repositoryPath.replace(/\/+$/, '').split('/').pop();
  if (!basename || basename === '.' || basename === '..') throw new Error('Repository link must include a repository name');
  let name;
  try { name = decodeURIComponent(basename); } catch { throw new Error('Invalid repository link'); }
  name = name.replace(/\.git$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/[. ]+$/, '');
  if (validateRemoteFolderName(name)) name = 'repository';
  return { remote, name };
}

export function validateRemoteFolderName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return 'Enter a folder name';
  if (name === '.' || name === '..' || /[. ]$/.test(name) ||
      /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    return 'Enter a valid folder name';
  }
  return null;
}
