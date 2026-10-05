import { Plugin, normalizePath } from 'obsidian';
import {
  normalizeRetention,
  type AlgorithmPreset,
  type DisplayPreset,
  type FilterPreset,
  type PluginData,
  type PluginSettings,
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
import { DEFAULT_SETTINGS, DoomscrollSettingTab } from './settings';
import { Indexer } from './indexer';
import { SrsStore, logSrsError } from './srsLog';
import { DoomscrollView, VIEW_TYPE_DOOMSCROLL } from './view';

const INDEX_FORMAT_VERSION = 3;

export default class DoomscrollPlugin extends Plugin {
  data!: PluginData;
  indexer!: Indexer;
  /** Sidecar persistence for resurfacing state. */
  srsStore!: SrsStore;
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

    const activeIds = resolveActiveIds(presets, loadedSettings);
    // A fresh migration lands on the "Default" preset in every group, so the
    // default composite describes exactly what is in force and should be shown
    // as active rather than leaving the user apparently on no preset at all.
    if (!hadPresets) activeIds.activeTotalPresetId = presets.totals[0]!.id;

    const settings: PluginSettings = {
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
      VIEW_TYPE_DOOMSCROLL,
      (leaf) => new DoomscrollView(leaf, this)
    );

    // Ribbon icon
    this.addRibbonIcon('gallery-vertical', 'Open feed', () => {
      void this.activateView();
    });

    // Command to open Doomscroll
    this.addCommand({
      id: 'open-feed',
      name: 'Open feed',
      callback: () => {
        void this.activateView();
      },
    });

    // Settings tab
    this.addSettingTab(new DoomscrollSettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    // Try to reuse existing leaf
    const existingLeaf = this.app.workspace.getLeavesOfType(
      VIEW_TYPE_DOOMSCROLL
    )[0];

    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      const view = existingLeaf.view;
      if (view instanceof DoomscrollView) {
        await view.refreshForCurrentSettings();
      }
      return;
    }

    // Create new leaf in main workspace
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({
      type: VIEW_TYPE_DOOMSCROLL,
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
    if (kind === 'filter') this.data.settings.activeFilterPresetId = id;
    else if (kind === 'algorithm') this.data.settings.activeAlgorithmPresetId = id;
    else this.data.settings.activeDisplayPresetId = id;

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
        .getLeavesOfType(VIEW_TYPE_DOOMSCROLL)
        .map((leaf) => leaf.view)
        .filter((view): view is DoomscrollView => view instanceof DoomscrollView);

      void Promise.all(views.map((view) => view.refreshForCurrentSettings()));
    }, 250);
  }

  onunload(): void {
    if (this.settingsRefreshTimer !== null) {
      window.clearTimeout(this.settingsRefreshTimer);
      this.settingsRefreshTimer = null;
    }
  }
}
