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
import { t } from './i18n.ts';
// Type-only on purpose: `main.ts` imports `settings.ts`, which delegates here,
// so a runtime import of the plugin class would close the cycle.
import type DoomscrollPlugin from './main.ts';
import {
  activeAlgorithm,
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

/**
 * Rule-mode dropdown options. Built per call so a language change is reflected
 * the next time the section renders.
 *
 * Phrased as directions rather than "blacklist"/"whitelist" so the two options
 * cannot be mistaken for each other.
 */
function modeOptions(): Record<string, string> {
  return {
    blacklist: t('presets.mode.option.blacklist'),
    whitelist: t('presets.mode.option.whitelist'),
  };
}

/**
 * One toggle per file category plus `note`, so "only images" can mean only
 * images. Kept as a table because the key→category mapping is needed by both
 * the renderer and the write handler.
 */
const FILE_TYPE_CONTROLS: ReadonlyArray<{
  key: string;
  kind: FilterableKind;
  nameKey: string;
  descKey: string;
}> = [
  {
    key: 'fileTypeImage',
    kind: 'image',
    nameKey: 'presets.fileCategory.image.name',
    descKey: 'presets.fileCategory.image.desc',
  },
  {
    key: 'fileTypeDocument',
    kind: 'document',
    nameKey: 'presets.fileCategory.document.name',
    descKey: 'presets.fileCategory.document.desc',
  },
  {
    key: 'fileTypeVideo',
    kind: 'video',
    nameKey: 'presets.fileCategory.video.name',
    descKey: 'presets.fileCategory.video.desc',
  },
  {
    key: 'fileTypeAudio',
    kind: 'audio',
    nameKey: 'presets.fileCategory.audio.name',
    descKey: 'presets.fileCategory.audio.desc',
  },
  {
    key: 'fileTypeOther',
    kind: 'other',
    nameKey: 'presets.fileCategory.other.name',
    descKey: 'presets.fileCategory.other.desc',
  },
  {
    key: 'fileTypeNote',
    kind: 'note',
    nameKey: 'presets.fileCategory.note.name',
    descKey: 'presets.fileCategory.note.desc',
  },
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

/** The bare word for a preset group, for labels that embed it. */
function groupWord(kind: PresetKind): string {
  switch (kind) {
    case 'filter':
      return t('presets.group.filter');
    case 'algorithm':
      return t('presets.group.algorithm');
    case 'display':
      return t('presets.group.display');
    case 'total':
      return t('presets.group.total');
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
  kind: PresetKind
): Promise<void> {
  try {
    const library = plugin.data.settings.presets;
    const taken = groupOf(library, kind).map((preset) => preset.name);
    const preset = makeDefaultPreset(
      plugin,
      kind,
      uniqueName(taken, t('presets.defaultName', { group: groupWord(kind) }))
    );
    groupOf(library, kind).push(preset);
    // Switch to the new preset: the user asked for a variant, so they should
    // land on it and be able to edit it immediately.
    await selectKind(plugin, kind, preset.id);
    refresh();
  } catch (error) {
    console.error('Doomscroll: could not create preset', error);
    new Notice(t('presets.notice.createFailed'));
  }
}

function renamePreset(
  plugin: DoomscrollPlugin,
  refresh: () => void,
  kind: PresetKind
): void {
  const preset = activePresetOf(plugin, kind);
  new PresetNameModal(
    plugin.app,
    t('presets.rename.title', { group: groupWord(kind) }),
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
          new Notice(t('presets.notice.renameFailed'));
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
      new Notice(t('presets.notice.duplicateFailed'));
      return;
    }
    await selectKind(plugin, kind, result.newId);
    refresh();
  } catch (error) {
    console.error('Doomscroll: could not duplicate preset', error);
    new Notice(t('presets.notice.duplicateFailed'));
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
      new Notice(t('presets.notice.lastOfGroup'));
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
    new Notice(t('presets.notice.deleteFailed'));
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
    new Notice(t('presets.notice.exportBuildFailed'));
    return;
  }
  try {
    // `clipboard` is absent in some non-secure contexts; the throw is caught.
    await navigator.clipboard.writeText(json);
    new Notice(t('presets.notice.copied'));
  } catch (error) {
    console.error('Doomscroll: could not copy export to clipboard', error);
    new Notice(t('presets.notice.copyFailed'));
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
  new Notice(t('presets.notice.exported', { path }));
}

async function saveExport(
  plugin: DoomscrollPlugin,
  kind: PresetKind | 'library'
): Promise<void> {
  const json = exportJsonFor(plugin, kind);
  if (json === null) {
    new Notice(t('presets.notice.exportBuildFailed'));
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
    new Notice(t('presets.notice.exportWriteFailed'));
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
      new Notice(
        t('presets.notice.importFailed', {
          reason: result.error ?? t('presets.notice.unknownError'),
        })
      );
      return;
    }
    plugin.data.settings.presets = result.library;
    await plugin.saveSettingsAndRefreshViews();
    refresh();
    const { filters, algorithms, displays, totals } = result.imported;
    new Notice(
      t('presets.notice.imported', { filters, algorithms, displays, totals })
    );
  } catch (error) {
    console.error('Doomscroll: preset import failed', error);
    new Notice(t('presets.notice.importFailedGeneric'));
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
        button.setButtonText(t('presets.action.save')).setCta().onClick(() => this.submit())
      )
      .addButton((button) =>
        button.setButtonText(t('presets.action.cancel')).onClick(() => this.close())
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
      new Notice(t('presets.notice.nameRequired'));
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
    this.titleEl.setText(t('presets.import.name'));
    this.contentEl.createEl('p', {
      text: t('presets.importModal.desc'),
    });

    const area = new TextAreaComponent(this.contentEl);
    area.inputEl.rows = 12;
    area.setPlaceholder(t('presets.import.placeholder'));
    area.onChange((value) => {
      this.value = value;
    });

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(t('presets.action.import')).setCta().onClick(() => {
          this.close();
          this.onSubmit(this.value);
        })
      )
      .addButton((button) =>
        button.setButtonText(t('presets.action.cancel')).onClick(() => this.close())
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
  kind: PresetKind
): SettingDefinitionItem {
  const name = t('presets.manage.name', { group: groupWord(kind) });
  const desc = t('presets.manage.desc');
  return {
    name,
    desc,
    render: (setting) => {
      setting.setName(name).setDesc(desc);
      actionsRow(setting, `doomscroll-preset-manage-${kind}`, (row) => {
        actionButton(row, t('presets.action.create'), 'mod-cta', () => {
          void createPreset(plugin, refresh, kind);
        });
        actionButton(row, t('presets.action.rename'), undefined, () => {
          renamePreset(plugin, refresh, kind);
        });
        actionButton(row, t('presets.action.duplicate'), undefined, () => {
          void duplicateActivePreset(plugin, refresh, kind);
        });
        actionButton(row, t('presets.action.delete'), 'mod-warning', () => {
          void deleteActivePreset(plugin, refresh, kind);
        });
      });
    },
  };
}

function exportItem(
  plugin: DoomscrollPlugin,
  kind: PresetKind | 'library'
): SettingDefinitionItem {
  const name =
    kind === 'library'
      ? t('presets.export.library.name')
      : t('presets.export.single.name', { group: groupWord(kind) });
  const desc = t('presets.export.desc');
  return {
    name,
    desc,
    render: (setting) => {
      setting.setName(name).setDesc(desc);
      actionsRow(setting, `doomscroll-preset-export-${kind}`, (row) => {
        actionButton(row, t('presets.export.copy'), undefined, () => {
          void copyExport(plugin, kind);
        });
        actionButton(row, t('presets.export.vault'), undefined, () => {
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
  const name = t('presets.import.name');
  const desc = t('presets.import.desc');
  return {
    name,
    desc,
    render: (setting) => {
      setting.setName(name).setDesc(desc);
      actionsRow(setting, 'doomscroll-preset-import', (row) => {
        actionButton(row, t('presets.action.importJson'), 'mod-cta', () => {
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

  items.push(heading(t('presets.section.title'), t('presets.section.desc')));

  // Total selector first: it is the coarse control, and choosing one drives the
  // three group selectors below.
  items.push({
    name: t('presets.activeTotal.name'),
    desc: t('presets.activeTotal.desc'),
    control: {
      type: 'dropdown',
      key: 'activeTotalPreset',
      options: {
        '': t('presets.activeTotal.option.custom'),
        ...nameOptions(library.totals),
      },
    },
  });
  items.push(crudItem(plugin, refresh, 'total'));

  // ─── Filter preset ───────────────────────────────────────────────────────
  items.push({
    name: t('presets.activeFilter.name'),
    desc: t('presets.activeFilter.desc'),
    control: {
      type: 'dropdown',
      key: 'activeFilterPreset',
      options: nameOptions(library.filters),
    },
  });
  items.push({
    name: t('presets.folders.name'),
    desc: t('presets.folders.desc'),
    control: { type: 'dropdown', key: 'folderMode', options: modeOptions() },
  });
  items.push({
    name: t('presets.tags.name'),
    desc: t('presets.tags.desc'),
    control: { type: 'dropdown', key: 'tagMode', options: modeOptions() },
  });
  items.push({
    name: t('presets.globs.name'),
    desc: t('presets.globs.desc'),
    control: { type: 'dropdown', key: 'globMode', options: modeOptions() },
  });
  items.push({
    name: t('presets.fileTypes.name'),
    desc: t('presets.fileTypes.desc'),
    control: { type: 'dropdown', key: 'fileTypeMode', options: modeOptions() },
  });
  items.push(
    heading(
      t('presets.fileCategories.title'),
      t('presets.fileCategories.desc')
    )
  );
  for (const entry of FILE_TYPE_CONTROLS) {
    items.push({
      name: t(entry.nameKey),
      desc: t(entry.descKey),
      control: { type: 'toggle', key: entry.key },
    });
  }
  items.push(crudItem(plugin, refresh, 'filter'));

  // ─── Algorithm preset ────────────────────────────────────────────────────
  // The engine dropdown itself lives in the settings tab's resurfacing section
  // alongside grading, sensitivity and the FSRS parameters. Rendering it here
  // too would show the same row twice; this module owns *which* preset is
  // active, that one owns *what is in* it.
  items.push({
    name: t('presets.activeAlgorithm.name'),
    desc: t('presets.activeAlgorithm.desc'),
    control: {
      type: 'dropdown',
      key: 'activeAlgorithmPreset',
      options: nameOptions(library.algorithms),
    },
  });
  items.push(crudItem(plugin, refresh, 'algorithm'));

  // ─── Display preset ──────────────────────────────────────────────────────
  items.push({
    name: t('presets.activeDisplay.name'),
    desc: t('presets.activeDisplay.desc'),
    control: {
      type: 'dropdown',
      key: 'activeDisplayPreset',
      options: nameOptions(library.displays),
    },
  });
  items.push(crudItem(plugin, refresh, 'display'));

  // ─── Export / import ─────────────────────────────────────────────────────
  items.push(heading(t('presets.backup.title')));
  items.push(exportItem(plugin, 'library'));
  items.push(exportItem(plugin, 'filter'));
  items.push(exportItem(plugin, 'algorithm'));
  items.push(exportItem(plugin, 'display'));
  items.push(exportItem(plugin, 'total'));
  items.push(importItem(plugin, refresh));

  return items;
}
