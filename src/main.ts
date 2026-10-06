import { Plugin } from 'obsidian';
import {
  FSRS_DEFAULT_TUNABLES,
  isLanguage,
  normalizeMaximumInterval,
  normalizeRetention,
  type AlgorithmPreset,
  type DisplayPreset,
  type FilterPreset,
  type PluginData,
  type PluginSettings,
  type Rating,
  type StoredNotePreview,
} from './types';
import {
  activeAlgorithm,
  activeDisplay,
  activeFilter,
  ensureLibrary,
  idsForTotal,
  libraryFromUnknownLegacy,
  resolveActiveIds,
} from './presets';
import { DEFAULT_SETTINGS, IntelliScrollSettingTab } from './settings';
import { setLanguage } from './i18n';
import { NoteOverlay } from './noteOverlay';
import { Indexer } from './indexer';
import { SrsStore, logSrsError } from './srsLog';
import { IntelliScrollView, VIEW_TYPE_INTELLISCROLL } from './view';

const INDEX_FORMAT_VERSION = 3;

/** What this plugin used to ship as the interval cap, before it was lowered. */
const PREVIOUS_DEFAULT_MAXIMUM_INTERVAL = 365;

export default class IntelliScrollPlugin extends Plugin {
  data!: PluginData;
  indexer!: Indexer;
  /** Sidecar persistence for resurfacing state. */
  srsStore!: SrsStore;

  /**
   * Notes opened from the feed during this session.
   *
   * Session-scoped on purpose: the point is to rate a note *after* reading it,
   * so a marker that vanished the moment you navigated away would be useless.
   */
  private openedFromFeed = new Set<string>();
  private noteOverlay: NoteOverlay | null = null;

  /** Remember that this note was reached from the feed. */
  markOpenedFromFeed(path: string): void {
    this.openedFromFeed.add(path);
    this.noteOverlay?.refresh();
  }

  wasOpenedFromFeed(path: string): boolean {
    return this.openedFromFeed.has(path);
  }

  /**
   * Listeners told whenever a rating is written.
   *
   * A rating can be given from two places — a card in the feed and the floating
   * control in a note — and each must reflect what the other did. Without this
   * the button you did not press keeps showing the unrated state, which reads
   * as the rating not having been recorded.
   */
  private ratingListeners = new Set<(path: string, rating: Rating) => void>();

  onRatingWritten(listener: (path: string, rating: Rating) => void): () => void {
    this.ratingListeners.add(listener);
    return () => this.ratingListeners.delete(listener);
  }

  notifyRatingWritten(path: string, rating: Rating): void {
    this.lastRatings.set(path, rating);
    for (const listener of this.ratingListeners) listener(path, rating);
  }

  /**
   * The last rating given this session, so a control rebuilt later (a pane
   * remount, a re-rendered card) still shows what was chosen instead of
   * resetting to the unrated gauge.
   */
  private lastRatings = new Map<string, Rating>();

  lastRatingFor(path: string): Rating | null {
    return this.lastRatings.get(path) ?? null;
  }

  private settingsRefreshTimer: number | null = null;

  async onload(): Promise<void> {
    type LoadedPluginData = Omit<PluginData, 'settings'> & {
      settings?: Record<string, unknown>;
    };

    // Load data
    const loadedData = (await this.loadData()) as LoadedPluginData | null;
    const loadedSettings: Record<string, unknown> =
      loadedData?.settings && typeof loadedData.settings === 'object'
        ? loadedData.settings
        : {};

    let migrated = false;

    // Presets replaced the flat settings this fork used previously. Data with
    // no `presets` object is migrated from those flat fields into a single
    // "Default" preset, so an upgrade preserves the user's configuration.
    // `ensureLibrary` additionally repairs anything malformed, since this file
    // is hand-editable.
    const hadPresets = loadedSettings.presets !== undefined;
    const presets = ensureLibrary(
      hadPresets ? loadedSettings.presets : libraryFromUnknownLegacy(loadedSettings)
    );
    if (!hadPresets) migrated = true;

    // Bring stored FSRS tunables into range. This also moves the old default
    // cap of a year down to the current default: nobody chose 365, it was what
    // this plugin shipped with, so it should follow the default rather than
    // persist forever. Any other value is a deliberate setting and is kept —
    // the cap remains settable well above the default.
    let tunablesChanged = false;
    for (const preset of presets.algorithms) {
      const current = preset.fsrsTunables;
      const requestRetention = normalizeRetention(current.requestRetention);
      const maximumInterval =
        current.maximumInterval === PREVIOUS_DEFAULT_MAXIMUM_INTERVAL
          ? FSRS_DEFAULT_TUNABLES.maximumInterval
          : normalizeMaximumInterval(current.maximumInterval);
      const enableFuzz =
        typeof current.enableFuzz === 'boolean'
          ? current.enableFuzz
          : FSRS_DEFAULT_TUNABLES.enableFuzz;

      if (
        requestRetention !== current.requestRetention ||
        maximumInterval !== current.maximumInterval ||
        enableFuzz !== current.enableFuzz
      ) {
        preset.fsrsTunables = { requestRetention, maximumInterval, enableFuzz };
        tunablesChanged = true;
      }
    }
    if (tunablesChanged) migrated = true;

    const activeIds = resolveActiveIds(presets, loadedSettings);
    // A fresh migration lands on the "Default" preset in every group, so the
    // default composite describes exactly what is in force and should be shown
    // as active rather than leaving the user apparently on no preset at all.
    if (!hadPresets) activeIds.activeTotalPresetId = presets.totals[0]!.id;

    const settings: PluginSettings = {
      language: isLanguage(loadedSettings.language)
        ? loadedSettings.language
        : DEFAULT_SETTINGS.language,
      batchSize:
        typeof loadedSettings.batchSize === 'number' &&
        Number.isFinite(loadedSettings.batchSize) &&
        loadedSettings.batchSize > 0
          ? loadedSettings.batchSize
          : DEFAULT_SETTINGS.batchSize,
      infiniteScroll:
        typeof loadedSettings.infiniteScroll === 'boolean'
          ? loadedSettings.infiniteScroll
          : DEFAULT_SETTINGS.infiniteScroll,
      presets,
      ...activeIds,
    };

    // Point the translator before anything renders, so the very first paint is
    // already in the right language rather than flashing English.
    setLanguage(settings.language);

    this.data = {
      settings,
      previews: loadedData?.previews || {},
      history: loadedData?.history || [],
      indexFormatVersion: loadedData?.indexFormatVersion ?? 0,
    };

    // Migrate: earlier versions stored path/title/ctime on each preview
    // (duplicating the map key and an unused field) and kept imagePath as
    // an explicit null. Strip them so old vaults' data.json shrinks; the
    // index-format migration below also refreshes cached metadata once.
    type LegacyPreview = Omit<StoredNotePreview, 'imagePath'> & {
      path?: unknown;
      title?: unknown;
      ctime?: unknown;
      imagePath?: string | null;
    };

    for (const preview of Object.values(
      this.data.previews
    ) as LegacyPreview[]) {
      if (
        'path' in preview ||
        'title' in preview ||
        'ctime' in preview ||
        preview.imagePath === null ||
        'snippet' in preview
      ) {
        delete preview.path;
        delete preview.title;
        delete preview.ctime;
        if (preview.imagePath === null) {
          delete preview.imagePath;
        }
        if ('snippet' in preview) {
          // Legacy indexes used the snippet text to identify media-only
          // notes. Preserve that classification until the forced rebuild
          // below replaces the entry with the current metadata format.
          if (
            preview.snippet === '(no preview text)' ||
            /^📎 .+ attached$/.test(preview.snippet ?? '')
          ) {
            preview.mediaOnly = true;
          }
          // New metadata also considers piped embeds and code blocks, so do
          // not let an old mtime-valid entry bypass reclassification.
          preview.mtime = 0;
          delete preview.snippet;
        }
        migrated = true;
      }
    }

    if (this.data.indexFormatVersion !== INDEX_FORMAT_VERSION) {
      // Rebuild all cached metadata once. This also repairs data written by
      // the intermediate on-demand-preview migration, which removed legacy
      // snippets before mediaOnly classification was persisted.
      for (const preview of Object.values(this.data.previews)) {
        preview.mtime = 0;
      }
      this.data.indexFormatVersion = INDEX_FORMAT_VERSION;
      migrated = true;
    }

    if (migrated) {
      await this.saveSettings();
    }

    // Instantiate indexer. The filter is injected rather than read from
    // `data.settings` so that a session override made in the feed reaches the
    // index — filters are applied at index time, so the view alone could not
    // trigger the rebuild they require. Injection also keeps the indexer
    // testable without a full plugin.
    this.indexer = new Indexer(this.app, this.data, () => ({
      filter: this.getEffectiveFilter(),
      // Lives in the display preset, but decides how images are extracted, so
      // the index depends on it.
      frontmatterImageProps: this.getEffectiveDisplay().frontmatterImageProps,
    }));

    // Resurfacing state lives beside the plugin, not in data.json: appending a
    // line is O(1), whereas data.json is rewritten in full on every change and
    // drags the whole file through the sync chain each time.
    this.srsStore = new SrsStore(
      this.app.vault.adapter,
      `${this.app.vault.configDir}/plugins/${this.manifest.id}`
    );
    try {
      await this.srsStore.load();
    } catch (error) {
      // A broken sidecar must not stop the plugin loading. The feed still
      // works without scheduling; the failure is reported rather than hidden.
      logSrsError('resurfacing state unavailable; feed runs unscheduled', error);
    }

    // Register view
    this.registerView(
      VIEW_TYPE_INTELLISCROLL,
      (leaf) => new IntelliScrollView(leaf, this)
    );

    // Ribbon icon
    this.addRibbonIcon('gallery-vertical', 'Open feed', () => {
      void this.activateView();
    });

    // Command to open IntelliScroll
    this.addCommand({
      id: 'open-feed',
      name: 'Open feed',
      callback: () => {
        void this.activateView();
      },
    });

    // Settings tab
    this.addSettingTab(new IntelliScrollSettingTab(this.app, this));

    // The floating marker for notes reached from the feed. Both events matter:
    // switching panes and opening a file can each be the first moment the
    // marker becomes relevant.
    this.noteOverlay = new NoteOverlay(this);
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () =>
        this.noteOverlay?.refresh()
      )
    );
    this.registerEvent(
      this.app.workspace.on('file-open', () => this.noteOverlay?.refresh())
    );
  }

  async activateView(): Promise<void> {
    // Try to reuse existing leaf
    const existingLeaf = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_INTELLISCROLL
    )[0];

    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      const view = existingLeaf.view;
      if (view instanceof IntelliScrollView) {
        await view.refreshForCurrentSettings();
      }
      return;
    }

    // Create new leaf in main workspace
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_INTELLISCROLL,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  // ─── Effective configuration ─────────────────────────────────────────────
  //
  // The single source of truth for "which configuration is in force". Both the
  // indexer and the view read through these, so an override made in the feed is
  // visible to the index too. That matters because filters are applied at index
  // time: the view alone cannot trigger the rebuild they require.
  //
  // Session overrides are deliberately never persisted, so reopening the feed
  // returns to the saved presets.

  private sessionFilter: FilterPreset | null = null;
  private sessionAlgorithm: AlgorithmPreset | null = null;
  private sessionDisplay: DisplayPreset | null = null;

  getEffectiveFilter(): FilterPreset {
    if (this.sessionFilter) return this.sessionFilter;
    return activeFilter(
      this.data.settings.presets,
      this.data.settings.activeFilterPresetId
    );
  }

  getEffectiveAlgorithm(): AlgorithmPreset {
    if (this.sessionAlgorithm) return this.sessionAlgorithm;
    return activeAlgorithm(
      this.data.settings.presets,
      this.data.settings.activeAlgorithmPresetId
    );
  }

  getEffectiveDisplay(): DisplayPreset {
    if (this.sessionDisplay) return this.sessionDisplay;
    return activeDisplay(
      this.data.settings.presets,
      this.data.settings.activeDisplayPresetId
    );
  }

  hasSessionOverrides(): boolean {
    return (
      this.sessionFilter !== null ||
      this.sessionAlgorithm !== null ||
      this.sessionDisplay !== null
    );
  }

  hasSessionFilterOverride(): boolean {
    return this.sessionFilter !== null;
  }

  applySessionFilter(patch: Partial<FilterPreset>): void {
    this.sessionFilter = {
      ...structuredClone(this.getEffectiveFilter()),
      ...patch,
    };
  }

  applySessionAlgorithm(patch: Partial<AlgorithmPreset>): void {
    this.sessionAlgorithm = {
      ...structuredClone(this.getEffectiveAlgorithm()),
      ...patch,
    };
  }

  applySessionDisplay(patch: Partial<DisplayPreset>): void {
    this.sessionDisplay = {
      ...structuredClone(this.getEffectiveDisplay()),
      ...patch,
    };
  }

  clearSessionOverrides(): void {
    this.sessionFilter = null;
    this.sessionAlgorithm = null;
    this.sessionDisplay = null;
  }

  /**
   * Drop only the filter override.
   *
   * Selecting a saved filter preset must not also discard an algorithm tweak
   * the user is still experimenting with — they are independent knobs.
   */
  clearSessionFilterOverride(): void {
    this.sessionFilter = null;
  }

  /** Switch which saved preset is active. Leaves any session override alone. */
  async selectPreset(
    kind: 'filter' | 'algorithm' | 'display',
    id: string
  ): Promise<void> {
    if (kind === 'filter') {
      this.data.settings.activeFilterPresetId = id;
      // Discard that group's temporary override. Choosing a preset is an
      // explicit statement of what to apply; leaving an override in place would
      // mean clicking a preset changes what is saved but nothing the user can
      // see, which reads as the click having failed.
      this.sessionFilter = null;
    } else if (kind === 'algorithm') {
      this.data.settings.activeAlgorithmPresetId = id;
      this.sessionAlgorithm = null;
    } else {
      this.data.settings.activeDisplayPresetId = id;
      this.sessionDisplay = null;
    }

    // Choosing a group by hand means the composite no longer describes what is
    // in force.
    this.data.settings.activeTotalPresetId = null;
    await this.saveSettingsAndRefreshViews();
  }

  async selectTotalPreset(id: string | null): Promise<void> {
    if (id === null) {
      this.data.settings.activeTotalPresetId = null;
      await this.saveSettingsAndRefreshViews();
      return;
    }

    const ids = idsForTotal(this.data.settings.presets, id);
    if (!ids) return;

    // A composite names a preset in every group, so it supersedes any temporary
    // override — otherwise the override would silently outrank part of it.
    this.clearSessionOverrides();

    Object.assign(this.data.settings, ids, { activeTotalPresetId: id });
    await this.saveSettingsAndRefreshViews();
  }

  /**
   * Promote the temporary filter override into a saved preset.
   *
   * This is what the feed's save button does: an experiment made in the feed
   * becomes something the user can return to.
   */
  async saveSessionFilterAsPreset(name: string): Promise<string | null> {
    if (!this.sessionFilter) return null;
    const preset: FilterPreset = {
      ...structuredClone(this.sessionFilter),
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
    };
    this.data.settings.presets.filters.push(preset);
    this.data.settings.activeFilterPresetId = preset.id;
    this.data.settings.activeTotalPresetId = null;
    this.sessionFilter = null;
    await this.saveSettingsAndRefreshViews();
    return preset.id;
  }

  /**
   * Rebuild every open feed from scratch.
   *
   * Needed when something changes the *chrome* rather than the batch — the
   * normal settings refresh re-renders only the cards, so translated header
   * labels and aria-labels would otherwise stay in the previous language.
   */
  rebuildFeedViews(): void {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_INTELLISCROLL);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof IntelliScrollView) view.rebuildForLanguageChange();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.data);
  }

  async saveSettingsAndRefreshViews(): Promise<void> {
    await this.saveSettings();
    this.scheduleViewRefresh();
  }

  private scheduleViewRefresh(): void {
    if (this.settingsRefreshTimer !== null) {
      window.clearTimeout(this.settingsRefreshTimer);
    }

    this.settingsRefreshTimer = window.setTimeout(() => {
      this.settingsRefreshTimer = null;
      const views = this.app.workspace
        .getLeavesOfType(VIEW_TYPE_INTELLISCROLL)
        .map((leaf) => leaf.view)
        .filter((view): view is IntelliScrollView => view instanceof IntelliScrollView);

      void Promise.all(views.map((view) => view.refreshForCurrentSettings()));
    }, 250);
  }

  onunload(): void {
    this.noteOverlay?.destroy();
    this.noteOverlay = null;

    if (this.settingsRefreshTimer !== null) {
      window.clearTimeout(this.settingsRefreshTimer);
      this.settingsRefreshTimer = null;
    }
  }
}
