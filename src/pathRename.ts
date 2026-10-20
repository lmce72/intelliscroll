/**
 * One rename, expressed as a mapping from old paths to new ones.
 *
 * Every piece of state in this plugin is keyed by path — the preview index,
 * reading history, the SRS sidecar, the feed's reading session and the last
 * rating shown on a control. Obsidian reports a rename as a single event with
 * the old and new path, and a folder rename has to carry every descendant with
 * it. Keeping the mapping in one small, pure object means every store rewrites
 * paths the same way, instead of each one growing its own prefix arithmetic
 * (which is exactly how `Notes` ends up matching `Notes-archive`).
 *
 * A pure module with no Obsidian import, so the matching rules are testable.
 */
export interface PathRename {
  /** The old file or folder path. */
  readonly from: string;
  /** The new file or folder path. */
  readonly to: string;
  /** True when the renamed entry is a folder and descendants move with it. */
  readonly folder: boolean;
  /**
   * The new path for an old path, or null when this rename does not touch it.
   *
   * `from + '/'` guards the prefix, so a sibling such as `Notes-archive` is not
   * swallowed by a rename of `Notes`.
   */
  map(path: string): string | null;
  /** Whether an old path is the renamed entry or one of its descendants. */
  covers(path: string): boolean;
}

/** Lower-case extension including the dot, or '' when there is none. */
export function fileExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Whether any segment of the path is dot-prefixed.
 *
 * Obsidian treats those as hidden: they are not part of the vault index, and
 * the built-in trash is `.trash/`. Nothing in the feed can live there.
 */
export function isHiddenVaultPath(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Rewrite path-bearing filter values for a rename.
 *
 * A trailing slash marks a folder entry in the ignore list, so it is stripped
 * for matching and restored afterwards. Duplicates are removed: mapping two
 * old values onto one new value (a folder merged into another) would otherwise
 * leave the same entry listed twice.
 */
export function migratePathValues(
  values: readonly string[],
  rename: PathRename
): { values: string[]; changed: boolean } {
  let changed = false;
  const migrated: string[] = [];

  for (const value of values) {
    const folderEntry = value.endsWith('/');
    const withoutSlash = folderEntry ? value.replace(/\/+$/, '') : value;
    const mapped = rename.map(withoutSlash);
    if (mapped === null) {
      migrated.push(value);
      continue;
    }
    changed = true;
    migrated.push(folderEntry ? `${mapped}/` : mapped);
  }

  const deduped = Array.from(new Set(migrated));
  if (deduped.length !== migrated.length) changed = true;
  return { values: deduped, changed };
}

export function pathRename(
  from: string,
  to: string,
  folder: boolean
): PathRename {
  const fromPrefix = `${from}/`;
  const toPrefix = `${to}/`;

  return {
    from,
    to,
    folder,
    map(path: string): string | null {
      if (path === from) return to;
      if (folder && path.startsWith(fromPrefix)) {
        return `${toPrefix}${path.slice(fromPrefix.length)}`;
      }
      return null;
    },
    covers(path: string): boolean {
      return path === from || (folder && path.startsWith(fromPrefix));
    },
  };
}
