import { App, TFile } from 'obsidian';
import { PluginData, StoredNotePreview, type FilterPreset } from './types';
import {
  extractImage,
  hasMediaEmbed,
  hasTextualPreviewContent,
} from './extract';
import { isImagePath } from './media';
import { matchesSearchQuery } from './search';
import { compileFilter } from './filtering';

const INDEX_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The configuration the index depends on.
 *
 * Injected rather than read from `data.settings` so that a session override
 * made in the feed reaches the index — filtering happens here, at index time,
 * and the view alone could not trigger the rebuild a filter change requires.
 * It also means the indexer can be tested without a plugin.
 */
export interface IndexerConfig {
  filter: FilterPreset;
  /** Lives in the display preset, but decides how images are extracted. */
  frontmatterImageProps: string[];
}

export class Indexer {
  app: App;
  data: PluginData;
  private getConfig: () => IndexerConfig;
  private lastRefreshStartedAt = 0;
  private lastIndexedSettingsKey: string | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(app: App, data: PluginData, getConfig: () => IndexerConfig) {
    this.app = app;
    this.data = data;
    this.getConfig = getConfig;
  }

  markDirty(): void {
    this.lastRefreshStartedAt = 0;
  }

  async refreshIfStale(
    onProgress?: (done: number, total: number) => void,
    force = false
  ): Promise<boolean> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      // The caller waited for another refresh; it did not start one itself.
      return false;
    }

    const settingsKey = this.getIndexSettingsKey();
    const settingsChanged = settingsKey !== this.lastIndexedSettingsKey;

    if (
      !force &&
      !settingsChanged &&
      Date.now() - this.lastRefreshStartedAt < INDEX_REFRESH_INTERVAL_MS
    ) {
      return false;
    }

    this.lastRefreshStartedAt = Date.now();
    this.refreshPromise = this.buildOrUpdateIndex(onProgress);

    try {
      await this.refreshPromise;
      // Keep the key captured at refresh start. If settings changed while an
      // index was being built, the next refresh will rebuild for the new key.
      this.lastIndexedSettingsKey = settingsKey;
      return true;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Changing this forces a full rebuild, which sweeps notes that no longer
   * match out of `data.previews`.
   *
   * Only index-affecting configuration belongs here. `includeMediaOnlyNotes`
   * is applied in the view and is deliberately absent, so toggling it stays
   * cheap.
   */
  private getIndexSettingsKey(): string {
    const config = this.getConfig();
    return JSON.stringify({
      // Delegates to the compiled filter's own key rather than re-listing the
      // fields. Two hand-kept copies of this list is how a newly added
      // dimension ends up affecting matching but never invalidating the index.
      filter: compileFilter(config.filter).key,
      frontmatterImageProps: config.frontmatterImageProps,
    });
  }

  getCandidateFiles(): TFile[] {
    const candidates: TFile[] = [];
    const allFiles = this.app.vault.getFiles();
    // Compiled once: the per-dimension helpers would otherwise rebuild every
    // glob regex for every file in the vault.
    const filter = compileFilter(this.getConfig().filter);

    for (const file of allFiles) {
      // Folders, globs and file type are all answerable from the path alone.
      // File type subsumes the old `showNonMarkdownFiles`: blacklisting no
      // categories allows everything, whitelisting none allows nothing.
      if (!filter.passesPath(file.path)) continue;

      // Standalone attachments cannot carry Markdown tags, and `tagsInert`
      // means tag matching cannot exclude anything anyway, so both skip the
      // metadata lookup entirely.
      const isMarkdown = file.extension.toLowerCase() === 'md';
      if (!isMarkdown || filter.tagsInert) {
        candidates.push(file);
        continue;
      }

      // Filter out files whose tags intersect excludeTags
      const fileCache = this.app.metadataCache.getFileCache(file);
      const fileTags = new Set<string>();

      // Get tags from frontmatter
      if (fileCache?.frontmatter?.tags) {
        const frontmatterTags: unknown = fileCache.frontmatter.tags;
        if (Array.isArray(frontmatterTags)) {
          frontmatterTags.forEach((tag) => {
            if (typeof tag === 'string') {
              fileTags.add(tag.toLowerCase());
            }
          });
        } else if (typeof frontmatterTags === 'string') {
          frontmatterTags.split(/\s+/).forEach((tag) => {
            if (tag) {
              fileTags.add(tag.toLowerCase());
            }
          });
        }
      }

      // Get tags from body
      if (fileCache?.tags) {
        fileCache.tags.forEach((tagRef) => {
          fileTags.add(tagRef.tag.substring(1).toLowerCase()); // remove # prefix
        });
      }

      if (!filter.passesTags(fileTags)) continue;

      candidates.push(file);
    }

    return candidates;
  }

  async buildOrUpdateIndex(
    onProgress?: (done: number, total: number) => void
  ): Promise<void> {
    const candidates = this.getCandidateFiles();
    const total = candidates.length;
    const searchQuery = compileFilter(this.getConfig().filter).searchQuery;
    const matchedCandidatePaths = new Set<string>();

    // Keep reads parallel but bounded for mobile devices and large notes.
    const chunkSize = 8;

    for (let i = 0; i < candidates.length; i += chunkSize) {
      const chunk = candidates.slice(i, i + chunkSize);

      await Promise.all(
        chunk.map(async (file) => {
          let content: string | null = null;
          let fileCache = this.app.metadataCache.getFileCache(file);
          const isMarkdown = file.extension.toLowerCase() === 'md';

          if (!isMarkdown) {
            if (
              searchQuery &&
              !matchesSearchQuery(searchQuery, {
                path: file.path,
                content: '',
                frontmatter: undefined,
              })
            ) {
              return;
            }

            matchedCandidatePaths.add(file.path);
            if (
              this.data.previews[file.path]?.mtime === file.stat.mtime &&
              this.data.previews[file.path]?.attachment
            ) {
              return;
            }

            this.data.previews[file.path] = {
              mtime: file.stat.mtime,
              mediaOnly: true,
              attachment: true,
              ...(isImagePath(file.path) ? { imagePath: file.path } : {}),
            };
            return;
          }

          if (searchQuery) {
            content = await this.app.vault.cachedRead(file);
            const frontmatter = isRecord(fileCache?.frontmatter)
              ? fileCache.frontmatter
              : undefined;
            if (!matchesSearchQuery(searchQuery, {
              path: file.path,
              content,
              frontmatter,
            })) {
              return;
            }
          }

          matchedCandidatePaths.add(file.path);

          // Check if cached preview is still valid
          if (this.data.previews[file.path]?.mtime === file.stat.mtime) {
            // Reuse cached preview
            return;
          }

          // Build new preview
          content ??= await this.app.vault.cachedRead(file);
          fileCache ??= this.app.metadataCache.getFileCache(file);
          const rawFrontmatter: unknown = fileCache?.frontmatter;
          const frontmatter = isRecord(rawFrontmatter)
            ? rawFrontmatter
            : undefined;

          const imagePath = extractImage(
            content,
            frontmatter,
            this.getConfig().frontmatterImageProps
          );
          const mediaOnly =
            (Boolean(imagePath) || hasMediaEmbed(content)) &&
            !hasTextualPreviewContent(content);

          const preview: StoredNotePreview = {
            mtime: file.stat.mtime,
            ...(imagePath ? { imagePath } : {}),
            ...(mediaOnly ? { mediaOnly: true as const } : {}),
          };

          this.data.previews[file.path] = preview;
        })
      );

      // Yield to UI
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

      if (onProgress) {
        onProgress(Math.min(i + chunkSize, total), total);
      }
    }

    // Remove stale entries
    const candidatePaths = matchedCandidatePaths;
    const previewKeys = Object.keys(this.data.previews);

    for (const path of previewKeys) {
      if (!candidatePaths.has(path)) {
        delete this.data.previews[path];
      }
    }
  }

  resolveImageSrc(imagePath: string, file: TFile): string | null {
    // Check if it's a URL
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
      return imagePath;
    }

    // Markdown-style image links (![alt](path)) are URL-encoded (e.g. %20 for
    // spaces); vault lookup needs the literal decoded path.
    let lookupPath = imagePath;
    try {
      lookupPath = decodeURIComponent(imagePath);
    } catch {
      // Not valid percent-encoding — use as-is.
    }

    // A standalone attachment points directly at itself. Resolve it without
    // asking the metadata cache to interpret the path as a link from that
    // same file.
    const directFile = this.app.vault.getAbstractFileByPath(lookupPath);
    if (directFile instanceof TFile) {
      return this.app.vault.getResourcePath(directFile);
    }

    // Try to resolve as a vault path
    const resolvedFile = this.app.metadataCache.getFirstLinkpathDest(
      lookupPath,
      file.path
    );

    if (resolvedFile) {
      return this.app.vault.getResourcePath(resolvedFile);
    }

    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
