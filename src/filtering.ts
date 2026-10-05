import { compileGlob } from './glob.ts';
import { fileCategory } from './media.ts';
import type {
  FilterPreset,
  FilterRule,
  FilterableKind,
  RuleMode,
} from './types.ts';

/**
 * Pure filter predicates.
 *
 * Extracted from the indexer so the blacklist/whitelist semantics can be
 * tested directly, without a vault, a metadata cache, or a plugin. The indexer
 * supplies the inputs; everything here is a plain function of them.
 */

/**
 * Whether a dimension lets a file through.
 *
 * `anyMatch` is "did any of this rule's values match the file":
 * - **blacklist** — exclude on a match (an empty list excludes nothing)
 * - **whitelist** — exclude unless something matched (an empty list excludes
 *   everything, which is how "no standalone files at all" is expressed)
 */
export function passesMode(mode: RuleMode, anyMatch: boolean): boolean {
  return mode === 'blacklist' ? !anyMatch : anyMatch;
}

/** Folder paths are stored without trailing slashes. */
export function normalizeFolderList(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter((value) => value.length > 0);
}

/**
 * Case-insensitive path-prefix match.
 *
 * The `${folder}/` guard is what stops `Notes` from also matching a sibling
 * directory named `Notes-archive`.
 */
export function matchesFolder(filePath: string, folderPath: string): boolean {
  const path = filePath.toLowerCase();
  const folder = folderPath.toLowerCase();
  return path === folder || path.startsWith(`${folder}/`);
}

export function matchesAnyFolder(
  filePath: string,
  folders: readonly string[]
): boolean {
  return folders.some((folder) => matchesFolder(filePath, folder));
}

export function passesFolderRule(
  rule: FilterRule,
  filePath: string
): boolean {
  return passesMode(
    rule.mode,
    matchesAnyFolder(filePath, normalizeFolderList(rule.values))
  );
}

export function fileNameOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

/**
 * Globs are matched against both the full path and the bare filename, so
 * `Daily/*` can target a folder while `*.draft.md` works anywhere.
 *
 * Unlike folders and tags, glob matching is case-sensitive — that is the
 * behaviour this plugin shipped with, and changing it would silently alter
 * which notes appear for existing users.
 */
export function compileGlobs(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => compileGlob(pattern));
}

export function passesGlobRule(
  rule: FilterRule,
  filePath: string
): boolean {
  const globs = compileGlobs(rule.values);
  const fileName = fileNameOf(filePath);
  const anyMatch = globs.some(
    (glob) => glob.test(filePath) || glob.test(fileName)
  );
  return passesMode(rule.mode, anyMatch);
}

/** Tag values are compared case-insensitively, without a leading `#`. */
export function normalizeTagList(values: readonly string[]): string[] {
  return values.map((value) => value.trim().replace(/^#/, '').toLowerCase());
}

export function passesTagRule(
  rule: FilterRule,
  fileTags: ReadonlySet<string>
): boolean {
  const wanted = normalizeTagList(rule.values);
  const anyMatch = wanted.some((tag) => fileTags.has(tag));
  return passesMode(rule.mode, anyMatch);
}

/**
 * Exact-path matching for the ignore list.
 *
 * Equality only, deliberately. The entries come from a card's own menu, so they
 * are always real paths; treating them as folder prefixes would make `Notes`
 * also swallow `Notes-archive`, and folders already have their own dimension.
 */
export function passesIgnoreRule(rule: FilterRule, filePath: string): boolean {
  const wanted = rule.values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return passesMode(rule.mode, wanted.includes(filePath.toLowerCase()));
}

/**
 * File type applies to every file, including Markdown notes (`note` is one of
 * the selectable kinds), so a whitelist of `['image']` really does narrow the
 * feed to images alone.
 */
export function passesFileTypeRule(
  rule: FilterPreset['fileTypes'],
  filePath: string
): boolean {
  const kind = fileCategory(filePath) as FilterableKind;
  return passesMode(rule.mode, rule.values.includes(kind));
}

/**
 * A filter preset with its patterns compiled once.
 *
 * The per-dimension helpers above compile on every call, which is fine for
 * tests but would recompile every glob for every file in the vault. The indexer
 * uses this instead.
 */
export interface CompiledFilter {
  /** Stable string for the index-invalidation key. */
  key: string;
  searchQuery: string;
  /** True when tag matching cannot exclude anything, so it can be skipped. */
  tagsInert: boolean;
  /** Folder, glob and file-type dimensions — all answerable from the path. */
  passesPath(filePath: string): boolean;
  passesTags(fileTags: ReadonlySet<string>): boolean;
}

export function compileFilter(preset: FilterPreset): CompiledFilter {
  const folders = normalizeFolderList(preset.folders.values);
  const globs = compileGlobs(preset.globs.values);
  const tags = new Set(normalizeTagList(preset.tags.values));
  const kinds = new Set<FilterableKind>(preset.fileTypes.values);

  const folderMode = preset.folders.mode;
  const globMode = preset.globs.mode;
  const tagMode = preset.tags.mode;
  const fileMode = preset.fileTypes.mode;
  const searchQuery = preset.searchQuery.trim();

  return {
    searchQuery,
    // Only fields that affect which notes are eligible belong in the key.
    // `includeMediaOnlyNotes` is deliberately absent: it is applied in the
    // view, so including it would force a full re-index on a cheap toggle.
    key: JSON.stringify({
      folders: preset.folders,
      tags: preset.tags,
      globs: preset.globs,
      ignore: preset.ignore,
      searchQuery,
      fileTypes: preset.fileTypes,
    }),
    tagsInert: tags.size === 0 && tagMode === 'blacklist',

    passesPath(filePath: string): boolean {
      // Checked before the rest: an ignored note is gone regardless of whether
      // anything else would have admitted it.
      if (!passesIgnoreRule(preset.ignore, filePath)) return false;

      if (!passesMode(folderMode, matchesAnyFolder(filePath, folders))) {
        return false;
      }

      const fileName = fileNameOf(filePath);
      if (
        !passesMode(
          globMode,
          globs.some((glob) => glob.test(filePath) || glob.test(fileName))
        )
      ) {
        return false;
      }

      return passesMode(
        fileMode,
        kinds.has(fileCategory(filePath) as FilterableKind)
      );
    },

    passesTags(fileTags: ReadonlySet<string>): boolean {
      if (tags.size === 0 && tagMode === 'blacklist') return true;
      const anyMatch = Array.from(tags).some((tag) => fileTags.has(tag));
      return passesMode(tagMode, anyMatch);
    },
  };
}
