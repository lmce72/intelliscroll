import type { FileCategory } from './types.ts';

// ─── Rendering predicates ──────────────────────────────────────────────────
// These decide what the card renderer can display inline, and are deliberately
// NARROWER than the filter categories below: adding an extension here changes
// how existing notes render, while adding one to a category only changes what
// can be filtered. Keeping them separate makes the difference explicit.

const INLINE_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const INLINE_VIDEO_EXTS = ['mp4', 'webm', 'ogv', 'mov', 'm4v'];
const PDF_EXTS = ['pdf'];

const IMAGE_EXT_RE = new RegExp(`\\.(${INLINE_IMAGE_EXTS.join('|')})$`, 'i');
const PDF_EXT_RE = new RegExp(`\\.(${PDF_EXTS.join('|')})$`, 'i');
const VIDEO_EXT_RE = new RegExp(`\\.(${INLINE_VIDEO_EXTS.join('|')})$`, 'i');

/** Strip `?query`/`#fragment` so extension checks see the real path. */
function pathWithoutSuffix(path: string): string {
  return path.split(/[?#]/)[0] ?? path;
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXT_RE.test(pathWithoutSuffix(path));
}

export function isPdfPath(path: string): boolean {
  return PDF_EXT_RE.test(pathWithoutSuffix(path));
}

export function isVideoPath(path: string): boolean {
  return VIDEO_EXT_RE.test(pathWithoutSuffix(path));
}

export function isAudioPath(path: string): boolean {
  return CATEGORY_EXTS.audio.has(extensionOf(path));
}

export function attachmentLabel(path: string): string {
  if (isImagePath(path) || isPdfPath(path) || isVideoPath(path)) return '';

  const extension = extensionOf(path);
  return extension ? `📎 ${extension.toUpperCase()} attached` : '📎 File attached';
}

// ─── Filter categories ─────────────────────────────────────────────────────

function extensionOf(path: string): string {
  const match = pathWithoutSuffix(path).match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * Extensions per filter category. Each category is a superset of the matching
 * rendering predicate above, so anything that renders inline also classifies
 * the same way — while the extra extensions here can be filtered without
 * changing how anything renders.
 */
const CATEGORY_EXTS: Record<Exclude<FileCategory, 'other'>, Set<string>> = {
  image: new Set([
    ...INLINE_IMAGE_EXTS,
    'avif',
    'tiff',
    'tif',
    'heic',
    'heif',
    'ico',
  ]),
  document: new Set([
    ...PDF_EXTS,
    'epub',
    'mobi',
    'azw3',
    'docx',
    'doc',
    'odt',
    'rtf',
    'txt',
    'mdx',
    'xlsx',
    'xls',
    'csv',
    'pptx',
    'ppt',
  ]),
  video: new Set([...INLINE_VIDEO_EXTS, 'mkv', 'avi', 'wmv', 'flv', '3gp']),
  audio: new Set([
    'mp3',
    'wav',
    'ogg',
    'oga',
    'm4a',
    'flac',
    'aac',
    'opus',
    'wma',
    'aiff',
  ]),
};

/**
 * The filter category of a vault path.
 *
 * `.md` is not a file category — it is a note. Notes are governed by the other
 * filter dimensions (folders, tags, globs, search) and by
 * `includeMediaOnlyNotes`, which is a view-time toggle rather than an
 * index-time rule.
 */
export function fileCategory(path: string): FileCategory | 'note' {
  const extension = extensionOf(path);
  if (extension === 'md') return 'note';
  if (extension === '') return 'other';

  for (const category of ['image', 'document', 'video', 'audio'] as const) {
    if (CATEGORY_EXTS[category].has(extension)) return category;
  }
  return 'other';
}

/** Every extension that classifies as the given category. For tests and docs. */
export function extensionsFor(category: Exclude<FileCategory, 'other'>): string[] {
  return [...CATEGORY_EXTS[category]];
}
