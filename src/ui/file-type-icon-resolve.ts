import {
  file,
  folder,
  folderExpanded,
  fileNames,
  fileExtensions,
  folderNames,
  light,
} from 'material-icon-theme/dist/material-icons.json';

type AssociationMap = Record<string, string>;

interface MaterialIconManifest {
  file: string;
  folder: string;
  folderExpanded: string;
  fileNames: AssociationMap;
  fileExtensions: AssociationMap;
  folderNames: AssociationMap;
  light?: {
    fileNames?: AssociationMap;
    fileExtensions?: AssociationMap;
    folderNames?: AssociationMap;
  };
}

// Named JSON imports let the bundler omit VS Code metadata and SVG definitions.
const manifest: MaterialIconManifest = {
  file, folder, folderExpanded, fileNames, fileExtensions, folderNames, light,
};

/** Material Icon Theme's expanded folders share the closed id plus `-open`. */
function expandedFolderIconId(iconId: string): string {
  return iconId.replace(/(_light)?$/, '-open$1');
}

function basenameOf(pathOrName: string): string {
  return (pathOrName.split(/[/\\]/).pop() ?? pathOrName).toLowerCase();
}

export function resolveFileIconId(
  pathOrName: string,
  options?: { light?: boolean },
): string {
  const lower = basenameOf(pathOrName);
  const light = options?.light === true;
  const lightNames = light ? manifest.light?.fileNames : undefined;
  const lightExts = light ? manifest.light?.fileExtensions : undefined;

  if (lightNames?.[lower]) return lightNames[lower]!;
  if (manifest.fileNames[lower]) return manifest.fileNames[lower]!;

  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    if (lightExts?.[ext]) return lightExts[ext]!;
    if (manifest.fileExtensions[ext]) return manifest.fileExtensions[ext]!;
  }

  return manifest.file || 'file';
}

/** Resolve a Material Icon Theme icon id for a folder name. */
export function resolveFolderIconId(
  folderName: string,
  options?: { expanded?: boolean; light?: boolean },
): string {
  const lower = basenameOf(folderName);
  const expanded = options?.expanded === true;
  const light = options?.light === true;

  if (expanded) {
    const lightMap = light ? manifest.light?.folderNames : undefined;
    if (lightMap?.[lower]) return expandedFolderIconId(lightMap[lower]!);
    if (manifest.folderNames[lower]) return expandedFolderIconId(manifest.folderNames[lower]!);
    return manifest.folderExpanded || 'folder-open';
  }

  const lightMap = light ? manifest.light?.folderNames : undefined;
  if (lightMap?.[lower]) return lightMap[lower]!;
  if (manifest.folderNames[lower]) return manifest.folderNames[lower]!;
  return manifest.folder || 'folder';
}
