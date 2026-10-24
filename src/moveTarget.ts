/**
 * The configured one-click move destination.
 *
 * Kept in its own module, free of the Obsidian runtime, so the normalisation
 * branches can be tested directly. The value is stored relative to the vault,
 * without leading or trailing slashes, so it compares directly with
 * `TFolder.path`.
 *
 * - empty string: the one-click action is hidden
 * - `/` (or `.`): the vault root
 */
export function normalizeMoveTargetFolder(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  if (trimmed === '.' || trimmed === '/') return '/';
  return trimmed
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}
