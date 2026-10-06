import {
  App,
  PluginSettingTab,
  requireApiVersion,
  Setting,
  type SettingDefinitionItem,
} from 'obsidian';
import IntelliScrollPlugin from './main';
import {
  activeAlgorithm,
  activeDisplay,
  activeFilter,
  allowsStandaloneFiles,
  defaultLibrary,
  fileTypesAllowingStandalone,
  normalizeRule,
} from './presets';
import {
  buildPresetSettings,
  readPresetControl,
  writePresetControl,
} from './presetSettings';
import { setLanguage, t } from './i18n';
import {
  isAlgorithmId,
  isGradingMode,
  isLanguage,
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

const GITHUB_URL = 'https://github.com/lmce72/intelliscroll';
const ISSUES_URL = `${GITHUB_URL}/issues`;

// Built once, so the active ids below refer to the very presets in this
// library rather than to freshly generated ones that would not resolve.
const DEFAULT_PRESETS = defaultLibrary();

/**
 * Only feed mechanics live here now; everything else is configuration and
 * belongs to a preset. `defaultLibrary()` supplies one of each group, whose
 * defaults are behaviour-preserving.
 */
export const DEFAULT_SETTINGS: PluginSettings = {
  language: 'auto',
  batchSize: 20,
  infiniteScroll: false,
  presets: DEFAULT_PRESETS,
  activeFilterPresetId: DEFAULT_PRESETS.filters[0]!.id,
  activeAlgorithmPresetId: DEFAULT_PRESETS.algorithms[0]!.id,
  activeDisplayPresetId: DEFAULT_PRESETS.displays[0]!.id,
  activeTotalPresetId: DEFAULT_PRESETS.totals[0]!.id,
};

export class IntelliScrollSettingTab extends PluginSettingTab {
  plugin: IntelliScrollPlugin;

  constructor(app: App, plugin: IntelliScrollPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t('settings.header.title'),
        render: (setting) => configureHeader(setting),
      },
      {
        // Placed first: someone who cannot read the page needs this before
        // anything else on it.
        name: t('settings.language.name'),
        desc: t('settings.language.desc'),
        control: {
          type: 'dropdown',
          key: 'language',
          options: {
            auto: t('settings.language.option.auto'),
            en: t('settings.language.option.en'),
            zh: t('settings.language.option.zh'),
          },
        },
      },
      {
        name: t('settings.feed.title'),
        render: (setting) => {
          setting.setName(t('settings.feed.title')).setHeading();
        },
      },
      {
        name: t('settings.batchSize.name'),
        desc: t('settings.batchSize.desc'),
        control: {
          type: 'dropdown',
          key: 'batchSize',
          options: { '10': '10', '20': '20', '50': '50', '100': '100' },
          disabled: () => this.plugin.data.settings.infiniteScroll,
        },
      },
      {
        name: t('settings.infiniteScroll.name'),
        desc: t('settings.infiniteScroll.desc'),
        control: { type: 'toggle', key: 'infiniteScroll' },
      },
      // Everything from Presets down — the preset selectors, their values, their
      // modes and their manage rows — is emitted by the preset manager module,
      // so a group's controls stay together and in one place to edit.
      ...buildPresetSettings(this.plugin, () => {
        this.refreshDeclarativeSettings();
      }),
    ];
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

    // The preset manager owns its own keys so this file does not have to grow
    // a case per control it adds.
    const presetValue = readPresetControl(key, this.plugin);
    if (presetValue !== undefined) return presetValue;

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
      case 'language':
        return this.plugin.data.settings.language;
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
    // The preset manager owns its own keys. It reports whether it recognised
    // the key, so an unknown one falls through to the controls below.
    const handled = await writePresetControl(key, value, this.plugin, () => {
      this.refreshDeclarativeSettings();
    });
    if (handled) return;

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
      case 'language':
        if (!isLanguage(value)) return;
        rootSettings.language = value;
        // Point the translator before saving, so the refresh below re-renders
        // the page in the newly chosen language rather than the old one.
        setLanguage(value);
        // The feed's header labels are built once and are not touched by a
        // normal settings refresh, so they need an explicit rebuild.
        this.plugin.rebuildFeedViews();
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

  private refreshDeclarativeSettings(): void {
    if (requireApiVersion('1.13.0')) {
      this.update();
    }
  }

  /**
   * Required by Obsidian's abstract base class, but unreachable.
   *
   * Obsidian only calls this on versions below the declarative settings API,
   * and `minAppVersion` is 1.13.1, so those versions refuse to load the
   * plugin and this never runs.
   *
   * It used to hold a full second implementation of every setting, which had
   * to be updated by hand alongside the declarative one — every setting was
   * written twice and the two drifted. If the floor is ever lowered again,
   * recover it from git history rather than rebuilding it from memory.
   */
  display(): void {
    // Intentionally empty. See above.
  }

}

function configureHeader(setting: Setting): void {
  setting
    .setClass('intelliscroll-settings-header')
    .setName(t('settings.header.title'))
    .setHeading()
    .addButton((button) =>
      button.setButtonText('GitHub').onClick(() => {
        window.open(GITHUB_URL, '_blank');
      })
    )
    .addButton((button) =>
      button.setButtonText(t('settings.header.action.reportIssue')).onClick(() => {
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
