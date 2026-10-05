import { Plugin, normalizePath } from 'obsidian';
import {
  FSRS_DEFAULT_TUNABLES,
  isAlgorithmId,
  isGradingMode,
  isPreviewSize,
  isSensitivity,
  normalizeMaximumInterval,
  normalizeRetention,
  PluginData,
  StoredNotePreview,
} from './types';
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
    type LegacySettings = PluginData['settings'] & {
      frontmatterDisplayProps?: unknown;
    };
    type LoadedPluginData = Omit<PluginData, 'settings'> & {
      settings?: LegacySettings;
    };

    // Load data
    const loadedData = (await this.loadData()) as LoadedPluginData | null;
    const loadedSettings = loadedData?.settings;
    const legacyDisplayProps = Array.isArray(
      loadedSettings?.frontmatterDisplayProps
    )
      ? loadedSettings.frontmatterDisplayProps.filter(
          (property): property is string => typeof property === 'string'
        )
      : [];
    const hasBeforeProps = Array.isArray(loadedSettings?.frontmatterBeforeProps);
    const hasAfterProps = Array.isArray(loadedSettings?.frontmatterAfterProps);
    const settings = {
      ...DEFAULT_SETTINGS,
      ...loadedSettings,
      frontmatterBeforeProps: hasBeforeProps
        ? loadedSettings?.frontmatterBeforeProps ?? []
        : [],
      frontmatterAfterProps: hasAfterProps
        ? loadedSettings?.frontmatterAfterProps ?? []
        : legacyDisplayProps,
    };
    delete (settings as LegacySettings).frontmatterDisplayProps;

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
    let migrated =
      loadedData?.settings !== undefined &&
      (!hasBeforeProps ||
        !hasAfterProps ||
        Boolean(
          loadedSettings && 'frontmatterDisplayProps' in loadedSettings
        ));
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

    const normalizedExcludedFolders = Array.from(
      new Set(
        this.data.settings.excludeFolders
          .map((folder) => normalizePath(folder.trim()).replace(/\/+$/, ''))
          .filter((folder) => folder.length > 0 && folder !== '.')
      )
    );
    if (
      JSON.stringify(normalizedExcludedFolders) !==
      JSON.stringify(this.data.settings.excludeFolders)
    ) {
      this.data.settings.excludeFolders = normalizedExcludedFolders;
      migrated = true;
    }

    if (!loadedData?.settings || !('simplifiedView' in loadedData.settings)) {
      migrated = true;
    }

    if (!loadedData?.settings || !('infiniteScroll' in loadedData.settings)) {
      migrated = true;
    }

    if (!loadedData?.settings || !('reduceAnimations' in loadedData.settings)) {
      migrated = true;
    }

    if (!isPreviewSize(this.data.settings.previewSize)) {
      this.data.settings.previewSize = 'medium';
      migrated = true;
    }

    // Resurfacing settings are read from disk and are also hand-editable, so
    // they get the same treatment as the older settings rather than being
    // trusted. A retention value outside its range would otherwise silently
    // produce nonsense intervals.
    if (!isAlgorithmId(this.data.settings.algorithm)) {
      this.data.settings.algorithm = DEFAULT_SETTINGS.algorithm;
      migrated = true;
    }

    if (!isGradingMode(this.data.settings.gradingMode)) {
      this.data.settings.gradingMode = DEFAULT_SETTINGS.gradingMode;
      migrated = true;
    }

    if (!isSensitivity(this.data.settings.sensitivity)) {
      this.data.settings.sensitivity = DEFAULT_SETTINGS.sensitivity;
      migrated = true;
    }

    const storedTunables = this.data.settings.fsrsTunables;
    if (!storedTunables || typeof storedTunables !== 'object') {
      this.data.settings.fsrsTunables = { ...FSRS_DEFAULT_TUNABLES };
      migrated = true;
    } else {
      const requestRetention = normalizeRetention(
        storedTunables.requestRetention
      );
      const maximumInterval = normalizeMaximumInterval(
        storedTunables.maximumInterval
      );
      const enableFuzz =
        typeof storedTunables.enableFuzz === 'boolean'
          ? storedTunables.enableFuzz
          : FSRS_DEFAULT_TUNABLES.enableFuzz;

      if (
        requestRetention !== storedTunables.requestRetention ||
        maximumInterval !== storedTunables.maximumInterval ||
        enableFuzz !== storedTunables.enableFuzz
      ) {
        this.data.settings.fsrsTunables = {
          requestRetention,
          maximumInterval,
          enableFuzz,
        };
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

    // Instantiate indexer
    this.indexer = new Indexer(this.app, this.data);

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
