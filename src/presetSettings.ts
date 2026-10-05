import {
  App,
  Modal,
  Notice,
  Setting,
  TextAreaComponent,
  TextComponent,
  TFile,
  TFolder,
  normalizePath,
  type SettingDefinitionItem,
} from 'obsidian';
// Type-only on purpose: `main.ts` imports `settings.ts`, which delegates here,
// so a runtime import of the plugin class would close the cycle.
import type DoomscrollPlugin from './main.ts';
import { allAlgorithms } from './algorithms/index.ts';
import {
  activeAlgorithm,
  activeDisplay,
  activeFilter,
  defaultAlgorithmPreset,
  defaultDisplayPreset,
  defaultFilterPreset,
  duplicatePreset,
  newPresetId,
  removePreset,
  uniqueName,
  type PresetKind,
} from './presets.ts';
import { exportLibrary, exportPreset, importPresets } from './presetIo.ts';
import {
  FILE_CATEGORIES,
  isAlgorithmId,
  isRuleMode,
  type AlgorithmPreset,
  type DisplayPreset,
  type FilterPreset,
  type FilterableKind,
  type PresetLibrary,
  type TotalPreset,
} from './types.ts';

/**
 * The preset-manager section of the settings tab.
 *
 * Everything here is built as declarative `SettingDefinitionItem`s so it works
 * on API 1.13+, where the tab renders from definitions and calls
 * `getControlValue`/`setControlValue` on the host for persistence. The host
 * routes the keys listed in `PRESET_CONTROL_KEYS` to this module; unknown keys
 * fall through so the host keeps owning feed mechanics.
 *
 * The imperative rows (create/rename/duplicate/delete/export/import) exist
 * because the declarative control types cover only simple inputs. They follow
 * the same query-or-create-then-empty pattern the host uses for its own lists:
 * a declarative `render` callback re-runs on every settings update, so building
 * DOM unconditionally would stack a copy per save.
 */

/** Any preset shape, for the helpers that only touch id/name. */
type AnyPreset = FilterPreset | AlgorithmPreset | DisplayPreset | TotalPreset;

/**
 * Where "save to a file" lands. A visible top-level folder keeps the export
 * findable in the file explorer; the vault API cannot write into `.obsidian`.
 */
const EXPORT_FOLDER = 'IntelliScroll exports';

// ─── Control keys ──────────────────────────────────────────────────────────

const MODE_OPTIONS: Record<string, string> = {
  // Phrased as directions rather than "blacklist"/"whitelist" so the two
  // options cannot be mistaken for each other.
  blacklist: 'Exclude these',
  whitelist: 'Only these',
};

/**
 * One toggle per file category plus `note`, so "only images" can mean only
 * images. Kept as a table because the key→category mapping is needed by both
 * the renderer and the write handler.
 */
const FILE_TYPE_CONTROLS: ReadonlyArray<{
  key: string;
  kind: FilterableKind;
  name: string;
  desc: string;
}> = [
  { key: 'fileTypeImage', kind: 'image', name: 'Images', desc: 'Standalone image files.' },
  { key: 'fileTypeDocument', kind: 'document', name: 'Documents', desc: 'PDFs, e-books and office documents.' },
  { key: 'fileTypeVideo', kind: 'video', name: 'Videos', desc: 'Standalone video files.' },
  { key: 'fileTypeAudio', kind: 'audio', name: 'Audio', desc: 'Standalone audio files.' },
  { key: 'fileTypeOther', kind: 'other', name: 'Other files', desc: 'Any vault file in no other category.' },
  { key: 'fileTypeNote', kind: 'note', name: 'Markdown notes', desc: 'Markdown notes in the vault.' },
];

const CATEGORY_FOR_KEY: Record<string, FilterableKind> = Object.fromEntries(
  FILE_TYPE_CONTROLS.map((entry) => [entry.key, entry.kind])
) as Record<string, FilterableKind>;

/** Canonical order for stored file-type values: categories, then notes. */
const FILE_TYPE_ORDER: readonly FilterableKind[] = [...FILE_CATEGORIES, 'note'];

const FIXED_CONTROL_KEYS: readonly string[] = [
  'activeFilterPreset',
  'activeAlgorithmPreset',
  'activeDisplayPreset',
  'activeTotalPreset',
  'folderMode',
  'tagMode',
  'globMode',
  'fileTypeMode',
  'algorithm',
];

/** Keys this module owns, so the host can route get/setControlValue here. */
export const PRESET_CONTROL_KEYS: readonly string[] = [
  ...FIXED_CONTROL_KEYS,
  ...FILE_TYPE_CONTROLS.map((entry) => entry.key),
];

/** Algorithm ids to display names, sourced from the registry itself. */
const ALGORITHM_OPTIONS: Record<string, string> = Object.fromEntries(
  allAlgorithms().map((algorithm) => [
    algorithm.id,
    algorithm.id === 'off' ? 'Off (shuffled feed)' : algorithm.label,
  ])
);

// ─── Read / write ──────────────────────────────────────────────────────────

/** Read a control value this module owns. Return undefined for unknown keys. */
export function readPresetControl(
  key: string,
  plugin: DoomscrollPlugin
): unknown {
  const root = plugin.data.settings;
  const library = root.presets;
  const filter = activeFilter(library, root.activeFilterPresetId);

  switch (key) {
    case 'activeFilterPreset':
      return root.activeFilterPresetId;
    case 'activeAlgorithmPreset':
      return root.activeAlgorithmPresetId;
    case 'activeDisplayPreset':
      return root.activeDisplayPresetId;
    case 'activeTotalPreset':
      // The dropdown has an empty option meaning "individual presets", so a
      // missing composite id must read as the empty string, not null.
      return root.activeTotalPresetId ?? '';
    case 'folderMode':
      return filter.folders.mode;
    case 'tagMode':
      return filter.tags.mode;
    case 'globMode':
      return filter.globs.mode;
    case 'fileTypeMode':
      return filter.fileTypes.mode;
    case 'algorithm':
      return activeAlgorithm(library, root.activeAlgorithmPresetId).algorithm;
    default: {
      const category = CATEGORY_FOR_KEY[key];
      if (category === undefined) return undefined;
      return filter.fileTypes.values.includes(category);
    }
  }
}

/**
 * Write a control value this module owns. Returns true when the key was
 * recognised and handled (including when the value was rejected), false for
 * unknown keys so the caller can fall through to its own switch.
 *
 * Persists and refreshes before returning.
 */
export async function writePresetControl(
  key: string,
  value: unknown,
  plugin: DoomscrollPlugin,
  refresh: () => void
): Promise<boolean> {
  const root = plugin.data.settings;
  const library = root.presets;

  switch (key) {
    // `selectPreset` drops the override belonging to the group being chosen,
    // and `selectTotalPreset` drops all of them. Clearing anything broader here
    // would throw away an unrelated experiment: picking an algorithm preset
    // must not discard a filter the user is still trying out.
    case 'activeFilterPreset': {
      if (typeof value !== 'string') return true;
      await plugin.selectPreset('filter', value);
      refresh();
      return true;
    }
    case 'activeAlgorithmPreset': {
      if (typeof value !== 'string') return true;
      await plugin.selectPreset('algorithm', value);
      refresh();
      return true;
    }
    case 'activeDisplayPreset': {
      if (typeof value !== 'string') return true;
      await plugin.selectPreset('display', value);
      refresh();
      return true;
    }
    case 'activeTotalPreset': {
      if (value === '' || value === null || value === undefined) {
        await plugin.selectTotalPreset(null);
      } else if (typeof value === 'string') {
        // Clears the composite itself when it cannot resolve.
        await plugin.selectTotalPreset(value);
      } else {
        return true;
      }
      refresh();
      return true;
    }
    case 'algorithm': {
      if (!isAlgorithmId(value)) return true;
      const preset = activeAlgorithm(library, root.activeAlgorithmPresetId);
      preset.algorithm = value;
      break;
    }
    case 'folderMode':
    case 'tagMode':
    case 'globMode':
    case 'fileTypeMode': {
      if (!isRuleMode(value)) return true;
      const preset = activeFilter(library, root.activeFilterPresetId);
      if (key === 'folderMode') {
        preset.folders = { ...preset.folders, mode: value };
      } else if (key === 'tagMode') {
        preset.tags = { ...preset.tags, mode: value };
      } else if (key === 'globMode') {
        preset.globs = { ...preset.globs, mode: value };
      } else {
        // Mode only: the category toggles own the values.
        preset.fileTypes = { ...preset.fileTypes, mode: value };
      }
      break;
    }
    default: {
      const category = CATEGORY_FOR_KEY[key];
      if (category === undefined) return false;
      if (typeof value !== 'boolean') return true;
      const preset = activeFilter(library, root.activeFilterPresetId);
      const next = new Set<FilterableKind>(preset.fileTypes.values);
      if (value) next.add(category);
      else next.delete(category);
      preset.fileTypes = {
        // The toggle changes membership only; the direction is the mode's job.
        mode: preset.fileTypes.mode,
        values: FILE_TYPE_ORDER.filter((entry) => next.has(entry)),
      };
      break;
    }
  }

  // Editing a group by hand means the active composite no longer describes
  // what is in force.
  root.activeTotalPresetId = null;
  await plugin.saveSettingsAndRefreshViews();
  refresh();
  return true;
}

// ─── Library helpers ───────────────────────────────────────────────────────

function groupOf(library: PresetLibrary, kind: PresetKind): AnyPreset[] {
  switch (kind) {
    case 'filter':
      return library.filters;
    case 'algorithm':
      return library.algorithms;
    case 'display':
      return library.displays;
    case 'total':
      return library.totals;
  }
}

function activeIdOf(plugin: DoomscrollPlugin, kind: PresetKind): string {
  const root = plugin.data.settings;
  if (kind === 'filter') return root.activeFilterPresetId;
  if (kind === 'algorithm') return root.activeAlgorithmPresetId;
  if (kind === 'display') return root.activeDisplayPresetId;
  return root.activeTotalPresetId ?? '';
}

function activePresetOf(
  plugin: DoomscrollPlugin,
  kind: PresetKind
): AnyPreset {
  const group = groupOf(plugin.data.settings.presets, kind);
  // Falling back to the first entry mirrors `activeFilter` and keeps a dangling
  // id from making the action buttons throw.
  return group.find((preset) => preset.id === activeIdOf(plugin, kind)) ?? group[0]!;
}

/** A fresh preset of the given group, named `name`. */
function makeDefaultPreset(
  plugin: DoomscrollPlugin,
  kind: PresetKind,
  name: string
): AnyPreset {
  if (kind === 'filter') return defaultFilterPreset(newPresetId(), name);
  if (kind === 'algorithm') return defaultAlgorithmPreset(newPresetId(), name);
  if (kind === 'display') return defaultDisplayPreset(newPresetId(), name);

  // A total has no defaults of its own, so a new one snapshots the current
  // selection — the natural meaning of "save this configuration".
  const root = plugin.data.settings;
  return {
    id: newPresetId(),
    name,
    filterId: root.activeFilterPresetId,
    algorithmId: root.activeAlgorithmPresetId,
    displayId: root.activeDisplayPresetId,
  };
}

async function selectKind(
  plugin: DoomscrollPlugin,
  kind: PresetKind,
  id: string
): Promise<void> {
  if (kind === 'total') await plugin.selectTotalPreset(id);
  else await plugin.selectPreset(kind, id);
}

// ─── Create / rename / duplicate / delete ──────────────────────────────────

async function createPreset(
  plugin: DoomscrollPlugin,
  refresh: () => void,
  kind: PresetKind,
  label: string
): Promise<void> {
  try {
    const library = plugin.data.settings.presets;
    const taken = groupOf(library, kind).map((preset) => preset.name);
    const preset = makeDefaultPreset(
      plugin,
      kind,
      uniqueName(taken, `New ${label.toLowerCase()}`)
    );
    groupOf(library, kind).push(preset);
    // Switch to the new preset: the user asked for a variant, so they should
    // land on it and be able to edit it immediately.
    await selectKind(plugin, kind, preset.id);
    refresh();
  } catch (error) {
    console.error('Doomscroll: could not create preset', error);
    new Notice('Could not create the preset.');
  }
}

function renamePreset(
  plugin: DoomscrollPlugin,
  refresh: () => void,
  kind: PresetKind,
  label: string
): void {
  const preset = activePresetOf(plugin, kind);
  new PresetNameModal(
    plugin.app,
    `Rename ${label.toLowerCase()} preset`,
    preset.name,
    (name) => {
      void (async () => {
        try {
          if (name === preset.name) return;
          preset.name = name;
          await plugin.saveSettingsAndRefreshViews();
          refresh();
        } catch (error) {
          console.error('Doomscroll: could not rename preset', error);
          new Notice('Could not rename the preset.');
        }
      })();
    }
  ).open();
}

async function duplicateActivePreset(
  plugin: DoomscrollPlugin,
  refresh: () => void,
  kind: PresetKind
): Promise<void> {
  try {
    const library = plugin.data.settings.presets;
    const result = duplicatePreset(library, kind, activeIdOf(plugin, kind));
    if (!result) {
      new Notice('Could not duplicate the preset.');
      return;
    }
    await selectKind(plugin, kind, result.newId);
    refresh();
  } catch (error) {
    console.error('Doomscroll: could not duplicate preset', error);
    new Notice('Could not duplicate the preset.');
  }
}

async function deleteActivePreset(
  plugin: DoomscrollPlugin,
  refresh: () => void,
  kind: PresetKind
): Promise<void> {
  try {
    const root = plugin.data.settings;
    const library = root.presets;
    const activeId = activeIdOf(plugin, kind);

    // `removePreset` refuses to empty a group; surface that rather than
    // appearing to do nothing.
    if (!removePreset(library, kind, activeId)) {
      new Notice('The last preset in a group cannot be deleted.');
      return;
    }

    // Deleting the active preset leaves the group without a selection, so fall
    // back to the first remaining one.
    const group = groupOf(library, kind);
    if (!group.some((preset) => preset.id === activeId)) {
      const fallback = group[0];
      if (fallback) {
        if (kind === 'filter') root.activeFilterPresetId = fallback.id;
        else if (kind === 'algorithm') root.activeAlgorithmPresetId = fallback.id;
        else if (kind === 'display') root.activeDisplayPresetId = fallback.id;
        else root.activeTotalPresetId = fallback.id;
      }
    }

    // Removing a filter/algorithm/display also drops every total referencing
    // it, which can strand the active composite id.
    if (
      root.activeTotalPresetId !== null &&
      !library.totals.some((total) => total.id === root.activeTotalPresetId)
    ) {
      root.activeTotalPresetId = null;
    }

    await plugin.saveSettingsAndRefreshViews();
    refresh();
  } catch (error) {
    console.error('Doomscroll: could not delete preset', error);
    new Notice('Could not delete the preset.');
  }
}

// ─── Export / import ───────────────────────────────────────────────────────

function exportJsonFor(
  plugin: DoomscrollPlugin,
  kind: PresetKind | 'library'
): string | null {
  const library = plugin.data.settings.presets;
  if (kind === 'library') return exportLibrary(library);
  return exportPreset(library, kind, activeIdOf(plugin, kind));
}

async function copyExport(
  plugin: DoomscrollPlugin,
  kind: PresetKind | 'library'
): Promise<void> {
  const json = exportJsonFor(plugin, kind);
  if (json === null) {
    new Notice('Could not build the export.');
    return;
  }
  try {
    // `clipboard` is absent in some non-secure contexts; the throw is caught.
    await navigator.clipboard.writeText(json);
    new Notice('Copied preset JSON to the clipboard.');
  } catch (error) {
    console.error('Doomscroll: could not copy export to clipboard', error);
    new Notice('Could not copy to the clipboard.');
  }
}

async function writeVaultFile(
  plugin: DoomscrollPlugin,
  filename: string,
  json: string
): Promise<void> {
  const vault = plugin.app.vault;
  const folder = normalizePath(EXPORT_FOLDER);
  if (!(vault.getAbstractFileByPath(folder) instanceof TFolder)) {
    await vault.createFolder(folder);
  }

  const path = normalizePath(`${EXPORT_FOLDER}/${filename}`);
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await vault.modify(existing, json);
  else await vault.create(path, json);
  new Notice(`Exported to ${path}`);
}

async function saveExport(
  plugin: DoomscrollPlugin,
  kind: PresetKind | 'library'
): Promise<void> {
  const json = exportJsonFor(plugin, kind);
  if (json === null) {
    new Notice('Could not build the export.');
    return;
  }

  // A timestamp in the name means repeated exports never clobber each other.
  const prefix =
    kind === 'library'
      ? 'intelliscroll-library'
      : `intelliscroll-${kind}-${slug(activePresetOf(plugin, kind).name)}`;
  const filename = `${prefix}-${timestamp()}.json`;
  try {
    await writeVaultFile(plugin, filename, json);
  } catch (error) {
    console.error('Doomscroll: could not write export file', error);
    new Notice('Could not write the export file.');
  }
}

async function importFromJson(
  plugin: DoomscrollPlugin,
  refresh: () => void,
  json: string
): Promise<void> {
  try {
    const result = importPresets(json, plugin.data.settings.presets);
    if (!result.ok) {
      // Nothing was assigned, so the existing library is untouched.
      new Notice(`Import failed: ${result.error ?? 'unknown error'}`);
      return;
    }
    plugin.data.settings.presets = result.library;
    await plugin.saveSettingsAndRefreshViews();
    refresh();
    const { filters, algorithms, displays, totals } = result.imported;
    new Notice(
      `Imported ${filters} filter, ${algorithms} algorithm, ${displays} display and ${totals} total presets.`
    );
  } catch (error) {
    console.error('Doomscroll: preset import failed', error);
    new Notice('Import failed.');
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function slug(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]+/g, '-').trim();
  return cleaned.length > 0 ? cleaned : 'preset';
}

// ─── Modals ────────────────────────────────────────────────────────────────

/**
 * Obsidian has no built-in single-line prompt and `window.prompt` does not
 * exist in the mobile WebView, so renaming needs a small modal. Fields are
 * declared explicitly rather than as constructor parameter properties, which
 * Node's strip-only TypeScript loader rejects.
 */
class PresetNameModal extends Modal {
  private value: string;
  private readonly heading: string;
  private readonly onSubmit: (name: string) => void;

  constructor(
    app: App,
    heading: string,
    initial: string,
    onSubmit: (name: string) => void
  ) {
    super(app);
    this.heading = heading;
    this.value = initial;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText(this.heading);

    const input = new TextComponent(this.contentEl);
    input.setValue(this.value);
    input.onChange((value) => {
      this.value = value;
    });
    input.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.submit();
      }
    });

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('Save').setCta().onClick(() => this.submit())
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => this.close())
      );

    input.inputEl.focus();
    input.inputEl.select();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const name = this.value.trim();
    // An unnamed preset would be unreachable in the menus, so refuse it and
    // leave the modal open so the user can correct the field.
    if (name.length === 0) {
      new Notice('A preset needs a non-empty name.');
      return;
    }
    this.close();
    this.onSubmit(name);
  }
}

/** Paste-in import. Importing touches no preset until the JSON parses. */
class ImportPresetsModal extends Modal {
  private value = '';
  private readonly onSubmit: (json: string) => void;

  constructor(app: App, onSubmit: (json: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    this.titleEl.setText('Import presets');
    this.contentEl.createEl('p', {
      text: 'Paste an exported preset JSON below. Imported presets are added to the existing library.',
    });

    const area = new TextAreaComponent(this.contentEl);
    area.inputEl.rows = 12;
    area.setPlaceholder('{ "version": 1, ... }');
    area.onChange((value) => {
      this.value = value;
    });

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('Import').setCta().onClick(() => {
          this.close();
          this.onSubmit(this.value);
        })
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ─── Declarative item builders ─────────────────────────────────────────────

/**
 * Run `build` into a marker-classed row, reusing and emptying an existing one.
 *
 * Obsidian re-runs a declarative `render` callback on every settings update
 * while leaving the previous children in place, so a naive append would add a
 * second copy of the buttons on every save.
 */
function actionsRow(
  setting: Setting,
  marker: string,
  build: (row: HTMLElement) => void
): void {
  const existing = setting.settingEl.querySelector(`.${marker}`);
  const row =
    existing instanceof HTMLElement
      ? existing
      : setting.controlEl.createDiv({ cls: marker });
  row.empty();
  build(row);
}

function actionButton(
  row: HTMLElement,
  text: string,
  cls: string | undefined,
  onClick: () => void
): void {
  const button = row.createEl('button', cls ? { text, cls } : { text });
  // Settings rows can live inside a form; a default submit button would reload.
  button.type = 'button';
  button.onclick = onClick;
}

function nameOptions(
  items: ReadonlyArray<{ id: string; name: string }>
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const item of items) options[item.id] = item.name;
  return options;
}

function heading(name: string, desc?: string): SettingDefinitionItem {
  return {
    name,
    desc,
    render: (setting) => {
      setting.setName(name).setHeading();
      if (desc) setting.setDesc(desc);
    },
  };
}

/** One row of New / Rename / Duplicate / Delete for a group. */
function crudItem(
  plugin: DoomscrollPlugin,
  refresh: () => void,
  kind: PresetKind,
  label: string
): SettingDefinitionItem {
  const name = `Manage ${label.toLowerCase()} presets`;
  const desc = 'Create, rename, duplicate or delete presets. The last preset in a group cannot be deleted.';
  return {
    name,
    desc,
    render: (setting) => {
      setting.setName(name).setDesc(desc);
      actionsRow(setting, `doomscroll-preset-manage-${kind}`, (row) => {
        actionButton(row, 'New', 'mod-cta', () => {
          void createPreset(plugin, refresh, kind, label);
        });
        actionButton(row, 'Rename', undefined, () => {
          renamePreset(plugin, refresh, kind, label);
        });
        actionButton(row, 'Duplicate', undefined, () => {
          void duplicateActivePreset(plugin, refresh, kind);
        });
        actionButton(row, 'Delete', 'mod-warning', () => {
          void deleteActivePreset(plugin, refresh, kind);
        });
      });
    },
  };
}

function exportItem(
  plugin: DoomscrollPlugin,
  kind: PresetKind | 'library',
  label: string
): SettingDefinitionItem {
  const name = `Export ${label}`;
  const desc = 'Copy the JSON to the clipboard, or save it as a file in the vault.';
  return {
    name,
    desc,
    render: (setting) => {
      setting.setName(name).setDesc(desc);
      actionsRow(setting, `doomscroll-preset-export-${kind}`, (row) => {
        actionButton(row, 'Copy JSON', undefined, () => {
          void copyExport(plugin, kind);
        });
        actionButton(row, 'Save to vault', undefined, () => {
          void saveExport(plugin, kind);
        });
      });
    },
  };
}

function importItem(
  plugin: DoomscrollPlugin,
  refresh: () => void
): SettingDefinitionItem {
  const name = 'Import presets';
  const desc = 'Paste exported JSON to add its presets to this library. Existing presets are kept.';
  return {
    name,
    desc,
    render: (setting) => {
      setting.setName(name).setDesc(desc);
      actionsRow(setting, 'doomscroll-preset-import', (row) => {
        actionButton(row, 'Import JSON', 'mod-cta', () => {
          new ImportPresetsModal(plugin.app, (json) => {
            void importFromJson(plugin, refresh, json);
          }).open();
        });
      });
    },
  };
}

/** The declarative settings items for the whole preset manager. */
export function buildPresetSettings(
  plugin: DoomscrollPlugin,
  refresh: () => void
): SettingDefinitionItem[] {
  const library = plugin.data.settings.presets;

  const items: SettingDefinitionItem[] = [];

  items.push(
    heading(
      'Preset manager',
      'Configuration is stored as named presets. A total preset bundles one filter, one algorithm and one display preset.'
    )
  );

  // Total selector first: it is the coarse control, and choosing one drives the
  // three group selectors below.
  items.push({
    name: 'Total preset',
    desc: 'A complete configuration. Choose "Custom" to edit the three groups independently.',
    control: {
      type: 'dropdown',
      key: 'activeTotalPreset',
      options: {
        '': 'Custom (individual presets)',
        ...nameOptions(library.totals),
      },
    },
  });
  items.push(crudItem(plugin, refresh, 'total', 'Total'));

  // ─── Filter preset ───────────────────────────────────────────────────────
  items.push({
    name: 'Filter preset',
    desc: 'Which set of filters is in force. The settings below edit this preset.',
    control: {
      type: 'dropdown',
      key: 'activeFilterPreset',
      options: nameOptions(library.filters),
    },
  });
  items.push({
    name: 'Folders',
    desc: 'Whether the folder list is excluded, or the only folders allowed.',
    control: { type: 'dropdown', key: 'folderMode', options: MODE_OPTIONS },
  });
  items.push({
    name: 'Tags',
    desc: 'Whether the tag list is excluded, or the only tags allowed.',
    control: { type: 'dropdown', key: 'tagMode', options: MODE_OPTIONS },
  });
  items.push({
    name: 'Filename patterns',
    desc: 'Whether the pattern list is excluded, or the only patterns allowed.',
    control: { type: 'dropdown', key: 'globMode', options: MODE_OPTIONS },
  });
  items.push({
    name: 'File types',
    desc: 'Whether the category list is excluded, or the only categories allowed.',
    control: { type: 'dropdown', key: 'fileTypeMode', options: MODE_OPTIONS },
  });
  items.push(
    heading(
      'File type categories',
      'How the file-type list is read: in "Exclude these" mode a checked category is hidden; in "Only these" mode only checked categories are shown.'
    )
  );
  for (const entry of FILE_TYPE_CONTROLS) {
    items.push({
      name: entry.name,
      desc: entry.desc,
      control: { type: 'toggle', key: entry.key },
    });
  }
  items.push(crudItem(plugin, refresh, 'filter', 'Filter'));

  // ─── Algorithm preset ────────────────────────────────────────────────────
  // The engine dropdown itself lives in the settings tab's resurfacing section
  // alongside grading, sensitivity and the FSRS parameters. Rendering it here
  // too would show the same row twice; this module owns *which* preset is
  // active, that one owns *what is in* it.
  items.push({
    name: 'Algorithm preset',
    desc: 'Which scheduling configuration is in force.',
    control: {
      type: 'dropdown',
      key: 'activeAlgorithmPreset',
      options: nameOptions(library.algorithms),
    },
  });
  items.push(crudItem(plugin, refresh, 'algorithm', 'Algorithm'));

  // ─── Display preset ──────────────────────────────────────────────────────
  items.push({
    name: 'Display preset',
    desc: 'Which set of display options is in force.',
    control: {
      type: 'dropdown',
      key: 'activeDisplayPreset',
      options: nameOptions(library.displays),
    },
  });
  items.push(crudItem(plugin, refresh, 'display', 'Display'));

  // ─── Export / import ─────────────────────────────────────────────────────
  items.push(heading('Backup and sharing'));
  items.push(exportItem(plugin, 'library', 'preset library'));
  items.push(exportItem(plugin, 'filter', 'filter preset'));
  items.push(exportItem(plugin, 'algorithm', 'algorithm preset'));
  items.push(exportItem(plugin, 'display', 'display preset'));
  items.push(exportItem(plugin, 'total', 'total preset'));
  items.push(importItem(plugin, refresh));

  return items;
}
