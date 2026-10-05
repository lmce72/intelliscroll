import {
  AbstractInputSuggest,
  App,
  Notice,
  normalizePath,
  PluginSettingTab,
  requireApiVersion,
  Setting,
  type SettingDefinitionItem,
} from 'obsidian';
import DoomscrollPlugin from './main';
import { allAlgorithms } from './algorithms';
import {
  activeAlgorithm,
  activeDisplay,
  activeFilter,
  allowsStandaloneFiles,
  defaultLibrary,
  duplicatePreset,
  fileTypesAllowingStandalone,
  normalizeRule,
} from './presets';
import {
  FSRS_DEFAULT_TUNABLES,
  MAXIMUM_INTERVAL_MAX,
  MAXIMUM_INTERVAL_MIN,
  REQUEST_RETENTION_MAX,
  REQUEST_RETENTION_MIN,
  isAlgorithmId,
  isGradingMode,
  isPreviewSize,
  isRuleMode,
  isSensitivity,
  normalizeMaximumInterval,
  normalizeRetention,
  type AlgorithmPreset,
  type DisplayPreset,
  type FilterPreset,
  type PluginSettings,
} from './types';

/** Algorithm ids to display names, sourced from the registry itself. */
const ALGORITHM_OPTIONS: Record<string, string> = Object.fromEntries(
  allAlgorithms().map((algorithm) => [
    algorithm.id,
    algorithm.id === 'off' ? 'Off (shuffled feed)' : algorithm.label,
  ])
);

const GRADING_MODE_OPTIONS: Record<string, string> = {
  auto: 'Automatic only',
  hybrid: 'Automatic, with manual override',
  manual: 'Manual only',
};

const SENSITIVITY_OPTIONS: Record<string, string> = {
  conservative: 'Conservative',
  medium: 'Medium',
  aggressive: 'Aggressive',
};

const GITHUB_URL = 'https://github.com/lmce72/intelliscroll';
const ISSUES_URL = `${GITHUB_URL}/issues`;

class FolderSuggest extends AbstractInputSuggest<string> {
  inputEl: HTMLInputElement;
  private cachedFolders: string[] | null = null;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
  }

  private getFolders(): string[] {
    if (this.cachedFolders) return this.cachedFolders;

    this.cachedFolders = this.app.vault
      .getAllFolders()
      .map((folder) => folder.path)
      .filter((path) => path.length > 0);
    return this.cachedFolders;
  }

  getSuggestions(inputStr: string): string[] {
    const lowerInput = inputStr.toLowerCase();
    return this.getFolders().filter((path) =>
      path.toLowerCase().includes(lowerInput)
    );
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.setText(path);
  }

  selectSuggestion(path: string): void {
    this.inputEl.value = path;
    this.close();
  }
}

// Built once, so the active ids below refer to the very presets in this
// library rather than to freshly generated ones that would not resolve.
const DEFAULT_PRESETS = defaultLibrary();

/**
 * Only feed mechanics live here now; everything else is configuration and
 * belongs to a preset. `defaultLibrary()` supplies one of each group, whose
 * defaults are behaviour-preserving.
 */
export const DEFAULT_SETTINGS: PluginSettings = {
  batchSize: 20,
  infiniteScroll: false,
  presets: DEFAULT_PRESETS,
  activeFilterPresetId: DEFAULT_PRESETS.filters[0]!.id,
  activeAlgorithmPresetId: DEFAULT_PRESETS.algorithms[0]!.id,
  activeDisplayPresetId: DEFAULT_PRESETS.displays[0]!.id,
  activeTotalPresetId: DEFAULT_PRESETS.totals[0]!.id,
};

export class DoomscrollSettingTab extends PluginSettingTab {
  plugin: DoomscrollPlugin;

  constructor(app: App, plugin: DoomscrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: 'Doomscroll settings',
        render: (setting) => configureHeader(setting),
      },
      {
        name: 'Batch size',
        desc: 'Number of cards to show per reshuffle',
        control: {
          type: 'dropdown',
          key: 'batchSize',
          options: { '10': '10', '20': '20', '50': '50', '100': '100' },
          disabled: () => this.plugin.data.settings.infiniteScroll,
        },
      },
      {
        name: 'Infinite scrolling',
        desc: 'Automatically load more notes as you reach the end of the feed',
        control: { type: 'toggle', key: 'infiniteScroll' },
      },
      {
        name: 'Include media-only notes',
        desc: 'Show Markdown notes containing only images or other attachments',
        control: { type: 'toggle', key: 'includeMediaOnlyNotes' },
      },
      {
        name: 'Show non-Markdown files',
        desc: 'Show standalone vault files such as images, PDFs, and other attachments',
        control: { type: 'toggle', key: 'showNonMarkdownFiles' },
      },
      {
        name: 'Simplified view',
        desc: 'Show concise previews with readable tables, links, and code; turn off for full Markdown formatting.',
        control: { type: 'toggle', key: 'simplifiedView' },
      },
      {
        name: 'Reduce animation',
        desc: 'Disable card and scrolling animations during keyboard navigation',
        control: { type: 'toggle', key: 'reduceAnimations' },
      },
      {
        name: 'Preview size',
        desc: 'How many lines of note text to show on each card',
        control: {
          type: 'dropdown',
          key: 'previewSize',
          options: { small: 'Small', medium: 'Medium', large: 'Large' },
        },
      },
      {
        name: 'Search query',
        desc: 'Filter notes using Obsidian-style search syntax, such as tag:#work or [status:Draft]',
        control: {
          type: 'text',
          key: 'searchQuery',
          placeholder: 'tag:#work [status:Draft]',
        },
      },
      {
        name: 'Open notes in',
        desc: 'Choose where a card opens',
        control: {
          type: 'dropdown',
          key: 'openNoteBehavior',
          options: { tab: 'New tab', reuse: 'Reuse current tab', window: 'New window' },
        },
      },
      {
        name: 'Exclude tags',
        desc: 'Tags to skip without # (one per line)',
        control: { type: 'textarea', key: 'excludeTags' },
      },
      {
        name: 'Exclude filename patterns',
        desc: 'Filename patterns to skip (one per line, e.g., _*)',
        control: { type: 'textarea', key: 'excludeGlobs' },
      },
      {
        name: 'Frontmatter image properties',
        desc: 'Property names to check for images in frontmatter (one per line)',
        control: { type: 'textarea', key: 'frontmatterImageProps' },
      },
      {
        name: 'Frontmatter properties before preview',
        desc: 'Property names to render before the note body (one per line)',
        control: { type: 'textarea', key: 'frontmatterBeforeProps' },
      },
      {
        name: 'Frontmatter properties after preview',
        desc: 'Property names to render after the note body (one per line)',
        control: { type: 'textarea', key: 'frontmatterAfterProps' },
      },
      {
        name: 'Excluded folders',
        render: (setting) => {
          setting.setName('Excluded folders').setHeading();
          // Reuse the existing list if there is one. Obsidian re-runs render
          // callbacks on every settings update — and every save refreshes the
          // tab — while leaving whatever this callback appended to settingEl
          // in place. Creating a div unconditionally therefore stacked another
          // copy of the list on each change, so a single excluded folder would
          // appear once per save.
          const existing = setting.settingEl.querySelector(
            '.doomscroll-excluded-folders-list'
          );
          const list =
            existing instanceof HTMLElement
              ? existing
              : setting.settingEl.createDiv('doomscroll-excluded-folders-list');
          this.renderExcludedFolders(list);
        },
      },
      {
        name: 'Add excluded folder',
        desc: 'Folders to skip (type or choose a folder)',
        render: (setting) => {
          setting.setName('Add excluded folder').setDesc('Folders to skip (type or choose a folder)');
          let folderInputEl: HTMLInputElement | null = null;
          setting.addText((text) => {
            text.setPlaceholder('4. Archive');
            folderInputEl = text.inputEl;
            new FolderSuggest(this.app, text.inputEl);
          });
          setting.addButton((button) =>
            button.setButtonText('Add').onClick(() => {
              const folder = normalizeFolderPath(folderInputEl?.value ?? '');
              if (!folder || folder === '.') {
                new Notice('Excluded folder path cannot be empty or the vault root');
                return;
              }
              if (this.flatView().excludeFolders.includes(folder)) {
                new Notice('That folder is already excluded');
                return;
              }
              void this.addExcludedFolder(folder, folderInputEl);
            })
          );
        },
      },
      ...this.resurfacingSettings(),
      ...this.presetSettings(),
    ];
  }

  /**
   * Controls for the scheduling engine.
   *
   * Built conditionally because most of them only make sense for a particular
   * algorithm: a retention slider is meaningless for Leitner, and grading
   * controls are meaningless when nothing is being scheduled at all. Showing
   * them regardless would invite users to configure things that do nothing.
   */
  private resurfacingSettings(): SettingDefinitionItem[] {
    const settings = this.flatView();

    const items: SettingDefinitionItem[] = [
      {
        name: 'Resurfacing',
        render: (setting) => {
          setting.setName('Resurfacing').setHeading();
        },
      },
      {
        name: 'Algorithm',
        desc: 'Decide which notes resurface and when. Off keeps the original shuffled feed and writes nothing.',
        control: {
          type: 'dropdown',
          key: 'algorithm',
          options: ALGORITHM_OPTIONS,
        },
      },
    ];

    if (settings.algorithm === 'off') return items;

    items.push({
      name: 'Grading',
      desc: 'How a note gets rated as you scroll past it',
      control: {
        type: 'dropdown',
        key: 'gradingMode',
        options: GRADING_MODE_OPTIONS,
      },
    });

    if (settings.gradingMode !== 'manual') {
      items.push({
        name: 'Automatic grading sensitivity',
        desc: 'How much evidence counts as engagement. Only ever rates a note as engaged; it never records a failure.',
        control: {
          type: 'dropdown',
          key: 'sensitivity',
          options: SENSITIVITY_OPTIONS,
        },
      });
    }

    if (settings.algorithm === 'fsrs') {
      items.push(
        {
          name: 'Desired retention',
          desc: 'Target chance of still remembering a note when it returns. Higher means shorter intervals and many more reviews; 0.85-0.90 suits most people.',
          control: {
            type: 'slider',
            key: 'requestRetention',
            min: REQUEST_RETENTION_MIN,
            max: REQUEST_RETENTION_MAX,
            step: 0.01,
            displayFormat: (value: number) => value.toFixed(2),
          },
        },
        {
          name: 'Maximum interval',
          desc: 'Longest gap in days before a note is shown again',
          control: {
            type: 'number',
            key: 'maximumInterval',
            min: MAXIMUM_INTERVAL_MIN,
            max: MAXIMUM_INTERVAL_MAX,
            step: 1,
          },
        },
        {
          name: 'Fuzz due dates',
          desc: 'Spread due dates slightly so notes do not all return on the same day',
          control: { type: 'toggle', key: 'enableFuzz' },
        }
      );
    }

    return items;
  }

  /**
   * Preset management: choosing which preset is active, the per-dimension
   * blacklist/whitelist mode, and copying a preset to make an independent one.
   *
   * Deliberately not the full manager yet — creating, renaming and deleting
   * arbitrary presets, the file-type category editor, total presets and
   * export/import are still to come. What is here is enough to make the
   * per-dimension mode reachable and to use copy-on-inherit, which were the two
   * things the settings page could not do at all.
   */
  private presetSettings(): SettingDefinitionItem[] {
    const library = this.plugin.data.settings.presets;
    const filter = this.activeFilterPreset();

    const filterOptions: Record<string, string> = {};
    for (const preset of library.filters) filterOptions[preset.id] = preset.name;

    const modeOptions: Record<string, string> = {
      blacklist: 'Exclude these',
      whitelist: 'Only these',
    };

    const items: SettingDefinitionItem[] = [
      {
        name: 'Presets',
        render: (setting) => {
          setting.setName('Presets').setHeading();
        },
      },
      {
        name: 'Filter preset',
        desc: 'Which set of filters is in force. Editing the filter settings below changes this preset.',
        control: {
          type: 'dropdown',
          key: 'activeFilterPreset',
          options: filterOptions,
        },
      },
      {
        name: 'Folders',
        desc: 'How the excluded-folders list is read',
        control: {
          type: 'dropdown',
          key: 'folderMode',
          options: modeOptions,
        },
      },
      {
        name: 'Tags',
        desc: 'How the excluded-tags list is read',
        control: { type: 'dropdown', key: 'tagMode', options: modeOptions },
      },
      {
        name: 'Filename patterns',
        desc: 'How the excluded-patterns list is read',
        control: { type: 'dropdown', key: 'globMode', options: modeOptions },
      },
      {
        name: 'File types',
        desc: 'How the file-type list is read',
        control: { type: 'dropdown', key: 'fileTypeMode', options: modeOptions },
      },
      {
        name: 'Copy this filter preset',
        desc: 'Make an independent copy. Later changes to this one will not affect the copy, and vice versa.',
        render: (setting) => {
          setting.setName('Copy this filter preset');
          setting.setDesc(
            'Make an independent copy. Later changes to this one will not affect the copy, and vice versa.'
          );
          const existing = setting.settingEl.querySelector(
            '.doomscroll-copy-preset-btn'
          );
          const button =
            existing instanceof HTMLElement
              ? existing
              : setting.controlEl.createEl('button', {
                  cls: 'doomscroll-copy-preset-btn',
                });
          button.setText('Duplicate');
          button.onclick = () => {
            void this.duplicateActiveFilterPreset();
          };
        },
      },
    ];

    // Only meaningful while something is scheduled.
    void filter;
    return items;
  }

  private async duplicateActiveFilterPreset(): Promise<void> {
    const library = this.plugin.data.settings.presets;
    const result = duplicatePreset(
      library,
      'filter',
      this.plugin.data.settings.activeFilterPresetId
    );
    if (!result) return;

    // Switch to the copy, which is what "inherit as a new preset" should mean:
    // you asked for a variant, so you get to edit it immediately.
    this.plugin.data.settings.activeFilterPresetId = result.newId;
    this.plugin.data.settings.activeTotalPresetId = null;
    await this.plugin.saveSettingsAndRefreshViews();
    this.refreshDeclarativeSettings();
  }

  /** The active preset of each group — what the settings page edits. */
  private activeFilterPreset(): FilterPreset {
    return activeFilter(
      this.plugin.data.settings.presets,
      this.plugin.data.settings.activeFilterPresetId
    );
  }

  private activeAlgorithmPreset(): AlgorithmPreset {
    return activeAlgorithm(
      this.plugin.data.settings.presets,
      this.plugin.data.settings.activeAlgorithmPresetId
    );
  }

  private activeDisplayPreset(): DisplayPreset {
    return activeDisplay(
      this.plugin.data.settings.presets,
      this.plugin.data.settings.activeDisplayPresetId
    );
  }

  /**
   * A flat view shaped like the settings this fork used before presets, so the
   * controls that already exist keep working unchanged.
   *
   * Reads resolve through the *effective* configuration, so a temporary
   * override made in the feed is what the settings page shows. Writes
   * (`setControlValue`) target the *active presets*, since the settings page
   * edits what is saved rather than creating an override.
   *
   * `showNonMarkdownFiles` is derived: the standalone-file toggle is now the
   * file-type rule, and "nothing allowed" is how the old `false` is expressed.
   * Editing the rule's mode and categories directly belongs to the preset
   * manager UI; until then this toggle maps to the two whole-rule extremes.
   */
  private flatView() {
    const filter = this.plugin.getEffectiveFilter();
    const algorithm = this.plugin.getEffectiveAlgorithm();
    const display = this.plugin.getEffectiveDisplay();
    return {
      batchSize: this.plugin.data.settings.batchSize,
      infiniteScroll: this.plugin.data.settings.infiniteScroll,
      includeMediaOnlyNotes: filter.includeMediaOnlyNotes,
      showNonMarkdownFiles: allowsStandaloneFiles(filter.fileTypes),
      simplifiedView: display.simplifiedView,
      reduceAnimations: display.reduceAnimations,
      previewSize: display.previewSize,
      openNoteBehavior: display.openNoteBehavior,
      excludeFolders: filter.folders.values,
      excludeTags: filter.tags.values,
      excludeGlobs: filter.globs.values,
      searchQuery: filter.searchQuery,
      frontmatterImageProps: display.frontmatterImageProps,
      frontmatterBeforeProps: display.frontmatterBeforeProps,
      frontmatterAfterProps: display.frontmatterAfterProps,
      algorithm: algorithm.algorithm,
      gradingMode: algorithm.gradingMode,
      sensitivity: algorithm.sensitivity,
      fsrsTunables: algorithm.fsrsTunables,
    };
  }

  getControlValue(key: string): unknown {
    const settings = this.flatView();
    switch (key) {
      case 'batchSize':
        return String(settings.batchSize);
      case 'infiniteScroll':
        return settings.infiniteScroll;
      case 'includeMediaOnlyNotes':
        return settings.includeMediaOnlyNotes;
      case 'showNonMarkdownFiles':
        return settings.showNonMarkdownFiles;
      case 'simplifiedView':
        return settings.simplifiedView;
      case 'reduceAnimations':
        return settings.reduceAnimations;
      case 'previewSize':
        return settings.previewSize;
      case 'searchQuery':
        return settings.searchQuery;
      case 'openNoteBehavior':
        return settings.openNoteBehavior;
      case 'excludeTags':
        return settings.excludeTags.join('\n');
      case 'excludeGlobs':
        return settings.excludeGlobs.join('\n');
      case 'frontmatterImageProps':
        return settings.frontmatterImageProps.join('\n');
      case 'frontmatterBeforeProps':
        return settings.frontmatterBeforeProps.join('\n');
      case 'frontmatterAfterProps':
        return settings.frontmatterAfterProps.join('\n');
      case 'algorithm':
        return settings.algorithm;
      case 'gradingMode':
        return settings.gradingMode;
      case 'sensitivity':
        return settings.sensitivity;
      case 'requestRetention':
        return settings.fsrsTunables.requestRetention;
      case 'maximumInterval':
        return settings.fsrsTunables.maximumInterval;
      case 'enableFuzz':
        return settings.fsrsTunables.enableFuzz;
      case 'activeFilterPreset':
        return this.plugin.data.settings.activeFilterPresetId;
      case 'folderMode':
        return this.activeFilterPreset().folders.mode;
      case 'tagMode':
        return this.activeFilterPreset().tags.mode;
      case 'globMode':
        return this.activeFilterPreset().globs.mode;
      case 'fileTypeMode':
        return this.activeFilterPreset().fileTypes.mode;
      default:
        return undefined;
    }
  }

  /**
   * Write a control's value into the active preset group that owns it.
   *
   * The settings page edits what is *saved*; temporary overrides are the feed
   * header's job. Editing any group by hand means the active composite no
   * longer describes what is in force, so it is cleared — except for feed
   * mechanics, which belong to no group.
   */
  async setControlValue(key: string, value: unknown): Promise<void> {
    // Renamed to make it obvious this is the persisted root, not a preset.
    const rootSettings = this.plugin.data.settings;
    // These return the live presets, so mutating them mutates the library.
    const filter = this.activeFilterPreset();
    const algorithm = this.activeAlgorithmPreset();
    const display = this.activeDisplayPreset();

    switch (key) {
      case 'batchSize': {
        const batchSize = Number(value);
        if (![10, 20, 50, 100].includes(batchSize)) return;
        rootSettings.batchSize = batchSize;
        break;
      }
      case 'infiniteScroll':
        if (typeof value !== 'boolean') return;
        rootSettings.infiniteScroll = value;
        break;
      case 'includeMediaOnlyNotes':
        if (typeof value !== 'boolean') return;
        filter.includeMediaOnlyNotes = value;
        break;
      case 'showNonMarkdownFiles':
        if (typeof value !== 'boolean') return;
        // The whole-rule extremes of the file-type rule. Editing the rule's
        // mode and categories directly belongs to the preset manager UI.
        filter.fileTypes = fileTypesAllowingStandalone(value);
        break;
      case 'simplifiedView':
        if (typeof value !== 'boolean') return;
        display.simplifiedView = value;
        break;
      case 'reduceAnimations':
        if (typeof value !== 'boolean') return;
        display.reduceAnimations = value;
        break;
      case 'previewSize':
        if (!isPreviewSize(value)) return;
        display.previewSize = value;
        break;
      case 'searchQuery':
        if (typeof value !== 'string') return;
        filter.searchQuery = value;
        break;
      case 'openNoteBehavior':
        if (value !== 'tab' && value !== 'reuse' && value !== 'window') return;
        display.openNoteBehavior = value;
        break;
      case 'excludeTags':
        if (typeof value !== 'string') return;
        filter.tags = normalizeRule({
          mode: filter.tags.mode,
          values: parseLines(value),
        });
        break;
      case 'excludeGlobs':
        if (typeof value !== 'string') return;
        filter.globs = normalizeRule({
          mode: filter.globs.mode,
          values: parseLines(value),
        });
        break;
      case 'frontmatterImageProps':
        if (typeof value !== 'string') return;
        display.frontmatterImageProps = parseLines(value);
        break;
      case 'frontmatterBeforeProps':
        if (typeof value !== 'string') return;
        display.frontmatterBeforeProps = parseLines(value);
        break;
      case 'frontmatterAfterProps':
        if (typeof value !== 'string') return;
        display.frontmatterAfterProps = parseLines(value);
        break;
      case 'algorithm':
        if (!isAlgorithmId(value)) return;
        algorithm.algorithm = value;
        break;
      case 'gradingMode':
        if (!isGradingMode(value)) return;
        algorithm.gradingMode = value;
        break;
      case 'sensitivity':
        if (!isSensitivity(value)) return;
        algorithm.sensitivity = value;
        break;
      case 'requestRetention':
        algorithm.fsrsTunables = {
          ...algorithm.fsrsTunables,
          requestRetention: normalizeRetention(value),
        };
        break;
      case 'maximumInterval':
        algorithm.fsrsTunables = {
          ...algorithm.fsrsTunables,
          maximumInterval: normalizeMaximumInterval(value),
        };
        break;
      case 'enableFuzz':
        if (typeof value !== 'boolean') return;
        algorithm.fsrsTunables = {
          ...algorithm.fsrsTunables,
          enableFuzz: value,
        };
        break;
      case 'activeFilterPreset':
        if (typeof value !== 'string') return;
        // Already saves and refreshes, and clears the composite itself.
        await this.plugin.selectPreset('filter', value);
        this.refreshDeclarativeSettings();
        return;
      case 'folderMode':
        if (!isRuleMode(value)) return;
        filter.folders = { ...filter.folders, mode: value };
        break;
      case 'tagMode':
        if (!isRuleMode(value)) return;
        filter.tags = { ...filter.tags, mode: value };
        break;
      case 'globMode':
        if (!isRuleMode(value)) return;
        filter.globs = { ...filter.globs, mode: value };
        break;
      case 'fileTypeMode':
        if (!isRuleMode(value)) return;
        filter.fileTypes = { ...filter.fileTypes, mode: value };
        break;
      default:
        return;
    }

    if (key !== 'batchSize' && key !== 'infiniteScroll') {
      rootSettings.activeTotalPresetId = null;
    }

    await this.plugin.saveSettingsAndRefreshViews();
    this.refreshDeclarativeSettings();
  }

  private async addExcludedFolder(
    folder: string,
    inputEl: HTMLInputElement | null
  ): Promise<void> {
    this.flatView().excludeFolders.push(folder);
    await this.plugin.saveSettingsAndRefreshViews();
    if (inputEl) inputEl.value = '';
    this.refreshDeclarativeSettings();
  }

  private refreshDeclarativeSettings(): void {
    if (requireApiVersion('1.13.0')) {
      this.update();
    }
  }

  private async removeExcludedFolder(
    folder: string,
    container: HTMLElement
  ): Promise<void> {
    const index = this.flatView().excludeFolders.indexOf(folder);
    if (index === -1) return;
    this.flatView().excludeFolders.splice(index, 1);
    await this.plugin.saveSettingsAndRefreshViews();
    this.renderExcludedFolders(container);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.flatView();

    configureHeader(new Setting(containerEl));

    const batchSizeSetting = new Setting(containerEl)
      .setName('Batch size')
      .setDesc('Number of cards to show per reshuffle')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ '10': '10', '20': '20', '50': '50', '100': '100' })
          .setValue(String(this.plugin.data.settings.batchSize))
          .onChange(async (value) => {
            this.plugin.data.settings.batchSize = Number(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );
    batchSizeSetting.setDisabled(this.plugin.data.settings.infiniteScroll);

    new Setting(containerEl)
      .setName('Infinite scrolling')
      .setDesc('Automatically load more notes as you reach the end of the feed')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.data.settings.infiniteScroll)
          .onChange(async (value) => {
            this.plugin.data.settings.infiniteScroll = value;
            batchSizeSetting.setDisabled(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Include media-only notes')
      .setDesc('Show Markdown notes containing only images or other attachments')
      .addToggle((toggle) =>
        toggle
          .setValue(this.flatView().includeMediaOnlyNotes)
          .onChange(async (value) => {
            this.flatView().includeMediaOnlyNotes = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Show non-Markdown files')
      .setDesc('Show standalone vault files such as images, PDFs, and other attachments')
      .addToggle((toggle) =>
        toggle
          .setValue(this.flatView().showNonMarkdownFiles)
          .onChange(async (value) => {
            this.flatView().showNonMarkdownFiles = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Simplified view')
      .setDesc(
        'Show concise previews with readable tables, links, and code; turn off for full Markdown formatting.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.flatView().simplifiedView !== false)
          .onChange(async (value) => {
            this.flatView().simplifiedView = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Reduce animation')
      .setDesc('Disable card and scrolling animations during keyboard navigation')
      .addToggle((toggle) =>
        toggle
          .setValue(this.flatView().reduceAnimations)
          .onChange(async (value) => {
            this.flatView().reduceAnimations = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Preview size')
      .setDesc('How many lines of note text to show on each card')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            small: 'Small',
            medium: 'Medium',
            large: 'Large',
          })
          .setValue(this.flatView().previewSize)
          .onChange(async (value) => {
            if (!isPreviewSize(value)) return;
            this.flatView().previewSize = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Search query')
      .setDesc(
        'Filter notes using Obsidian-style search syntax, such as tag:#work or [status:Draft]'
      )
      .addText((text) =>
        text
          .setPlaceholder('tag:#work [status:Draft]')
          .setValue(this.flatView().searchQuery)
          .onChange(async (value) => {
            this.flatView().searchQuery = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Open notes in')
      .setDesc('Choose where a card opens')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            tab: 'New tab',
            reuse: 'Reuse current tab',
            window: 'New window',
          })
          .setValue(this.flatView().openNoteBehavior)
          .onChange(async (value) => {
            if (value !== 'tab' && value !== 'reuse' && value !== 'window') {
              return;
            }
            this.flatView().openNoteBehavior = value;
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Exclude tags')
      .setDesc('Tags to skip without # (one per line)')
      .addTextArea((text) =>
        text
          .setValue(this.flatView().excludeTags.join('\n'))
          .onChange(async (value) => {
            this.flatView().excludeTags = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Exclude filename patterns')
      .setDesc('Filename patterns to skip (one per line, e.g., _*)')
      .addTextArea((text) =>
        text
          .setValue(this.flatView().excludeGlobs.join('\n'))
          .onChange(async (value) => {
            this.flatView().excludeGlobs = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Frontmatter image properties')
      .setDesc(
        'Property names to check for images in frontmatter (one per line)'
      )
      .addTextArea((text) =>
        text
          .setValue(this.flatView().frontmatterImageProps.join('\n'))
          .onChange(async (value) => {
            this.flatView().frontmatterImageProps = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Frontmatter properties before preview')
      .setDesc(
        'Property names to render before the note body (one per line)'
      )
      .addTextArea((text) =>
        text
          .setPlaceholder('title\nsource\nauthor')
          .setValue(
            this.flatView().frontmatterBeforeProps.join('\n')
          )
          .onChange(async (value) => {
            this.flatView().frontmatterBeforeProps = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Frontmatter properties after preview')
      .setDesc(
        'Property names to render after the note body (one per line)'
      )
      .addTextArea((text) =>
        text
          .setPlaceholder('source\nauthor\npublished')
          .setValue(
            this.flatView().frontmatterAfterProps.join('\n')
          )
          .onChange(async (value) => {
            this.flatView().frontmatterAfterProps = parseLines(value);
            await this.plugin.saveSettingsAndRefreshViews();
          })
      );

    new Setting(containerEl).setName('Excluded folders').setHeading();

    const excludedFoldersList = containerEl.createDiv(
      'doomscroll-excluded-folders-list'
    );
    this.renderExcludedFolders(excludedFoldersList);

    let folderInputEl: HTMLInputElement;
    new Setting(containerEl)
      .setName('Add excluded folder')
      .setDesc('Folders to exclude from the feed')
      .addText((text) => {
        text.setPlaceholder('4. Archive');
        folderInputEl = text.inputEl;
        new FolderSuggest(this.app, folderInputEl);
      })
      .addButton((button) =>
        button.setButtonText('Add').onClick(async () => {
          const folder = normalizeFolderPath(folderInputEl.value);
          if (!folder || folder === '.') {
            new Notice('Excluded folder path cannot be empty or the vault root');
            return;
          }
          if (this.flatView().excludeFolders.includes(folder)) {
            new Notice('That folder is already excluded');
            return;
          }

          this.flatView().excludeFolders.push(folder);
          await this.plugin.saveSettingsAndRefreshViews();
          folderInputEl.value = '';
          this.renderExcludedFolders(excludedFoldersList);
        })
      );

    // ─── Resurfacing ─────────────────────────────────────────────────────────
    // Mirrors `resurfacingSettings()`. This path exists for Obsidian versions
    // that predate the declarative settings API; without it those users would
    // see no resurfacing controls at all.
    new Setting(containerEl).setName('Resurfacing').setHeading();

    new Setting(containerEl)
      .setName('Algorithm')
      .setDesc(
        'Decide which notes resurface and when. Off keeps the original shuffled feed and writes nothing.'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(ALGORITHM_OPTIONS)
          .setValue(settings.algorithm)
          .onChange(async (value) => {
            if (!isAlgorithmId(value)) return;
            settings.algorithm = value;
            await this.plugin.saveSettingsAndRefreshViews();
            // The controls below depend on the chosen algorithm, so the page
            // has to be rebuilt rather than merely re-read.
            this.display();
          })
      );

    if (settings.algorithm !== 'off') {
      new Setting(containerEl)
        .setName('Grading')
        .setDesc('How a note gets rated as you scroll past it')
        .addDropdown((dropdown) =>
          dropdown
            .addOptions(GRADING_MODE_OPTIONS)
            .setValue(settings.gradingMode)
            .onChange(async (value) => {
              if (!isGradingMode(value)) return;
              settings.gradingMode = value;
              await this.plugin.saveSettingsAndRefreshViews();
              this.display();
            })
        );

      if (settings.gradingMode !== 'manual') {
        new Setting(containerEl)
          .setName('Automatic grading sensitivity')
          .setDesc(
            'How much evidence counts as engagement. Only ever rates a note as engaged; it never records a failure.'
          )
          .addDropdown((dropdown) =>
            dropdown
              .addOptions(SENSITIVITY_OPTIONS)
              .setValue(settings.sensitivity)
              .onChange(async (value) => {
                if (!isSensitivity(value)) return;
                settings.sensitivity = value;
                await this.plugin.saveSettingsAndRefreshViews();
              })
          );
      }

      if (settings.algorithm === 'fsrs') {
        new Setting(containerEl)
          .setName('Desired retention')
          .setDesc(
            'Target chance of still remembering a note when it returns. Higher means shorter intervals and many more reviews; 0.85-0.90 suits most people.'
          )
          .addSlider((slider) =>
            slider
              .setLimits(REQUEST_RETENTION_MIN, REQUEST_RETENTION_MAX, 0.01)
              .setValue(settings.fsrsTunables.requestRetention)
              .setDynamicTooltip()
              .onChange(async (value) => {
                settings.fsrsTunables = {
                  ...settings.fsrsTunables,
                  requestRetention: normalizeRetention(value),
                };
                await this.plugin.saveSettingsAndRefreshViews();
              })
          );

        new Setting(containerEl)
          .setName('Maximum interval')
          .setDesc('Longest gap in days before a note is shown again')
          .addText((text) =>
            text
              .setValue(String(settings.fsrsTunables.maximumInterval))
              .onChange(async (value) => {
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) return;
                settings.fsrsTunables = {
                  ...settings.fsrsTunables,
                  maximumInterval: normalizeMaximumInterval(parsed),
                };
                await this.plugin.saveSettingsAndRefreshViews();
              })
          );

        new Setting(containerEl)
          .setName('Fuzz due dates')
          .setDesc(
            'Spread due dates slightly so notes do not all return on the same day'
          )
          .addToggle((toggle) =>
            toggle
              .setValue(settings.fsrsTunables.enableFuzz)
              .onChange(async (value) => {
                settings.fsrsTunables = {
                  ...settings.fsrsTunables,
                  enableFuzz: value,
                };
                await this.plugin.saveSettingsAndRefreshViews();
              })
          );
      }
    }
  }

  private renderExcludedFolders(container: HTMLElement): void {
    container.empty();

    if (this.flatView().excludeFolders.length === 0) {
      container.createDiv({ text: 'No excluded folders' });
      return;
    }

    for (const folder of this.flatView().excludeFolders) {
      const row = container.createDiv('doomscroll-excluded-folder-item');
      row.createSpan({ text: folder });
      row
        .createEl('button', {
          text: '×',
          cls: 'doomscroll-excluded-folder-remove',
          attr: { 'aria-label': `Remove excluded folder ${folder}` },
        })
        .addEventListener('click', () => {
          void this.removeExcludedFolder(folder, container);
        });
    }
  }

}

function configureHeader(setting: Setting): void {
  setting
    .setClass('doomscroll-settings-header')
    .setName('Doomscroll settings')
    .setHeading()
    .addButton((button) =>
      button.setButtonText('GitHub').onClick(() => {
        window.open(GITHUB_URL, '_blank');
      })
    )
    .addButton((button) =>
      button.setButtonText('Report issue').onClick(() => {
        window.open(ISSUES_URL, '_blank');
      })
    );
}

function parseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeFolderPath(value: string): string {
  return normalizePath(value.trim()).replace(/\/+$/, '');
}
