import { LanguageDescription, LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Extension } from '@codemirror/state';

const godotLanguages = [
  LanguageDescription.of({
    name: 'GDScript',
    extensions: ['gd'],
    load: () => import('./godot-languages').then((m) => new LanguageSupport(m.gdscript())),
  }),
  LanguageDescription.of({
    name: 'Godot Resource',
    extensions: ['tscn', 'tres', 'godot', 'gdextension'],
    load: () => import('./godot-languages').then((m) => new LanguageSupport(m.godotResource())),
  }),
  LanguageDescription.of({
    name: 'Godot Shader',
    extensions: ['gdshader'],
    load: () => import('./godot-languages').then((m) => new LanguageSupport(m.gdshader())),
  }),
];

/** Match a {@link LanguageDescription} for a workspace-relative file path. */
export function resolveLanguageDescription(filename: string): LanguageDescription | null {
  const basename = filename.split(/[/\\]/).pop() ?? filename;
  return (
    LanguageDescription.matchFilename(godotLanguages, basename) ??
    LanguageDescription.matchFilename(languages, basename) ??
    LanguageDescription.matchFilename(languages, filename) ??
    null
  );
}

/** Optional explicit language name (e.g. from modeline); falls back to filename. */
export function resolveLanguageDescriptionByName(languageName: string): LanguageDescription | null {
  const normalized = languageName.trim();
  if (!normalized) return null;
  return LanguageDescription.matchLanguageName(godotLanguages, normalized) ??
    LanguageDescription.matchLanguageName(languages, normalized) ?? null;
}

/** Load syntax extensions for a file path; returns [] when unknown or load fails. */
export async function loadLanguageExtensionsForPath(path: string): Promise<Extension[]> {
  const desc = resolveLanguageDescription(path);
  if (!desc) return [];
  try {
    return [await desc.load()];
  } catch {
    return [];
  }
}
