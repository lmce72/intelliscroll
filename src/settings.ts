import {
  App,
  PluginSettingTab,
  requireApiVersion,
  Setting,
  type SettingControl,
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
  fsrsRetentionWindow,
  normalizeIntervalUnit,
  normalizeRule,
  retentionBounds,
} from './presets';
import {
  buildPresetSettings,
  readPresetControl,
  writePresetControl,
} from './presetSettings';
import { setLanguage, t } from './i18n';
import { thresholdDemand, thresholdsFor } from './grading';
import {
  INTERVAL_UNITS,
  RETENTION_STEP,
  formatRetention,
} from './format';
import type { RetentionWindow } from './tiers';
import {
  TIER_COUNTS,
  TOP_GAP_DAYS_MAX,
  TOP_GAP_DAYS_MIN,
  isAlgorithmId,
  isGradingMode,
  isLanguage,
  isPreviewSize,
  isRuleMode,
  isSensitivity,
  normalizeMaximumInterval,
  normalizeRetention,
  normalizeTierCount,
  normalizeTopGapDays,
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
      // so a group's controls stay together and in one place to edit. The
      // tuning pass below interleaves the new scheduling/display knobs into
      // those groups rather than bolting a second copy of them on at the end.
      ...withTuning(
        this.plugin,
        buildPresetSettings(this.plugin, () => {
          this.refreshDeclarativeSettings();
        })
      ),
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
      intervalUnit: display.intervalUnit,
      tierCount: display.tierCount,
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
      sensitivityThresholds: algorithm.sensitivityThresholds,
      topGapDays: algorithm.topGapDays,
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
      case 'intervalUnit':
        return settings.intervalUnit;
      case 'tierCount':
        return String(settings.tierCount);
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
      case 'sensitivityCustomOpenedOnly':
        return thresholdsFor(
          settings.sensitivity,
          settings.sensitivityThresholds
        ).openedOnly;
      case 'sensitivityCustomEngagedMs':
        return thresholdsFor(
          settings.sensitivity,
          settings.sensitivityThresholds
        ).engagedMs;
      case 'topGapDays':
        return settings.topGapDays;
      case 'requestRetention':
        return settings.fsrsTunables.requestRetention;
      case 'maximumInterval':
        return settings.fsrsTunables.maximumInterval;
      case 'enableFuzz':
        return settings.fsrsTunables.enableFuzz;
      case 'enableShortTerm':
        return settings.fsrsTunables.enableShortTerm;
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
      case 'intervalUnit':
        display.intervalUnit = normalizeIntervalUnit(value);
        break;
      case 'tierCount':
        display.tierCount = normalizeTierCount(Number(value));
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
      case 'sensitivityCustomOpenedOnly': {
        if (typeof value !== 'boolean') return;
        const current = thresholdsFor(
          algorithm.sensitivity,
          algorithm.sensitivityThresholds
        );
        algorithm.sensitivityThresholds = { ...current, openedOnly: value };
        break;
      }
      case 'sensitivityCustomEngagedMs': {
        const engagedMs = Number(value);
        if (!Number.isFinite(engagedMs) || engagedMs < 0) return;
        const current = thresholdsFor(
          algorithm.sensitivity,
          algorithm.sensitivityThresholds
        );
        algorithm.sensitivityThresholds = { ...current, engagedMs };
        break;
      }
      case 'topGapDays':
        algorithm.topGapDays = normalizeTopGapDays(value);
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
      case 'enableShortTerm':
        if (typeof value !== 'boolean') return;
        algorithm.fsrsTunables = {
          ...algorithm.fsrsTunables,
          enableShortTerm: value,
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
   * written twice and the two drifted. The tuning controls added since
   * (sensitivity thresholds, the retention window, top gap, interval unit,
   * tier count) are declarative-only for the same reason: there is no
   * reachable legacy path to render them on. If the floor is ever lowered
   * again, recover the old implementation from git history rather than
   * rebuilding it from memory — and port the tuning controls then too.
   */
  display(): void {
    // Intentionally empty. See above.
  }

}

// ─── Tuning controls ───────────────────────────────────────────────────────
//
// The scheduling and display knobs the owner asked to expose. They are woven
// into the preset-manager output instead of appended as a second section, so
// the retention control replaces the preset manager's hardcoded slider and the
// custom sensitivity controls sit under the sensitivity dropdown they belong to.

type ControlItem = Extract<SettingDefinitionItem, { control: SettingControl }>;

/** Narrow an item to one that carries a control, for key-based replacement. */
function isControlItem(item: SettingDefinitionItem): item is ControlItem {
  return 'control' in item && item.control !== undefined;
}

/** The control's key, or null for items that carry no control. */
function controlKey(item: SettingDefinitionItem): string | null {
  return isControlItem(item) ? item.control.key : null;
}

/**
 * Cache the retention window by the inputs that determine it.
 *
 * The scan is cheap (~10ms) but runs on every render, and `update()` fires on
 * every save; caching keeps a slider drag from re-scanning per keystroke. The
 * cap stops a long experimentation session from leaking entries.
 */
const retentionWindowCache = new Map<string, RetentionWindow | null>();
const RETENTION_WINDOW_CACHE_MAX = 32;

function retentionWindowFor(plugin: IntelliScrollPlugin): RetentionWindow | null {
  const algorithm = plugin.getEffectiveAlgorithm();
  const display = plugin.getEffectiveDisplay();
  const key = [
    algorithm.fsrsTunables.maximumInterval,
    algorithm.topGapDays,
    display.tierCount,
  ].join('|');

  const cached = retentionWindowCache.get(key);
  if (cached !== undefined || retentionWindowCache.has(key)) {
    return retentionWindowCache.get(key) ?? null;
  }

  const window = fsrsRetentionWindow(
    algorithm.fsrsTunables,
    algorithm.topGapDays,
    display.tierCount
  );
  if (retentionWindowCache.size >= RETENTION_WINDOW_CACHE_MAX) {
    retentionWindowCache.clear();
  }
  retentionWindowCache.set(key, window);
  return window;
}

/** Format a millisecond threshold. UI-only, so it stays out of the pure modules. */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 s';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${trimNumber(seconds)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${trimNumber(minutes)} min`;
  return `${trimNumber(minutes / 60)} h`;
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The pieces that turn the preset manager's output into the full tuning UI.
 *
 * The declarative API keys controls by name, so the retention control has to
 * replace the preset manager's `requestRetention` item rather than be added
 * beside it — a second control with the same key would fight the first. The
 * same pass extends the sensitivity dropdown with `custom` and drops the
 * threshold editors in behind it.
 */
function withTuning(
  plugin: IntelliScrollPlugin,
  items: SettingDefinitionItem[]
): SettingDefinitionItem[] {
  const out: SettingDefinitionItem[] = [];

  for (const item of items) {
    const key = controlKey(item);

    if (key === 'sensitivity' && isControlItem(item)) {
      out.push(withCustomSensitivity(item, plugin));
      out.push(...customSensitivityItems(plugin));
      continue;
    }
    if (key === 'requestRetention') {
      out.push(retentionItem(plugin));
      continue;
    }

    out.push(item);
    if (key === 'maximumInterval') out.push(topGapDaysItem());
    if (key === 'enableFuzz') out.push(shortTermItem());
    if (key === 'previewSize') out.push(intervalUnitItem());
    if (key === 'openNoteBehavior') out.push(tierCountItem());
    if (key === 'reduceAnimations') out.push(readPromptItem());
  }

  return out;
}

/**
 * Add `custom` to the sensitivity dropdown and spell out what the active
 * preset actually demands.
 *
 * The thresholds are data, not branches, precisely so the page can show them —
 * a preset the user cannot inspect is a setting they cannot reason about. The
 * demand comes back as a tag and the wording is looked up here, so the sentence
 * is fully translated rather than half English on a Chinese page.
 */
function withCustomSensitivity(
  item: ControlItem,
  plugin: IntelliScrollPlugin
): ControlItem {
  const control = item.control;
  if (control.type !== 'dropdown') return item;

  const algorithm = plugin.getEffectiveAlgorithm();
  const demand = thresholdDemand(
    thresholdsFor(algorithm.sensitivity, algorithm.sensitivityThresholds)
  );
  const detail =
    demand.kind === 'openedOnly'
      ? t('settings.sensitivity.demand.openedOnly')
      : t('settings.sensitivity.demand.dwell', { time: formatMs(demand.ms) });
  const baseDesc =
    typeof item.desc === 'string'
      ? item.desc
      : t('settings.sensitivity.desc');

  return {
    ...item,
    desc: `${baseDesc} ${t('settings.sensitivity.effective', { detail })}`,
    control: {
      ...control,
      options: {
        ...control.options,
        custom: t('settings.sensitivity.option.custom'),
      },
    },
  };
}

/**
 * The two editable thresholds, shown only for `custom`.
 *
 * The dwell control is hidden while "opened only" is on because the grader
 * ignores dwell entirely in that mode — leaving an editable number that does
 * nothing would be worse than omitting it.
 */
function customSensitivityItems(
  plugin: IntelliScrollPlugin
): SettingDefinitionItem[] {
  const algorithm = plugin.getEffectiveAlgorithm();
  if (algorithm.sensitivity !== 'custom') return [];

  const thresholds = thresholdsFor('custom', algorithm.sensitivityThresholds);

  return [
    {
      name: t('settings.sensitivity.custom.openedOnly.name'),
      desc: t('settings.sensitivity.custom.openedOnly.desc'),
      control: { type: 'toggle', key: 'sensitivityCustomOpenedOnly' },
    },
    {
      name: t('settings.sensitivity.custom.engagedMs.name'),
      desc: t('settings.sensitivity.custom.engagedMs.desc'),
      visible: !thresholds.openedOnly,
      control: {
        type: 'number',
        key: 'sensitivityCustomEngagedMs',
        min: 0,
        step: 500,
      },
    },
  ];
}

/**
 * The retention control, bounded by the top-gap rule.
 *
 * The bounds come from `retentionBounds`, which falls back to the global range
 * when the rule admits nothing — a control with no valid range would lock the
 * user out. When the rule does produce a window, the row says so, and says when
 * the saved value sits outside it.
 */
function retentionItem(plugin: IntelliScrollPlugin): ControlItem {
  const algorithm = plugin.getEffectiveAlgorithm();
  const current = algorithm.fsrsTunables.requestRetention;
  const window = retentionWindowFor(plugin);
  const bounds = retentionBounds(window, current);

  const description = [t('settings.requestRetention.desc')];
  if (window) {
    description.push(
      t('settings.requestRetention.window', {
        min: formatRetention(window.min),
        max: formatRetention(window.max),
        gap: String(algorithm.topGapDays),
      })
    );
    if (bounds.outside) description.push(t('settings.requestRetention.outside'));
  } else {
    // No window exists at this maximum interval and top gap. Say so rather
    // than present a range that looks rule-derived but is not.
    description.push(
      t('settings.requestRetention.windowFallback', {
        gap: String(algorithm.topGapDays),
      })
    );
  }

  return {
    name: t('settings.requestRetention.name'),
    desc: description.join(' '),
    control: {
      type: 'slider',
      key: 'requestRetention',
      min: bounds.min,
      max: bounds.max,
      step: RETENTION_STEP,
      displayFormat: (value: number) => formatRetention(value),
    },
  };
}

function topGapDaysItem(): SettingDefinitionItem {
  return {
    name: t('settings.topGapDays.name'),
    desc: t('settings.topGapDays.desc'),
    control: {
      type: 'number',
      key: 'topGapDays',
      min: TOP_GAP_DAYS_MIN,
      max: TOP_GAP_DAYS_MAX,
      step: 1,
    },
  };
}

function intervalUnitItem(): SettingDefinitionItem {
  const options: Record<string, string> = {};
  for (const unit of INTERVAL_UNITS) {
    options[unit] = t(`settings.intervalUnit.option.${unit}`);
  }
  return {
    name: t('settings.intervalUnit.name'),
    desc: t('settings.intervalUnit.desc'),
    control: { type: 'dropdown', key: 'intervalUnit', options },
  };
}

function tierCountItem(): SettingDefinitionItem {
  const options: Record<string, string> = {};
  for (const count of TIER_COUNTS) {
    options[String(count)] = t('settings.tierCount.option', {
      count: String(count),
    });
  }
  return {
    name: t('settings.tierCount.name'),
    desc: t('settings.tierCount.desc'),
    control: { type: 'dropdown', key: 'tierCount', options },
  };
}

/**
 * The opt-in "offer the ratings once a note has been read" toggle.
 *
 * It lives with the display settings because it is about how the floating
 * control behaves, not about what gets scheduled. Default off: the prompt
 * expands under the reader's cursor, so turning it on is a choice they make,
 * never something an upgrade does to them.
 */
/**
 * The FSRS learning-steps switch — the only route to an interval below a day.
 *
 * Presented as a warning rather than a plain toggle, because switching it on
 * changes the feed's character: a note rated into the learning steps comes back
 * in a minute and again in ten, inside the same sitting. That is the point, but
 * it is not what the rest of the plugin does.
 */
function shortTermItem(): SettingDefinitionItem {
  return {
    name: t('settings.enableShortTerm.name'),
    desc: t('settings.enableShortTerm.desc'),
    control: { type: 'toggle', key: 'enableShortTerm' },
  };
}

function readPromptItem(): SettingDefinitionItem {
  return {
    name: t('settings.promptRatingAfterRead.name'),
    desc: t('settings.promptRatingAfterRead.desc'),
    control: { type: 'toggle', key: 'promptRatingAfterRead' },
  };
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
