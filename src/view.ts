import {
  ItemView,
  Component,
  EventRef,
  Events,
  MarkdownRenderer,
  Menu,
  Platform,
  Scope,
  WorkspaceLeaf,
  TFile,
  setIcon,
} from 'obsidian';
import DoomscrollPlugin from './main';
import { preparePreviewMarkdown, prepareRenderedPreview } from './extract';
import {
  isPreviewSize,
  NotePreview,
  PreviewSize,
  toNotePreview,
  type AlgorithmId,
  type FsrsTunables,
  type GradingMode,
  type NoteSrsState,
  type Rating,
  type Sensitivity,
} from './types';
import { selectBatch } from './selector';
import { allAlgorithms, getAlgorithm } from './algorithms';
import { clampDwell, gradeEngagement, ratingForVerdict } from './grading';
import { SrsStore, logSrsError } from './srsLog';
import { passesFileTypeRule } from './filtering';
import { pickCardIndex } from './navigation';
import { ShortcutsModal } from './help';
import { recordView } from './history';
import { removePathFromBatches } from './batches';
import {
  attachmentLabel,
  isImagePath,
  isPdfPath,
  isVideoPath,
} from './media';

export const VIEW_TYPE_DOOMSCROLL = 'intelliscroll-view';
const HISTORY_SAVE_DELAY_MS = 2_000;

/** Icon shown on a card's rating button, per rating. */
const RATING_ICONS: Record<Rating, string> = {
  again: 'rotate-ccw',
  hard: 'minus',
  good: 'check',
  easy: 'zap',
};

const RATING_LABELS: Record<Rating, string> = {
  again: 'Again — I did not recall this',
  hard: 'Hard — recalled with difficulty',
  good: 'Good — recalled',
  easy: 'Easy — trivial',
};

const RATING_ORDER: readonly Rating[] = ['again', 'hard', 'good', 'easy'];
const MAX_BATCH_HISTORY = 20;
const MAX_RENDERED_SNIPPET_CACHE_ENTRIES = 100;
const MAX_IMAGE_DIMENSION_CACHE_ENTRIES = 200;
const MAX_CARD_SIZE_CACHE_ENTRIES = 200;
const INFINITE_SCROLL_CHUNK_SIZE = 20;
const PLUGIN_INDEX_READY_TIMEOUT_MS = 10_000;
const BASES_RENDER_TIMEOUT_MS = 3_000;
const PLUGIN_RENDER_QUIET_MS = 200;
const PLUGIN_RENDER_TIMEOUT_MS = 3_000;
interface ImageDimensions {
  width: number;
  height: number;
}

interface CardSize {
  height: number;
}

// Keep dimensions across Doomscroll view instances while the plugin is
// loaded. This lets a feed recreated by tab history reserve image space
// before lazy loading runs again.
const imageDimensionCache = new Map<string, ImageDimensions>();
const cardSizeCache = new Map<string, CardSize>();

interface AppWithSettings {
  setting: {
    open(): void;
    openTabById(id: string): void;
  };
}

interface DoomscrollViewState {
  batchPaths: string[];
  batchHistoryPaths: string[][];
  batchHistoryCursor: number;
  scrollTop: number;
  focusedPath: string | null;
  scrollAnchor: { path: string; topOffset: number } | null;
}

interface DataviewApiLike {
  index?: {
    initialized?: boolean;
    revision?: number;
  };
}

interface WindowWithDataviewApi extends Window {
  DataviewAPI?: DataviewApiLike;
}

export class DoomscrollView extends ItemView {
  plugin: DoomscrollPlugin;
  containerEl: HTMLElement;
  hasRendered: boolean = false;
  currentBatch: NotePreview[] = [];
  imageObserver: IntersectionObserver | null = null;
  pdfObserver: IntersectionObserver | null = null;
  videoObserver: IntersectionObserver | null = null;
  cardObserver: IntersectionObserver | null = null;
  private infiniteScrollObserver: IntersectionObserver | null = null;
  private infiniteScrollLoading = false;
  private infiniteScrollExhausted = false;
  viewedPathsInBatch: Set<string> = new Set();
  private imageLoadListeners = new WeakSet<HTMLImageElement>();
  batchHistory: NotePreview[][] = [];
  batchHistoryCursor: number = -1;
  backButton: HTMLButtonElement | null = null;
  private refreshStatusEl: HTMLElement | null = null;
  private isRefreshing = false;
  private pendingSettingsRefresh = false;
  private batchSettingsKey: string | null = null;
  private historySaveTimer: number | null = null;
  private historySavePending = false;
  private restoredScrollTop = 0;
  private restoredScrollAnchor: { path: string; topOffset: number } | null = null;
  private focusedPath: string | null = null;
  private scrollAnimationFrame: number | null = null;
  private renderedSnippetCache = new Map<string, HTMLElement>();
  private renderedSimplifiedView: boolean | null = null;
  private renderedPreviewSize: PreviewSize | null = null;
  private renderedFrontmatterPropertiesKey: string | null = null;
  private snippetRenderGenerations = new WeakMap<HTMLElement, number>();
  private isClosed = false;
  private pluginRefreshTimer: number | null = null;
  private pluginRefreshExcludePaths = new Set<string>();

  /**
   * Live tweaks made from the feed header.
   *
   * The overlay itself lives on the plugin (see `applySession`), because the
   * indexer has to see a filter change made here. Only the button reference is
   * kept locally, since the header is rebuilt on every render.
   */
  private tuneButton: HTMLButtonElement | null = null;

  /** Visible time accumulated per path for the current batch. */
  private dwell = new Map<string, { ms: number; opened: boolean }>();
  /** Paths currently intersecting, mapped to when they became visible. */
  private visibleSince = new Map<string, number>();

  constructor(leaf: WorkspaceLeaf, plugin: DoomscrollPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.containerEl = this.contentEl;
    this.registerKeyboardShortcuts();
    this.registerEvent(
      this.plugin.app.vault.on('modify', (file) => {
        if (file instanceof TFile) {
          if (isImagePath(file.path)) {
            invalidateImageCaches();
          }
          if (file.extension === 'base') {
            this.schedulePluginPreviewRefresh();
          }
        }
      })
    );
    this.registerEvent(
      this.plugin.app.vault.on('create', (file) => {
        if (file instanceof TFile) {
          // Make a newly added bare attachment visible on the next reshuffle.
          this.plugin.indexer.markDirty();
        }
      })
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file) => {
        void this.refreshModifiedCard(file);
        this.schedulePluginPreviewRefresh(file.path);
      })
    );
    const workspaceEvents = this.plugin.app.workspace as unknown as Events;
    this.registerEvent(
      workspaceEvents.on('dataview:refresh-views', () => {
        this.schedulePluginPreviewRefresh();
      })
    );
    this.registerEvent(
      this.plugin.app.vault.on('delete', (file) => {
        void this.removeDeletedNote(file.path);
      })
    );
  }

  private registerKeyboardShortcuts(): void {
    if (Platform.isMobile) return;

    // View-scoped, so the keys only apply while the feed has focus.
    const scope = this.scope ?? new Scope(this.app.scope);
    this.scope = scope;
    const bind = (keys: string[], action: () => void): void => {
      for (const key of keys) {
        scope.register([], key, () => {
          action();
          return false;
        });
      }
    };
    bind(['j', 'ArrowDown'], () => this.moveCardFocus(1));
    bind(['k', 'ArrowUp'], () => this.moveCardFocus(-1));
    bind(['Enter', 'o'], () => this.openFocusedCard());
    bind(['r'], () => void this.showNewBatch());
    bind(['p'], () => void this.showPreviousBatch());
    bind(['Home'], () => this.focusCardAt('first'));
    bind(['End'], () => this.focusCardAt('last'));
    bind(['Escape'], () => this.clearCardFocus());
    scope.register(['Shift'], '?', () => {
      new ShortcutsModal(this.app).open();
      return false;
    });
  }

  private moveCardFocus(delta: 1 | -1): void {
    const body = this.containerEl.querySelector<HTMLElement>('.doomscroll-body');
    const cards = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>('.doomscroll-card')
    );
    if (!body || cards.length === 0) return;

    const bodyRect = body.getBoundingClientRect();
    const next = pickCardIndex(
      cards.map((card) => card.getBoundingClientRect()),
      { top: bodyRect.top, bottom: bodyRect.bottom },
      cards.findIndex((card) =>
        card.classList.contains('doomscroll-card-focused')
      ),
      delta
    );

    this.focusCard(cards[next]!);
  }

  private focusCardAt(position: 'first' | 'last'): void {
    const cards = this.containerEl.querySelectorAll<HTMLElement>('.doomscroll-card');
    const target = position === 'first' ? cards[0] : cards[cards.length - 1];
    if (target) this.focusCard(target);
  }

  private clearCardFocus(): void {
    this.cancelScrollAnimation();
    this.containerEl
      .querySelector('.doomscroll-card-focused')
      ?.classList.remove('doomscroll-card-focused');
    this.focusedPath = null;
    this.containerEl
      .querySelector<HTMLElement>('.doomscroll-body')
      ?.focus({ preventScroll: true });
  }

  /** Marks a card as the keyboard cursor and scrolls it into view. */
  private focusCard(card: HTMLElement, scroll = true): void {
    this.containerEl
      .querySelector('.doomscroll-card-focused')
      ?.classList.remove('doomscroll-card-focused');
    card.classList.add('doomscroll-card-focused');
    this.focusedPath = card.dataset.path ?? null;
    // Real DOM focus lets screen readers follow the cursor.
    card.focus({ preventScroll: true });
    const reduceAnimations = this.plugin.getEffectiveDisplay().reduceAnimations;
    if (scroll) {
      if (reduceAnimations) {
        this.cancelScrollAnimation();
        card.classList.remove('doomscroll-card-navigating');
      } else {
        card.classList.remove('doomscroll-card-navigating');
        void card.offsetWidth;
        card.classList.add('doomscroll-card-navigating');
      }

      const body = this.containerEl.querySelector<HTMLElement>(
        '.doomscroll-body'
      );
      if (body) {
        const bodyTop = body.getBoundingClientRect().top + body.clientTop;
        const cardTop = card.getBoundingClientRect().top;
        const scrollMargin = Number.parseFloat(
          window.getComputedStyle(card).scrollMarginTop
        );
        const targetTop =
          body.scrollTop +
          cardTop -
          bodyTop -
          (Number.isFinite(scrollMargin) ? scrollMargin : 0);
        if (reduceAnimations) {
          this.cancelScrollAnimation();
          const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
          body.scrollTop = Math.max(0, Math.min(targetTop, maxScrollTop));
        } else {
          this.animateScrollTo(body, targetTop);
        }
      } else {
        card.scrollIntoView({
          block: 'start',
          behavior: reduceAnimations ? 'auto' : 'smooth',
        });
      }
    }
  }

  private animateScrollTo(
    body: HTMLElement,
    requestedTop: number
  ): void {
    this.cancelScrollAnimation();
    const maxScrollTop = Math.max(0, body.scrollHeight - body.clientHeight);
    const targetTop = Math.max(0, Math.min(requestedTop, maxScrollTop));
    const startTop = body.scrollTop;
    if (Math.abs(targetTop - startTop) < 1) {
      body.scrollTop = targetTop;
      return;
    }

    const startedAt = performance.now();
    const duration = 360;
    const step = (now: number): void => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      body.scrollTop = startTop + (targetTop - startTop) * eased;
      if (progress < 1) {
        this.scrollAnimationFrame = window.requestAnimationFrame(step);
      } else {
        this.scrollAnimationFrame = null;
      }
    };
    this.scrollAnimationFrame = window.requestAnimationFrame(step);
  }

  private cancelScrollAnimation(): void {
    if (this.scrollAnimationFrame !== null) {
      window.cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = null;
    }
  }

  private openFocusedCard(): void {
    this.containerEl
      .querySelector<HTMLElement>('.doomscroll-card-focused')
      ?.click();
  }

  getViewType(): string {
    return VIEW_TYPE_DOOMSCROLL;
  }

  getDisplayText(): string {
    return 'Doomscroll';
  }

  getIcon(): string {
    return 'gallery-vertical';
  }

  getState(): Record<string, unknown> {
    const body = this.containerEl.querySelector('.doomscroll-body');
    const scrollTop =
      body instanceof HTMLElement ? body.scrollTop : this.restoredScrollTop;

    return {
      batchPaths: this.currentBatch.map((preview) => preview.path),
      batchHistoryPaths: this.batchHistory.map((batch) =>
        batch.map((preview) => preview.path)
      ),
      batchHistoryCursor: this.batchHistoryCursor,
      scrollTop,
      focusedPath: this.focusedPath,
      scrollAnchor:
        body instanceof HTMLElement ? this.getScrollAnchor(body) : null,
    } satisfies DoomscrollViewState;
  }

  async setState(state: unknown): Promise<void> {
    const restored = parseViewState(state);
    if (!restored) return;

    const previousBatch = this.currentBatch;
    const previousPaths = previousBatch.map((preview) => preview.path);
    const restoredBatch = this.resolvePreviewPaths(restored.batchPaths);
    const canKeepRenderedDom =
      this.hasRendered &&
      previousPaths.length === restoredBatch.length &&
      previousPaths.every((path, index) => path === restoredBatch[index]?.path) &&
      Boolean(this.containerEl.querySelector('.doomscroll-body'));
    this.currentBatch = canKeepRenderedDom ? previousBatch : restoredBatch;
    this.batchHistory = restored.batchHistoryPaths
      .map((paths) => this.resolvePreviewPaths(paths))
      .filter((batch) => batch.length > 0)
      .slice(0, MAX_BATCH_HISTORY);
    this.batchHistoryCursor = Math.min(
      restored.batchHistoryCursor,
      this.batchHistory.length - 1
    );
    this.restoredScrollTop = restored.scrollTop;
    this.focusedPath = Platform.isMobile ? null : restored.focusedPath;
    this.restoredScrollAnchor = restored.scrollAnchor;
    this.batchSettingsKey = this.getBatchSettingsKey();

    if (this.hasRendered) {
      if (canKeepRenderedDom) {
        const body = this.containerEl.querySelector<HTMLElement>(
          '.doomscroll-body'
        );
        body
          ?.querySelector('.doomscroll-card-focused')
          ?.classList.remove('doomscroll-card-focused');
        const focused = this.focusedPath
          ? Array.from(
              body?.querySelectorAll<HTMLElement>('.doomscroll-card') ?? []
            ).find((card) => card.dataset.path === this.focusedPath)
          : undefined;
        if (focused) {
          focused.classList.add('doomscroll-card-focused');
          focused.focus({ preventScroll: true });
        } else if (this.focusedPath) {
          this.focusedPath = null;
        }
      } else {
        this.renderBatch();
        this.restoreScrollPosition();
      }
    }
  }

  async onOpen(): Promise<void> {
    this.isClosed = false;
    this.snippetRenderGenerations = new WeakMap();
    this.syncAnimationPreference();
    if (this.hasRendered && this.containerEl.querySelector('.doomscroll-body')) {
      this.resumeRenderedView();
      return;
    }
    await this.render();
  }

  private resumeRenderedView(): void {
    const body = this.containerEl.querySelector<HTMLElement>('.doomscroll-body');
    if (!body) return;

    // Keep the existing DOM, scroll position, and rendered previews when
    // Obsidian reopens this same view instance after same-tab navigation.
    this.cardObserver = this.createCardObserver(body);
    body.querySelectorAll<HTMLElement>('.doomscroll-card').forEach((card) => {
      const path = card.dataset.path;
      const snippet = card.querySelector<HTMLElement>(
        '.doomscroll-card-snippet'
      );
      if (
        !path ||
        !this.viewedPathsInBatch.has(path) ||
        snippet?.textContent === 'Loading preview…'
      ) {
        this.cardObserver?.observe(card);
      }
    });
    body.querySelectorAll<HTMLImageElement>('img[data-src]').forEach((image) => {
      if (image.getAttribute('src')) return;
      const preview = this.currentBatch.find(
        (candidate) => candidate.path === image.dataset.notePath
      );
      if (preview) {
        this.setupImageLazyLoad(image, getImageDimensionCacheKey(preview));
      }
    });
    body
      .querySelectorAll<HTMLIFrameElement>('.doomscroll-card-pdf')
      .forEach((pdf) => {
        if (!pdf.getAttribute('src')) this.setupPdfLazyLoad(pdf);
      });
    body
      .querySelectorAll<HTMLVideoElement>('.doomscroll-card-video')
      .forEach((video) => {
        if (!video.getAttribute('src')) this.setupVideoLazyLoad(video);
      });
    this.observeInfiniteScroll(body);

    if (this.focusedPath) {
      const focused = Array.from(
        body.querySelectorAll<HTMLElement>('.doomscroll-card')
      ).find((card) => card.dataset.path === this.focusedPath);
      if (focused) {
        focused.classList.add('doomscroll-card-focused');
        focused.focus({ preventScroll: true });
      }
    }
  }

  private syncAnimationPreference(): void {
    const reduceAnimations = this.plugin.getEffectiveDisplay().reduceAnimations;
    this.containerEl.classList.toggle(
      'doomscroll-reduce-animation',
      reduceAnimations
    );
    if (reduceAnimations) {
      this.cancelScrollAnimation();
      this.containerEl
        .querySelectorAll('.doomscroll-card-navigating')
        .forEach((card) => card.classList.remove('doomscroll-card-navigating'));
    }
  }

  async refreshForCurrentSettings(): Promise<void> {
    this.syncAnimationPreference();
    if (this.isRefreshing) {
      this.pendingSettingsRefresh = true;
      return;
    }

    this.setRefreshing(true);
    let indexRefreshed = false;
    let refreshFailed = false;
    try {
      indexRefreshed = await this.plugin.indexer.refreshIfStale();
      if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
        indexRefreshed =
          (await this.plugin.indexer.refreshIfStale()) || indexRefreshed;
      }
    } catch (error) {
      console.error('Error refreshing vault index:', error);
      refreshFailed = true;
    } finally {
      this.setRefreshing(false);
    }

    const settingsChanged =
      this.batchSettingsKey !== this.getBatchSettingsKey();
    const previewModeChanged =
      this.renderedSimplifiedView !== this.isSimplifiedView();
    const previewSizeChanged =
      this.renderedPreviewSize !== this.getPreviewSize();
    const frontmatterPropertiesChanged =
      this.renderedFrontmatterPropertiesKey !==
      this.getFrontmatterPropertiesKey();
    if (
      !refreshFailed &&
      (indexRefreshed ||
        settingsChanged ||
        previewModeChanged ||
        previewSizeChanged ||
        frontmatterPropertiesChanged)
    ) {
      if (indexRefreshed || settingsChanged) {
        this.currentBatch = [];
      }
      if (settingsChanged) {
        this.batchHistory = [];
        this.batchHistoryCursor = -1;
      } else if (indexRefreshed) {
        this.revalidateBatchHistory();
      } else if (previewModeChanged || previewSizeChanged) {
        if (previewModeChanged) {
          this.renderedSnippetCache.clear();
        }
        clearCardSizeCache();
      }

      if (this.hasRendered) {
        this.renderBatch();
        this.containerEl.querySelector('.doomscroll-body')?.scrollTo({ top: 0 });
      }
    }

    if (this.pendingSettingsRefresh) {
      this.pendingSettingsRefresh = false;
      await this.refreshForCurrentSettings();
    }
  }

  private async render(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass('doomscroll-view-container');
    this.syncAnimationPreference();

    // Header row
    const header = this.containerEl.createDiv('doomscroll-header');

    const title = header.createEl('h2');
    title.textContent = 'IntelliScroll';
    title.className = 'doomscroll-title';

    this.refreshStatusEl = header.createDiv('doomscroll-refresh-status');
    this.refreshStatusEl.setAttribute('aria-live', 'polite');
    const controls = header.createDiv('doomscroll-controls');

    // Reshuffle button (refresh icon)
    const reshuffleBtn = controls.createEl('button');
    reshuffleBtn.className = 'doomscroll-reshuffle-btn';
    reshuffleBtn.setAttribute('aria-label', 'Reshuffle');
    setIcon(reshuffleBtn, 'refresh-cw');
    reshuffleBtn.addEventListener('click', () => {
      void this.showNewBatch();
    });

    // Previous batch button
    this.backButton = controls.createEl('button');
    this.backButton.className = 'doomscroll-back-btn';
    this.backButton.setAttribute('aria-label', 'Previous card set');
    setIcon(this.backButton, 'arrow-left');
    this.backButton.addEventListener('click', () => {
      void this.showPreviousBatch();
    });
    this.updateBackButton();

    // Live tuning button. Opens a native menu so the feed can be adjusted
    // without leaving it; nothing chosen here is saved.
    const tuneBtn = controls.createEl('button');
    tuneBtn.className = 'doomscroll-tune-btn';
    setIcon(tuneBtn, 'sliders-horizontal');
    tuneBtn.addEventListener('click', (event) => {
      this.showTuningMenu(event);
    });
    this.tuneButton = tuneBtn;
    this.updateTuneButton();

    // Settings button
    const settingsBtn = controls.createEl('button');
    settingsBtn.className = 'doomscroll-settings-btn';
    settingsBtn.setAttribute('aria-label', 'Settings');
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      const { setting } = this.plugin.app as unknown as AppWithSettings;
      setting.open();
      setting.openTabById('intelliscroll');
    });

    // Body - scrollable container
    const bodyContainer = this.containerEl.createDiv('doomscroll-body');
    bodyContainer.setAttribute('role', 'feed');
    bodyContainer.setAttribute('aria-label', 'IntelliScroll');
    bodyContainer.tabIndex = 0;
    bodyContainer.addEventListener(
      'scroll',
      () => {
        this.restoredScrollTop = bodyContainer.scrollTop;
      },
      { passive: true }
    );
    bodyContainer.addEventListener(
      'wheel',
      () => this.cancelScrollAnimation(),
      { passive: true }
    );
    bodyContainer.addEventListener(
      'pointerdown',
      () => this.cancelScrollAnimation(),
      { passive: true }
    );

    // Refresh on every plugin session so a persisted index cannot outlive the
    // filters that were active when it was created. The indexer also detects
    // filter changes made while the plugin is running.
    const needsInitialIndex = Object.keys(this.plugin.data.previews).length === 0;
    const loadingEl = needsInitialIndex
      ? bodyContainer.createDiv('doomscroll-loading')
      : null;
    if (loadingEl) {
      loadingEl.textContent = 'Indexing your vault…';
    }

    let indexRefreshed = false;
    let indexRefreshSucceeded = false;
    this.setRefreshing(true);
    try {
      indexRefreshed = await this.plugin.indexer.refreshIfStale(
        (done, total) => {
          if (loadingEl) {
            loadingEl.textContent = `Indexed ${done}/${total}`;
          }
        },
        needsInitialIndex
      );
      indexRefreshSucceeded = true;
      if (indexRefreshed) {
        await this.plugin.saveSettings();
      }
    } catch (error) {
      console.error('Error indexing vault:', error);
      if (loadingEl) {
        loadingEl.textContent = 'Error indexing vault';
      }
    } finally {
      this.setRefreshing(false);
    }

    // A restored batch was built from the previous session's index and may
    // contain notes excluded by the current settings. Keep it when the index
    // check was a no-op so returning from a note preserves the same feed.
    if (indexRefreshSucceeded) {
      if (indexRefreshed) {
        if (this.currentBatch.length > 0) {
          this.currentBatch = this.resolvePreviewPaths(
            this.currentBatch.map((preview) => preview.path)
          );
          this.revalidateBatchHistory();
        } else {
          this.batchHistory = [];
          this.batchHistoryCursor = -1;
          this.batchSettingsKey = null;
        }
      }
    }
    loadingEl?.remove();

    // Render batch
    this.hasRendered = true;
    this.renderBatchIntoContainer(bodyContainer);
    this.restoreScrollPosition();
  }

  private resolvePreviewPaths(paths: readonly string[]): NotePreview[] {
    return paths.flatMap((path) => {
      const stored = this.plugin.data.previews[path];
      return stored ? [toNotePreview(path, stored)] : [];
    });
  }

  private restoreScrollPosition(): void {
    const scrollTop = this.restoredScrollTop;
    const restore = (): void => {
      const body = this.containerEl.querySelector('.doomscroll-body');
      if (body instanceof HTMLElement) {
        const anchor = this.restoredScrollAnchor;
        const anchorCard = anchor
          ? Array.from(
              body.querySelectorAll<HTMLElement>('.doomscroll-card')
            ).find((card) => card.dataset.path === anchor.path)
          : undefined;
        if (anchor && anchorCard) {
          const bodyTop = body.getBoundingClientRect().top;
          const cardTop = anchorCard.getBoundingClientRect().top;
          body.scrollTop += cardTop - bodyTop - anchor.topOffset;
        } else {
          body.scrollTop = scrollTop;
        }
      }
    };

    restore();
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(() => {
        restore();
        window.setTimeout(restore, 100);
        window.setTimeout(restore, 350);
        window.setTimeout(restore, 800);
      });
    });
  }

  private getScrollAnchor(
    body: HTMLElement
  ): { path: string; topOffset: number } | null {
    const bodyTop = body.getBoundingClientRect().top;
    const bodyBottom = bodyTop + body.clientHeight;
    for (const card of Array.from(
      body.querySelectorAll<HTMLElement>('.doomscroll-card')
    )) {
      const rect = card.getBoundingClientRect();
      if (rect.bottom > bodyTop && rect.top < bodyBottom) {
        const path = card.dataset.path;
        if (path) return { path, topOffset: rect.top - bodyTop };
      }
    }
    return null;
  }

  private renderBatchIntoContainer(
    container: HTMLElement,
    previousOrder?: readonly string[]
  ): void {
    // Get fresh batch if not already loaded
    if (this.currentBatch.length === 0) {
      const candidates = Object.entries(this.plugin.data.previews)
        .map(([path, stored]) => toNotePreview(path, stored))
        .filter(
          (preview) => this.shouldIncludePreview(preview)
        );
      this.currentBatch = selectBatch(
        candidates,
        this.plugin.data.history,
        this.plugin.data.settings.infiniteScroll
          ? INFINITE_SCROLL_CHUNK_SIZE
          : this.plugin.data.settings.batchSize,
        Date.now(),
        {
          algorithm: this.effectiveAlgorithm(),
          states: this.effectiveStates(),
        }
      );
      this.batchSettingsKey = this.getBatchSettingsKey();
      if (
        previousOrder &&
        this.currentBatch.length > 1 &&
        hasSameOrder(this.currentBatch, previousOrder)
      ) {
        [this.currentBatch[0], this.currentBatch[1]] = [
          this.currentBatch[1]!,
          this.currentBatch[0]!,
        ];
      }
      this.batchHistory.unshift(this.currentBatch);
      this.batchHistory.length = Math.min(
        this.batchHistory.length,
        MAX_BATCH_HISTORY
      );
      this.batchHistoryCursor = 0;
    }

    this.renderedSimplifiedView = this.isSimplifiedView();
    this.renderedPreviewSize = this.getPreviewSize();
    this.renderedFrontmatterPropertiesKey = this.getFrontmatterPropertiesKey();
    this.updateBackButton();

    // Finalise the outgoing batch's dwell before its cards are torn down.
    this.flushEngagement();

    // Stop observing cards from the previous batch before replacing them.
    this.cardObserver?.disconnect();
    this.infiniteScrollObserver?.disconnect();
    this.infiniteScrollObserver = null;
    this.infiniteScrollLoading = false;
    this.infiniteScrollExhausted = false;
    this.viewedPathsInBatch.clear();

    this.cardObserver = this.createCardObserver(container);

    // Clear previous content
    container.empty();

    // Render cards
    for (const preview of this.currentBatch) {
      const card = this.renderCard(container, preview);
      this.cardObserver.observe(card);
    }

    // Keep the keyboard cursor on the same card across re-renders (e.g. coming
    // back from an opened note); a different batch simply has no match.
    const restored = this.focusedPath
      ? Array.from(
          container.querySelectorAll<HTMLElement>('.doomscroll-card')
        ).find((card) => card.dataset.path === this.focusedPath)
      : undefined;
    if (restored) {
      restored.classList.add('doomscroll-card-focused');
      restored.focus({ preventScroll: true });
    } else {
      this.focusedPath = null;
    }

    // Reshuffle button at end
    const reshuffleSection = container.createDiv(
      'doomscroll-reshuffle-section'
    );
    const reshuffleBtn = reshuffleSection.createEl('button');
    reshuffleBtn.className = 'doomscroll-reshuffle-end-btn';
    reshuffleBtn.textContent = 'Reshuffle';
    reshuffleBtn.dataset.defaultLabel = 'Reshuffle';
    reshuffleBtn.addEventListener('click', () => {
      void this.showNewBatch();
    });

    if (this.plugin.data.settings.infiniteScroll) {
      const sentinel = container.createDiv('doomscroll-infinite-scroll-sentinel');
      this.observeInfiniteScroll(container, sentinel);
    }
  }

  // The session overlay lives on the plugin now, so that a filter change made
  // in the feed is visible to the indexer — filtering happens at index time,
  // and the view alone could not trigger the rebuild it needs. These delegate
  // rather than keeping a second copy.

  private effectiveAlgorithm(): AlgorithmId {
    return this.plugin.getEffectiveAlgorithm().algorithm;
  }

  private effectiveGradingMode(): GradingMode {
    return this.plugin.getEffectiveAlgorithm().gradingMode;
  }

  private effectiveSensitivity(): Sensitivity {
    return this.plugin.getEffectiveAlgorithm().sensitivity;
  }

  private effectiveTunables(): FsrsTunables {
    return this.plugin.getEffectiveAlgorithm().fsrsTunables;
  }

  /**
   * Reflect whether live tweaks are in force.
   *
   * Uses Obsidian's global `mod-cta` class rather than a new style rule, so
   * the button needs no bespoke CSS to signal "you are not on your saved
   * settings".
   */
  private updateTuneButton(): void {
    if (!this.tuneButton) return;
    const active = this.hasSessionOverrides();
    this.tuneButton.toggleClass('mod-cta', active);
    const label = active
      ? 'Tune resurfacing (temporary changes active)'
      : 'Tune resurfacing';
    this.tuneButton.setAttribute('aria-label', label);
    this.tuneButton.setAttribute('title', label);
  }

  private hasSessionOverrides(): boolean {
    return this.plugin.hasSessionOverrides();
  }

  /**
   * Adjust the scheduler for this session only.
   *
   * The overlay lives on the plugin so the indexer can see it too; nothing here
   * is persisted, so the header stays safe to experiment in and reopening the
   * feed restores the saved presets.
   */
  private applySession(patch: {
    algorithm?: AlgorithmId;
    gradingMode?: GradingMode;
    sensitivity?: Sensitivity;
    tunables?: Partial<FsrsTunables>;
    reset?: boolean;
  }): void {
    if (patch.reset) {
      this.plugin.clearSessionOverrides();
    }
    if (patch.algorithm !== undefined) {
      this.plugin.applySessionAlgorithm({ algorithm: patch.algorithm });
    }
    if (patch.gradingMode !== undefined) {
      this.plugin.applySessionAlgorithm({ gradingMode: patch.gradingMode });
    }
    if (patch.sensitivity !== undefined) {
      this.plugin.applySessionAlgorithm({ sensitivity: patch.sensitivity });
    }
    if (patch.tunables !== undefined) {
      this.plugin.applySessionAlgorithm({
        fsrsTunables: { ...this.effectiveTunables(), ...patch.tunables },
      });
    }

    this.updateTuneButton();

    // The batch on screen was chosen under the previous rules. Clearing the key
    // routes this through the existing settings-change path, which re-rolls the
    // batch and drops the back stack.
    this.batchSettingsKey = null;
    void this.refreshForCurrentSettings();
  }

  /**
   * The live-tuning menu.
   *
   * A flat menu with labelled sections rather than nested submenus, because
   * `MenuItem.setSubmenu` is not part of the public Obsidian API. Using a menu
   * keeps everything on native styling, which matters on mobile.
   */
  private showTuningMenu(event: MouseEvent): void {
    const menu = new Menu();
    const algorithm = this.effectiveAlgorithm();
    const gradingMode = this.effectiveGradingMode();

    menu.addItem((item) => item.setTitle('Algorithm').setIsLabel(true));
    for (const candidate of allAlgorithms()) {
      menu.addItem((item) =>
        item
          .setTitle(candidate.id === 'off' ? 'Off (shuffled feed)' : candidate.label)
          .setChecked(algorithm === candidate.id)
          .onClick(() => this.applySession({ algorithm: candidate.id }))
      );
    }

    if (algorithm !== 'off') {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle('Grading').setIsLabel(true));
      const gradingOptions: Array<[GradingMode, string]> = [
        ['auto', 'Automatic only'],
        ['hybrid', 'Automatic, with manual override'],
        ['manual', 'Manual only'],
      ];
      for (const [id, label] of gradingOptions) {
        menu.addItem((item) =>
          item
            .setTitle(label)
            .setChecked(gradingMode === id)
            .onClick(() => this.applySession({ gradingMode: id }))
        );
      }

      if (gradingMode !== 'manual') {
        menu.addSeparator();
        menu.addItem((item) =>
          item.setTitle('Auto-grading sensitivity').setIsLabel(true)
        );
        const sensitivityOptions: Array<[Sensitivity, string]> = [
          ['conservative', 'Conservative'],
          ['medium', 'Medium'],
          ['aggressive', 'Aggressive'],
        ];
        for (const [id, label] of sensitivityOptions) {
          menu.addItem((item) =>
            item
              .setTitle(label)
              .setChecked(this.effectiveSensitivity() === id)
              .onClick(() => this.applySession({ sensitivity: id }))
          );
        }
      }

      if (algorithm === 'fsrs') {
        const tunables = this.effectiveTunables();
        menu.addSeparator();
        menu.addItem((item) =>
          item.setTitle('Desired retention').setIsLabel(true)
        );
        for (const retention of [0.8, 0.85, 0.9, 0.95]) {
          menu.addItem((item) =>
            item
              .setTitle(retention.toFixed(2))
              .setChecked(
                Math.abs(tunables.requestRetention - retention) < 0.001
              )
              .onClick(() =>
                this.applySession({
                  tunables: { requestRetention: retention },
                })
              )
          );
        }

        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle('Fuzz due dates')
            .setChecked(tunables.enableFuzz)
            .onClick(() =>
              this.applySession({
                tunables: { enableFuzz: !tunables.enableFuzz },
              })
            )
        );
      }
    }

    if (this.hasSessionOverrides()) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle('Reset to saved settings')
          .setIcon('rotate-ccw')
          .onClick(() => this.applySession({ reset: true }))
      );
    }

    menu.showAtMouseEvent(event);
  }

  /**
   * Per-note scheduling state, or undefined when nothing is being scheduled.
   * Returning undefined is what makes `selectBatch` fall back to the original
   * shuffle, so a missing store degrades instead of breaking.
   */
  private effectiveStates():
    | Readonly<Record<string, NoteSrsState>>
    | undefined {
    if (this.effectiveAlgorithm() === 'off') return undefined;
    if (!this.plugin.srsStore?.isLoaded) return undefined;
    return this.plugin.srsStore.getStates();
  }

  private markCardVisible(path: string): void {
    if (this.visibleSince.has(path)) return;
    this.visibleSince.set(path, Date.now());
    if (!this.dwell.has(path)) this.dwell.set(path, { ms: 0, opened: false });
  }

  private markCardHidden(path: string): void {
    const since = this.visibleSince.get(path);
    if (since === undefined) return;
    this.visibleSince.delete(path);

    // Timestamps rather than frame counting: requestAnimationFrame stops
    // firing while a pane is hidden in this vault, so accumulating frames
    // would report hours of dwell for a pane that was switched away from.
    const entry = this.dwell.get(path) ?? { ms: 0, opened: false };
    entry.ms = clampDwell(entry.ms + (Date.now() - since));
    this.dwell.set(path, entry);
  }

  /** Record that the user opened this card, the strongest signal available. */
  private markCardOpened(path: string): void {
    const entry = this.dwell.get(path) ?? { ms: 0, opened: false };
    entry.opened = true;
    this.dwell.set(path, entry);
  }

  /**
   * Turn accumulated dwell into reviews, then reset.
   *
   * Called before a batch is replaced and when the view closes, so the last
   * visible stretch of a card is not lost.
   */
  private flushEngagement(): void {
    const algorithm = this.effectiveAlgorithm();
    const samples = Array.from(this.dwell.entries());
    const now = Date.now();

    this.dwell.clear();
    this.visibleSince.clear();

    if (algorithm === 'off') return;
    // Manual grading records only explicit ratings, never observed behaviour.
    if (this.effectiveGradingMode() === 'manual') return;
    if (!this.plugin.srsStore?.isLoaded) return;
    if (!getAlgorithm(algorithm).schedules) return;

    for (const [path, sample] of samples) {
      const verdict = gradeEngagement(
        { opened: sample.opened, dwellMs: sample.ms },
        this.effectiveSensitivity()
      );
      void this.recordEngagement(path, verdict, algorithm, now);
    }
  }

  private async recordEngagement(
    path: string,
    verdict: 'engaged' | 'unengaged',
    algorithm: AlgorithmId,
    now: number
  ): Promise<void> {
    try {
      const rating = ratingForVerdict(verdict);
      if (rating === null) {
        // A skip is the absence of a review: no schedule change, only
        // priority, so it comes back around sooner.
        await this.plugin.srsStore.recordUnengaged(path, now, algorithm);
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      const content = await this.app.vault.cachedRead(file);

      await this.plugin.srsStore.recordReview(
        {
          path,
          rating,
          algorithm,
          source: 'auto',
          hash: SrsStore.hashContent(content),
          now,
          tunables: this.effectiveTunables(),
        },
        getAlgorithm(algorithm)
      );
    } catch (error) {
      // A scheduling failure must never break the feed.
      logSrsError(`failed to record engagement for ${path}`, error);
    }
  }

  /** Whether the feed should offer a manual rating on each card. */
  private shouldOfferExplicitRating(): boolean {
    if (this.effectiveAlgorithm() === 'off') return false;
    return this.effectiveGradingMode() !== 'auto';
  }

  /**
   * A single unobtrusive icon per card that opens the rating menu.
   *
   * Deliberately one control rather than four buttons: manual rating is a
   * correction you reach for occasionally, so it should not put four targets
   * on every card. Uses Obsidian's global `clickable-icon` class, so it needs
   * no bespoke styling.
   */
  private renderRatingButton(
    container: HTMLElement,
    preview: NotePreview
  ): void {
    const button = container.createEl('button', {
      cls: 'clickable-icon doomscroll-card-rate',
    });
    button.dataset.ratingPath = preview.path;
    button.setAttribute('aria-label', `Rate ${preview.title}`);
    button.setAttribute('title', `Rate ${preview.title}`);
    setIcon(button, 'gauge');

    button.addEventListener('click', (event) => {
      // The card itself opens the note; a rating must not do that.
      event.stopPropagation();
      this.showRatingMenu(event, preview);
    });
  }

  private showRatingMenu(event: MouseEvent, preview: NotePreview): void {
    const menu = new Menu();

    menu.addItem((item) => item.setTitle('Rate this note').setIsLabel(true));
    for (const rating of RATING_ORDER) {
      menu.addItem((item) =>
        item
          .setTitle(RATING_LABELS[rating])
          .setIcon(RATING_ICONS[rating])
          .onClick(() => {
            void this.recordExplicitRating(preview, rating);
          })
      );
    }

    menu.showAtMouseEvent(event);
  }

  /**
   * Apply a rating the user chose by hand.
   *
   * The only source of `again` / `hard` / `easy`: automatic grading cannot
   * produce a negative rating, so this is what lets a scheduler register a
   * lapse at all.
   */
  private async recordExplicitRating(
    preview: NotePreview,
    rating: Rating
  ): Promise<void> {
    const algorithm = this.effectiveAlgorithm();
    if (algorithm === 'off') return;

    const store = this.plugin.srsStore;
    if (!store?.isLoaded) return;

    try {
      const file = this.app.vault.getAbstractFileByPath(preview.path);
      if (!(file instanceof TFile)) return;
      const content = await this.app.vault.cachedRead(file);

      await store.recordReview(
        {
          path: preview.path,
          rating,
          algorithm,
          source: 'explicit',
          hash: SrsStore.hashContent(content),
          now: Date.now(),
          tunables: this.effectiveTunables(),
        },
        getAlgorithm(algorithm)
      );

      // The explicit rating supersedes any automatic observation of this card,
      // which must not be recorded as a second review when the batch tears down.
      this.dwell.delete(preview.path);
      this.visibleSince.delete(preview.path);

      this.updateRatingButton(preview.path, rating);
    } catch (error) {
      logSrsError(`failed to record rating for ${preview.path}`, error);
    }
  }

  /** Show the chosen rating on the card so the action has visible feedback. */
  private updateRatingButton(path: string, rating: Rating): void {
    const card = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>('.doomscroll-card')
    ).find((candidate) => candidate.dataset.path === path);
    const button = card?.querySelector<HTMLElement>('.doomscroll-card-rate');
    if (!button) return;

    setIcon(button, RATING_ICONS[rating]);
    button.setAttribute('aria-label', `Rated ${rating}`);
    button.setAttribute('title', `Rated ${rating}`);
  }

  private createCardObserver(container: HTMLElement): IntersectionObserver {
    return new IntersectionObserver(
      (entries) => {
        let historyChanged = false;
        for (const entry of entries) {
          const card = entry.target as HTMLElement;
          const path = card.dataset.path;

          if (!entry.isIntersecting) {
            // Cards are no longer unobserved on first sight: dwell needs both
            // edges, so the observer now tracks leaving as well as entering.
            if (path) this.markCardHidden(path);
            continue;
          }

          const preview = this.currentBatch.find(
            (candidate) => candidate.path === path
          );
          const snippetEl = card.querySelector('.doomscroll-card-snippet');
          if (preview && snippetEl instanceof HTMLElement) {
            void this.renderSnippet(preview, snippetEl);
          }
          if (path) {
            this.markCardVisible(path);
            if (!this.viewedPathsInBatch.has(path)) {
              this.viewedPathsInBatch.add(path);
              this.plugin.data.history = recordView(
                this.plugin.data.history,
                path,
                Date.now()
              );
              historyChanged = true;
            }
          }
        }
        if (historyChanged) this.scheduleHistorySave();
      },
      { root: container, threshold: 0.1 }
    );
  }

  private observeInfiniteScroll(
    container: HTMLElement,
    existingSentinel?: HTMLElement
  ): void {
    if (!this.plugin.data.settings.infiniteScroll) return;
    const sentinel =
      existingSentinel ??
      container.querySelector<HTMLElement>(
        '.doomscroll-infinite-scroll-sentinel'
      ) ??
      container.createDiv('doomscroll-infinite-scroll-sentinel');
    this.infiniteScrollObserver?.disconnect();
    this.infiniteScrollObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void this.loadMoreCards(container, sentinel);
        }
      },
      { root: container, rootMargin: '400px' }
    );
    this.infiniteScrollObserver.observe(sentinel);
  }

  private async loadMoreCards(
    container: HTMLElement,
    sentinel: HTMLElement
  ): Promise<void> {
    if (
      this.infiniteScrollLoading ||
      this.infiniteScrollExhausted ||
      !this.plugin.data.settings.infiniteScroll ||
      !sentinel.isConnected
    ) {
      return;
    }

    this.infiniteScrollLoading = true;
    sentinel.textContent = 'Loading more notes…';

    try {
      const loadedPaths = new Set(
        this.currentBatch.map((preview) => preview.path)
      );
      const candidates = Object.entries(this.plugin.data.previews)
        .map(([path, stored]) => toNotePreview(path, stored))
        .filter(
          (preview) =>
            !loadedPaths.has(preview.path) && this.shouldIncludePreview(preview)
        );
      const nextBatch = selectBatch(
        candidates,
        this.plugin.data.history,
        INFINITE_SCROLL_CHUNK_SIZE,
        Date.now(),
        {
          algorithm: this.effectiveAlgorithm(),
          states: this.effectiveStates(),
        }
      );

      if (nextBatch.length === 0) {
        this.infiniteScrollExhausted = true;
        sentinel.textContent = 'No more notes';
        return;
      }

      this.currentBatch = [...this.currentBatch, ...nextBatch];
      if (
        this.batchHistoryCursor >= 0 &&
        this.batchHistoryCursor < this.batchHistory.length
      ) {
        this.batchHistory[this.batchHistoryCursor] = this.currentBatch;
      }

      const reshuffleSection = container.querySelector(
        '.doomscroll-reshuffle-section'
      );
      for (const preview of nextBatch) {
        const card = this.renderCard(container, preview);
        if (reshuffleSection) {
          reshuffleSection.before(card);
        } else {
          sentinel.before(card);
        }
        this.cardObserver?.observe(card);
      }

      if (nextBatch.length < INFINITE_SCROLL_CHUNK_SIZE) {
        this.infiniteScrollExhausted = true;
        sentinel.textContent = 'No more notes';
      } else {
        sentinel.textContent = '';
      }
    } finally {
      this.infiniteScrollLoading = false;
    }
  }

  private async showNewBatch(): Promise<void> {
    if (this.isRefreshing) return;

    const previousOrder = this.currentBatch.map((preview) => preview.path);
    this.setRefreshing(true);

    try {
      let indexRefreshed = await this.plugin.indexer.refreshIfStale();
      // Settings may have changed while the first rebuild was in progress.
      // Run the indexer again for the final settings before selecting a batch.
      if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
        indexRefreshed =
          (await this.plugin.indexer.refreshIfStale()) || indexRefreshed;
      }

      const settingsChanged =
        this.batchSettingsKey !== this.getBatchSettingsKey();
      this.currentBatch = [];

      if (settingsChanged) {
        this.batchHistory = [];
        this.batchHistoryCursor = -1;
      } else if (indexRefreshed) {
        this.revalidateBatchHistory();
      }

      this.renderBatch(
        settingsChanged || indexRefreshed ? undefined : previousOrder
      );
      this.containerEl.querySelector('.doomscroll-body')?.scrollTo({ top: 0 });
    } catch (error) {
      console.error('Error refreshing vault index:', error);
    } finally {
      this.setRefreshing(false);
      if (this.pendingSettingsRefresh) {
        this.pendingSettingsRefresh = false;
        await this.refreshForCurrentSettings();
      }
    }
  }

  private async showPreviousBatch(): Promise<void> {
    if (this.batchSettingsKey !== this.getBatchSettingsKey()) {
      await this.refreshForCurrentSettings();
      return;
    }

    const previousCursor = this.batchHistoryCursor + 1;
    const previousBatch = this.batchHistory[previousCursor];
    if (!previousBatch) return;

    this.batchHistoryCursor = previousCursor;
    this.currentBatch = previousBatch;
    this.renderBatch();
    this.containerEl.querySelector('.doomscroll-body')?.scrollTo({ top: 0 });
  }

  private updateBackButton(): void {
    if (this.backButton) {
      this.backButton.disabled =
        this.batchHistoryCursor < 0 ||
        this.batchHistoryCursor >= this.batchHistory.length - 1;
    }
  }

  private renderBatch(previousOrder?: readonly string[]): void {
    const body = this.containerEl.querySelector('.doomscroll-body');
    if (body) {
      this.renderBatchIntoContainer(body as HTMLElement, previousOrder);
    }
  }

  private revalidateBatchHistory(): void {
    const previousCursor = this.batchHistoryCursor;
    const retained: Array<{ oldIndex: number; batch: NotePreview[] }> = [];

    this.batchHistory.forEach((batch, oldIndex) => {
      const nextBatch = this.resolvePreviewPaths(
        batch.map((preview) => preview.path)
      );
      if (nextBatch.length > 0) {
        retained.push({ oldIndex, batch: nextBatch });
      }
    });

    this.batchHistory = retained.map(({ batch }) => batch);
    const retainedCursor = retained.findIndex(
      ({ oldIndex }) => oldIndex === previousCursor
    );
    this.batchHistoryCursor =
      retainedCursor >= 0
        ? retainedCursor
        : Math.min(previousCursor, this.batchHistory.length - 1);
  }

  private setRefreshing(refreshing: boolean): void {
    this.isRefreshing = refreshing;
    if (this.refreshStatusEl) {
      this.refreshStatusEl.textContent = refreshing ? 'Indexing…' : '';
    }

    const buttons = this.containerEl.querySelectorAll<HTMLButtonElement>(
      '.doomscroll-reshuffle-btn, .doomscroll-reshuffle-end-btn'
    );
    buttons.forEach((button) => {
      button.disabled = refreshing;
      if (button.classList.contains('doomscroll-reshuffle-end-btn')) {
        const defaultLabel = button.dataset.defaultLabel ?? 'Reshuffle';
        button.textContent = refreshing ? 'Indexing…' : defaultLabel;
      }
    });
  }

  /**
   * What the current batch was chosen under.
   *
   * Only configuration that changes *which* notes arrive or *how* they are
   * chosen belongs here. The display preset's rendering options (simplified
   * view, preview size, frontmatter rendering) are deliberately absent: they
   * change how a card looks, not which cards are in the batch, so changing them
   * must not discard the batch the user is reading.
   *
   * Values are used rather than the active preset ids, because a session
   * override changes what is in force without changing any id.
   */
  private getBatchSettingsKey(): string {
    const algorithm = this.plugin.getEffectiveAlgorithm();
    const filter = this.plugin.getEffectiveFilter();
    return JSON.stringify({
      batchSize: this.plugin.data.settings.batchSize,
      infiniteScroll: this.plugin.data.settings.infiniteScroll,
      filter: {
        folders: filter.folders,
        tags: filter.tags,
        globs: filter.globs,
        searchQuery: filter.searchQuery,
        fileTypes: filter.fileTypes,
        includeMediaOnlyNotes: filter.includeMediaOnlyNotes,
      },
      algorithm: {
        algorithm: algorithm.algorithm,
        gradingMode: algorithm.gradingMode,
        sensitivity: algorithm.sensitivity,
        fsrsTunables: algorithm.fsrsTunables,
      },
    });
  }

  private shouldIncludePreview(preview: NotePreview): boolean {
    const filter = this.plugin.getEffectiveFilter();

    // File type is the successor to `showNonMarkdownFiles`. The indexer already
    // applied it, but re-checking here keeps the view consistent in the window
    // before a rebuild catches up.
    if (!passesFileTypeRule(filter.fileTypes, preview.path)) {
      return false;
    }

    // A standalone attachment has no note content to preview.
    if (preview.attachment) return true;

    return filter.includeMediaOnlyNotes || !isMediaOnlyPreview(preview);
  }

  private getFrontmatterPropertiesKey(): string {
    return JSON.stringify({
      before: this.plugin.getEffectiveDisplay().frontmatterBeforeProps ?? [],
      after: this.plugin.getEffectiveDisplay().frontmatterAfterProps ?? [],
    });
  }

  private isSimplifiedView(): boolean {
    // Treat missing values from pre-setting data.json files as the default.
    return this.plugin.getEffectiveDisplay().simplifiedView !== false;
  }

  private getPreviewSize(): PreviewSize {
    return isPreviewSize(this.plugin.getEffectiveDisplay().previewSize)
      ? this.plugin.getEffectiveDisplay().previewSize
      : 'medium';
  }

  private setSnippetPreviewSize(snippetEl: HTMLElement): void {
    snippetEl.classList.remove(
      'doomscroll-card-snippet-size-small',
      'doomscroll-card-snippet-size-medium',
      'doomscroll-card-snippet-size-large'
    );
    snippetEl.classList.add(
      `doomscroll-card-snippet-size-${this.getPreviewSize()}`
    );
  }

  private setSnippetContent(
    snippetEl: HTMLElement,
    renderedRoot: HTMLElement,
    simplified: boolean
  ): void {
    snippetEl.classList.toggle('doomscroll-card-snippet-simple', simplified);
    snippetEl.classList.toggle('doomscroll-card-snippet-markdown', !simplified);
    snippetEl.classList.toggle('markdown-rendered', !simplified);
    this.setSnippetPreviewSize(snippetEl);

    const clone = renderedRoot.cloneNode(true) as HTMLElement;
    if (clone.childNodes.length === 0) {
      snippetEl.textContent = '(no preview text)';
      return;
    }
    snippetEl.replaceChildren(...Array.from(clone.childNodes));

    if (clone.querySelector('.dataview, .bases-view, .bases-embed')) {
      const interactionShield = snippetEl.createDiv(
        'doomscroll-card-snippet-interaction-shield'
      );
      interactionShield.setAttribute('aria-hidden', 'true');
    }
  }

  private cacheRenderedSnippet(key: string, renderedRoot: HTMLElement): void {
    // Map insertion order gives us a small LRU cache without retaining every
    // file ever visited during a long-lived Doomscroll session.
    this.renderedSnippetCache.delete(key);
    this.renderedSnippetCache.set(key, renderedRoot);
    while (this.renderedSnippetCache.size > MAX_RENDERED_SNIPPET_CACHE_ENTRIES) {
      const oldestKey = this.renderedSnippetCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.renderedSnippetCache.delete(oldestKey);
    }
  }

  private renderCard(
    container: HTMLElement,
    preview: NotePreview
  ): HTMLElement {
    const card = container.createDiv('doomscroll-card');
    card.dataset.path = preview.path;
    card.setAttribute('role', 'article');
    card.tabIndex = -1;
    card.setAttribute('aria-label', preview.title);
    const inlineAttachmentPreview =
      preview.attachment &&
      (isImagePath(preview.path) ||
        isPdfPath(preview.path) ||
        isVideoPath(preview.path));
    if (inlineAttachmentPreview) {
      card.addClass('doomscroll-card-inline-attachment');
    } else {
      applyCachedCardSize(card, this.isSimplifiedView(), this.getPreviewSize());
    }

    // Title + date row
    const titleRow = card.createDiv('doomscroll-card-titlerow');

    const titleEl = titleRow.createEl('h3');
    titleEl.className = 'doomscroll-card-title';
    titleEl.textContent = preview.title;

    const dateEl = titleRow.createDiv('doomscroll-card-date');
    const date = new Date(preview.mtime);
    dateEl.textContent = date.toLocaleDateString();

    // Manual rating, when the user has asked for it. This is the only route by
    // which a negative rating can ever reach a scheduler — automatic grading is
    // deliberately incapable of inventing one — so without this control the
    // 'manual' mode would record nothing at all.
    if (this.shouldOfferExplicitRating()) {
      this.renderRatingButton(titleRow, preview);
    }

    // Image (lazy loaded)
    if (preview.imagePath) {
      const imageContainer = card.createDiv(
        'doomscroll-card-image-container'
      );

      const img = imageContainer.createEl('img');
      img.className = 'doomscroll-card-image';
      img.dataset.src = preview.imagePath;
      img.dataset.notePath = preview.path;
      img.alt = preview.title;

      const imageDimensions = imageDimensionCache.get(
        getImageDimensionCacheKey(preview)
      );
      if (imageDimensions) {
        applyImageDimensions(img, imageDimensions);
      }

      // Setup lazy loading via IntersectionObserver
      this.setupImageLazyLoad(
        img,
        getImageDimensionCacheKey(preview)
      );
    }

    if (preview.attachment && isPdfPath(preview.path)) {
      const pdfContainer = card.createDiv('doomscroll-card-pdf-container');
      const pdf = pdfContainer.createEl('iframe');
      pdf.className = 'doomscroll-card-pdf';
      pdf.dataset.path = preview.path;
      pdf.title = `${preview.title} preview`;
      this.setupPdfLazyLoad(pdf);
    }

    if (preview.attachment && isVideoPath(preview.path)) {
      const videoContainer = card.createDiv('doomscroll-card-video-container');
      const video = videoContainer.createEl('video');
      video.className = 'doomscroll-card-video';
      video.dataset.path = preview.path;
      video.title = `${preview.title} preview`;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'metadata';
      this.setupVideoLazyLoad(video);
    }

    // Snippet is rendered on demand from a bounded Markdown fragment.
    const snippetEl = card.createDiv('doomscroll-card-snippet');
    this.setSnippetPreviewSize(snippetEl);
    snippetEl.textContent = preview.attachment
      ? attachmentLabel(preview.path)
      : 'Loading preview…';
    this.renderCardFrontmatter(card, preview, 'before');
    this.renderCardFrontmatter(card, preview, 'after');

    // Click handler
    card.addEventListener('click', () => {
      if (!Platform.isMobile) this.focusCard(card, false);
      void this.renderSnippet(preview, snippetEl);
      void this.openPreview(preview);
    });

    return card;
  }

  private renderFrontmatterProperties(
    preview: NotePreview,
    container: HTMLElement,
    properties: string[]
  ): void {
    if (properties.length === 0) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(preview.path);
    if (!(file instanceof TFile)) return;

    const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!isRecord(frontmatter)) return;

    for (const property of properties) {
      if (!Object.prototype.hasOwnProperty.call(frontmatter, property)) continue;

      const value = formatFrontmatterValue(frontmatter[property]);
      if (!value) continue;

      const row = container.createDiv('doomscroll-card-frontmatter-row');
      row.createSpan({
        text: `${property}:`,
        cls: 'doomscroll-card-frontmatter-property',
      });
      row.createSpan({
        text: value,
        cls: 'doomscroll-card-frontmatter-value',
      });
    }
  }

  private async renderSnippet(
    preview: NotePreview,
    snippetEl: HTMLElement
  ): Promise<void> {
    if (this.isClosed || !snippetEl.isConnected) return;

    const generation =
      (this.snippetRenderGenerations.get(snippetEl) ?? 0) + 1;
    this.snippetRenderGenerations.set(snippetEl, generation);
    const isCurrent = (): boolean =>
      !this.isClosed &&
      snippetEl.isConnected &&
      this.snippetRenderGenerations.get(snippetEl) === generation;
    const isCancelled = (): boolean => !isCurrent();

    const file = this.plugin.app.vault.getAbstractFileByPath(preview.path);
    if (!(file instanceof TFile)) {
      if (isCurrent()) snippetEl.textContent = '(no preview text)';
      return;
    }

    if (preview.attachment) {
      if (isCurrent()) snippetEl.textContent = attachmentLabel(preview.path);
      return;
    }

    const simplified = this.isSimplifiedView();

    try {
      await this.waitForDataviewIndex(isCancelled);
      if (!isCurrent()) return;

      const cacheKey = this.getRenderedSnippetCacheKey(file, simplified);
      const cached = this.renderedSnippetCache.get(cacheKey);
      if (cached !== undefined) {
        this.cacheRenderedSnippet(cacheKey, cached);
        if (!isCurrent()) return;
        this.setSnippetContent(snippetEl, cached, simplified);
        this.cacheCardSize(snippetEl.closest('.doomscroll-card'));
        return;
      }

      const content = await this.plugin.app.vault.cachedRead(file);
      if (!isCurrent()) return;
      const markdown = preparePreviewMarkdown(content);
      snippetEl.replaceChildren();
      const rendered = snippetEl.createDiv();
      // Keep the staging tree attached while Obsidian and third-party
      // post-processors finish. Plugins such as Dataview use shown/inserted
      // lifecycle checks when scheduling their initial render.
      const renderComponent = new Component();
      renderComponent.load();
      let prepared: HTMLElement;
      try {
        await MarkdownRenderer.render(
          this.plugin.app,
          markdown,
          rendered,
          file.path,
          renderComponent
        );

        // MarkdownRenderer does not await every plugin-owned child render.
        // Wait for the staging tree to become quiet before taking the cached
        // snapshot, then use the Bases loading marker as a stronger signal for
        // its asynchronous query.
        await waitForPluginRenderToSettle(rendered, isCancelled);
        await waitForBasesViewsToSettle(rendered, isCancelled);
        if (!isCurrent()) return;

        prepared = prepareRenderedPreview(rendered, simplified);
      } finally {
        renderComponent.unload();
      }
      if (!isCurrent()) return;
      this.cacheRenderedSnippet(cacheKey, prepared);
      if (isCurrent()) {
        this.setSnippetContent(snippetEl, prepared, simplified);
        this.cacheCardSize(snippetEl.closest('.doomscroll-card'));
      }
    } catch (error) {
      console.error(`Error rendering preview for ${file.path}:`, error);
      if (isCurrent()) {
        snippetEl.textContent = preview.snippet ?? '(no preview text)';
      }
    }
  }

  private getRenderedSnippetCacheKey(
    file: TFile,
    simplified: boolean
  ): string {
    const dataviewApi = (window as WindowWithDataviewApi).DataviewAPI;
    const dataviewRevision = dataviewApi?.index?.revision ?? 'none';
    return `${simplified ? 'simplified' : 'markdown'}:${file.path}:${file.stat.mtime}:${dataviewRevision}`;
  }

  /**
   * Dataview registers its Markdown renderer immediately, but builds its
   * page index asynchronously. Rendering a query before that index is ready
   * produces a valid-looking empty result which is then captured in the
   * preview cache. Wait for Dataview when it is present, while keeping the
   * renderer usable with other plugins or with Dataview disabled.
   */
  private async waitForDataviewIndex(
    isCancelled: () => boolean
  ): Promise<void> {
    const dataviewApi = (window as WindowWithDataviewApi).DataviewAPI;
    if (isCancelled() || dataviewApi?.index?.initialized !== false) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: number | null = null;
      let cancelPollId: number | null = null;
      let eventRef: EventRef | null = null;
      const metadataCacheEvents =
        this.plugin.app.metadataCache as unknown as Events;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        if (cancelPollId !== null) window.clearInterval(cancelPollId);
        if (eventRef) metadataCacheEvents.offref(eventRef);
        resolve();
      };

      eventRef = metadataCacheEvents.on(
        'dataview:index-ready',
        finish
      );
      timeoutId = window.setTimeout(finish, PLUGIN_INDEX_READY_TIMEOUT_MS);
      cancelPollId = window.setInterval(() => {
        if (isCancelled()) finish();
      }, 100);
    });
  }

  private schedulePluginPreviewRefresh(excludePath?: string): void {
    if (this.isClosed) return;

    if (excludePath) {
      this.pluginRefreshExcludePaths.add(excludePath);
    } else {
      this.pluginRefreshExcludePaths.clear();
    }

    if (this.pluginRefreshTimer !== null) {
      window.clearTimeout(this.pluginRefreshTimer);
    }
    this.pluginRefreshTimer = window.setTimeout(() => {
      this.pluginRefreshTimer = null;
      const excludedPaths = this.pluginRefreshExcludePaths;
      this.pluginRefreshExcludePaths = new Set();
      void this.refreshPluginPreviews(excludedPaths);
    }, 150);
  }

  private async refreshPluginPreviews(
    excludedPaths: ReadonlySet<string> = new Set()
  ): Promise<void> {
    if (this.isClosed) return;

    const renders: Promise<void>[] = [];
    this.containerEl
      .querySelectorAll<HTMLElement>('.doomscroll-card')
      .forEach((card) => {
        const path = card.dataset.path;
        const snippetEl = card.querySelector('.doomscroll-card-snippet');
        if (
          !path ||
          excludedPaths.has(path) ||
          !(snippetEl instanceof HTMLElement) ||
          !snippetEl.querySelector('.dataview, .bases-view, .bases-embed')
        ) {
          return;
        }

        const preview = this.currentBatch.find(
          (candidate) => candidate.path === path
        );
        if (!preview) return;

        invalidateRenderedSnippetCache(this.renderedSnippetCache, path);
        renders.push(this.renderSnippet(preview, snippetEl));
      });

    await Promise.all(renders);
  }

  private async refreshModifiedCard(file: TFile): Promise<void> {
    if (this.isClosed) return;

    const preview = this.currentBatch.find(
      (candidate) => candidate.path === file.path
    );
    if (!preview) return;

    const card = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>('.doomscroll-card')
    ).find((candidate) => candidate.dataset.path === file.path);
    if (!card) return;

    preview.mtime = file.stat.mtime;
    const dateEl = card.querySelector('.doomscroll-card-date');
    if (dateEl instanceof HTMLElement) {
      dateEl.textContent = new Date(file.stat.mtime).toLocaleDateString();
    }

    const snippetEl = card.querySelector('.doomscroll-card-snippet');
    if (!(snippetEl instanceof HTMLElement)) return;

    if (preview.attachment) {
      if (preview.imagePath && isImagePath(file.path)) {
        const image = card.querySelector<HTMLImageElement>(
          '.doomscroll-card-image'
        );
        if (image) {
          image.src = '';
          image.dataset.src = preview.imagePath;
          this.setupImageLazyLoad(image, getImageDimensionCacheKey(preview));
        }
      }
      snippetEl.textContent = attachmentLabel(preview.path);
      this.cacheCardSize(card);
      return;
    }

    invalidateCardSizeCache(file.path);
    card.style.removeProperty('min-height');

    invalidateRenderedSnippetCache(this.renderedSnippetCache, file.path);

    await this.renderSnippet(preview, snippetEl);
    if (this.isClosed || !card.isConnected) return;
    this.renderCardFrontmatter(card, preview, 'before');
    this.renderCardFrontmatter(card, preview, 'after');
    this.cacheCardSize(card);
  }

  private async removeDeletedNote(path: string): Promise<void> {
    const card = Array.from(
      this.containerEl.querySelectorAll<HTMLElement>('.doomscroll-card')
    ).find((candidate) => candidate.dataset.path === path);

    const hadPreview = path in this.plugin.data.previews;
    const hadHistory = this.plugin.data.history.some(
      (entry) => entry.path === path
    );
    if (!card && !hadPreview && !hadHistory) return;

    if (card) {
      this.cardObserver?.unobserve(card);
      card.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
        this.imageObserver?.unobserve(image);
      });
      card.querySelectorAll<HTMLIFrameElement>('iframe').forEach((pdf) => {
        this.pdfObserver?.unobserve(pdf);
      });
      card.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
        this.videoObserver?.unobserve(video);
      });
      card.remove();
    }

    const nextBatches = removePathFromBatches(
      this.currentBatch,
      this.batchHistory,
      this.batchHistoryCursor,
      path
    );
    this.currentBatch = nextBatches.currentBatch;
    this.batchHistory = nextBatches.batchHistory;
    this.batchHistoryCursor = nextBatches.batchHistoryCursor;
    this.viewedPathsInBatch.delete(path);

    delete this.plugin.data.previews[path];
    this.plugin.data.history = this.plugin.data.history.filter(
      (entry) => entry.path !== path
    );
    invalidateNoteCaches(path);

    for (const key of this.renderedSnippetCache.keys()) {
      if (key.includes(`:${path}:`)) {
        this.renderedSnippetCache.delete(key);
      }
    }

    this.updateBackButton();
    await this.plugin.saveSettings();
  }

  private async openPreview(preview: NotePreview): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(preview.path);

    if (file instanceof TFile) {
      // Opening a note is the strongest engagement signal available, and it
      // must be captured here: the note may be opened before the observer has
      // had a chance to see the card at all.
      this.markCardOpened(preview.path);

      // A very quick tap can happen before IntersectionObserver fires.
      if (!this.viewedPathsInBatch.has(preview.path)) {
        this.viewedPathsInBatch.add(preview.path);
        this.plugin.data.history = recordView(
          this.plugin.data.history,
          preview.path,
          Date.now()
        );
        this.scheduleHistorySave();
      }

      const behavior = this.plugin.getEffectiveDisplay().openNoteBehavior;
      const leaf =
        behavior === 'reuse'
          ? this.leaf
          : this.plugin.app.workspace.getLeaf(behavior);
      await leaf.openFile(file);
    }
  }

  private setupImageLazyLoad(
    img: HTMLImageElement,
    imageDimensionCacheKey: string
  ): void {
    if (!this.imageLoadListeners.has(img)) {
      img.addEventListener('load', () => {
        if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return;

        const dimensions = {
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
        imageDimensionCache.delete(imageDimensionCacheKey);
        imageDimensionCache.set(imageDimensionCacheKey, dimensions);
        while (imageDimensionCache.size > MAX_IMAGE_DIMENSION_CACHE_ENTRIES) {
          const oldestKey = imageDimensionCache.keys().next().value;
          if (typeof oldestKey !== 'string') break;
          imageDimensionCache.delete(oldestKey);
        }
        applyImageDimensions(img, dimensions);
        this.cacheCardSize(img.closest('.doomscroll-card'));
      });
      this.imageLoadListeners.add(img);
    }

    if (!this.imageObserver) {
      this.imageObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const imgEl = entry.target as HTMLImageElement;
              const src = imgEl.dataset.src;
              const notePath = imgEl.dataset.notePath;

              if (src && notePath) {
                const file = this.plugin.app.vault.getAbstractFileByPath(
                  notePath
                );

                let resolvedSrc: string | null = null;
                if (file instanceof TFile) {
                  resolvedSrc = this.plugin.indexer.resolveImageSrc(
                    src,
                    file
                  );
                }

                if (resolvedSrc) {
                  imgEl.src = resolvedSrc;
                } else {
                  // Couldn't resolve — hide the container instead of showing a broken icon
                  imgEl.closest('.doomscroll-card-image-container')?.remove();
                }
              }

              if (this.imageObserver) {
                this.imageObserver.unobserve(imgEl);
              }
            }
          });
        },
        { rootMargin: '100px' }
      );
    }

    this.imageObserver.observe(img);
  }

  private setupPdfLazyLoad(pdf: HTMLIFrameElement): void {
    if (!this.pdfObserver) {
      this.pdfObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;

            const pdfEl = entry.target as HTMLIFrameElement;
            const path = pdfEl.dataset.path;
            const file = path
              ? this.plugin.app.vault.getAbstractFileByPath(path)
              : null;
            if (file instanceof TFile) {
              const resourcePath = this.plugin.app.vault.getResourcePath(file);
              pdfEl.src = `${resourcePath}#page=1&view=FitH`;
            }
            this.pdfObserver?.unobserve(pdfEl);
          });
        },
        { rootMargin: '100px' }
      );
    }

    this.pdfObserver.observe(pdf);
  }

  private setupVideoLazyLoad(video: HTMLVideoElement): void {
    if (!this.videoObserver) {
      this.videoObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;

            const videoEl = entry.target as HTMLVideoElement;
            const path = videoEl.dataset.path;
            const file = path
              ? this.plugin.app.vault.getAbstractFileByPath(path)
              : null;
            if (file instanceof TFile) {
              videoEl.src = this.plugin.app.vault.getResourcePath(file);
              videoEl.preload = 'auto';
              videoEl.load();
            }
            this.videoObserver?.unobserve(videoEl);
          });
        },
        { rootMargin: '100px' }
      );
    }

    this.videoObserver.observe(video);
  }

  private scheduleHistorySave(): void {
    this.historySavePending = true;
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
    }
    this.historySaveTimer = window.setTimeout(() => {
      this.historySaveTimer = null;
      void this.flushHistorySave();
    }, HISTORY_SAVE_DELAY_MS);
  }

  private async flushHistorySave(): Promise<void> {
    if (!this.historySavePending) return;
    this.historySavePending = false;
    await this.plugin.saveSettings();
  }

  async onClose(): Promise<void> {
    this.cancelScrollAnimation();
    this.isClosed = true;

    // Capture whatever the last batch was showing before the view goes away.
    this.flushEngagement();
    this.snippetRenderGenerations = new WeakMap();
    this.pluginRefreshExcludePaths.clear();
    if (this.pluginRefreshTimer !== null) {
      window.clearTimeout(this.pluginRefreshTimer);
      this.pluginRefreshTimer = null;
    }
    if (this.cardObserver) {
      this.cardObserver.disconnect();
      this.cardObserver = null;
    }
    if (this.imageObserver) {
      this.imageObserver.disconnect();
      this.imageObserver = null;
    }
    if (this.pdfObserver) {
      this.pdfObserver.disconnect();
      this.pdfObserver = null;
    }
    if (this.videoObserver) {
      this.videoObserver.disconnect();
      this.videoObserver = null;
    }
    if (this.infiniteScrollObserver) {
      this.infiniteScrollObserver.disconnect();
      this.infiniteScrollObserver = null;
    }
    this.renderedSnippetCache.clear();
    if (this.historySaveTimer !== null) {
      window.clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }
    await this.flushHistorySave();

    // The engagement flush above dispatches its writes asynchronously, so let
    // them settle before the view is gone.
    try {
      await this.plugin.srsStore?.flush();
    } catch (error) {
      logSrsError('failed to flush resurfacing state on close', error);
    }
  }

  private cacheCardSize(card: Element | null): void {
    if (!(card instanceof HTMLElement)) return;

    rememberCardSize(card, this.isSimplifiedView(), this.getPreviewSize());
  }

  private renderCardFrontmatter(
    card: HTMLElement,
    preview: NotePreview,
    position: 'before' | 'after'
  ): void {
    card.querySelector(`.doomscroll-card-frontmatter-${position}`)?.remove();

    const frontmatterEl = card.createDiv('doomscroll-card-frontmatter');
    frontmatterEl.classList.add(`doomscroll-card-frontmatter-${position}`);
    const properties =
      position === 'before'
        ? this.plugin.getEffectiveDisplay().frontmatterBeforeProps ?? []
        : this.plugin.getEffectiveDisplay().frontmatterAfterProps ?? [];
    this.renderFrontmatterProperties(preview, frontmatterEl, properties);
    if (frontmatterEl.childElementCount === 0) {
      frontmatterEl.remove();
      return;
    }

    const snippetEl = card.querySelector('.doomscroll-card-snippet');
    if (position === 'before' && snippetEl) {
      card.insertBefore(frontmatterEl, snippetEl);
    } else {
      card.appendChild(frontmatterEl);
    }
  }
}

function getImageDimensionCacheKey(preview: NotePreview): string {
  return `${preview.path}\u0000${preview.imagePath ?? ''}`;
}

function formatFrontmatterValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(formatFrontmatterValue).filter(Boolean).join(', ');
  }
  if (isRecord(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function applyImageDimensions(
  img: HTMLImageElement,
  dimensions: ImageDimensions
): void {
  img.width = dimensions.width;
  img.height = dimensions.height;
  img.parentElement?.style.setProperty(
    'aspect-ratio',
    `${dimensions.width} / ${dimensions.height}`
  );
}

function getCardSizeCacheKey(
  path: string,
  simplified: boolean,
  previewSize: PreviewSize,
  width: number
): string {
  return `${path}\u0000${simplified ? 'simplified' : 'markdown'}\u0000${previewSize}\u0000${width}`;
}

function applyCachedCardSize(
  card: HTMLElement,
  simplified: boolean,
  previewSize: PreviewSize
): void {
  const width = Math.round(card.getBoundingClientRect().width);
  if (width <= 0) return;

  const cached = cardSizeCache.get(
    getCardSizeCacheKey(
      card.dataset.path ?? '',
      simplified,
      previewSize,
      width
    )
  );
  if (cached) {
    card.style.minHeight = `${cached.height}px`;
  }
}

function rememberCardSize(
  card: HTMLElement,
  simplified: boolean,
  previewSize: PreviewSize
): void {
  window.requestAnimationFrame(() => {
    if (!card.isConnected) return;

    // Remove the reservation while measuring so a changed note can shrink as
    // well as grow after its new preview has rendered.
    const previousMinHeight = card.style.minHeight;
    card.style.removeProperty('min-height');
    const rect = card.getBoundingClientRect();
    card.style.minHeight = previousMinHeight;

    const path = card.dataset.path;
    const width = Math.round(rect.width);
    if (!path || width <= 0 || rect.height <= 0) return;

    const key = getCardSizeCacheKey(path, simplified, previewSize, width);
    cardSizeCache.delete(key);
    cardSizeCache.set(key, { height: rect.height });
    while (cardSizeCache.size > MAX_CARD_SIZE_CACHE_ENTRIES) {
      const oldestKey = cardSizeCache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      cardSizeCache.delete(oldestKey);
    }
    card.style.minHeight = `${rect.height}px`;
  });
}

function invalidateCardSizeCache(path: string): void {
  const prefix = `${path}\u0000`;
  for (const key of cardSizeCache.keys()) {
    if (key.startsWith(prefix)) {
      cardSizeCache.delete(key);
    }
  }
}

function invalidateNoteCaches(path: string): void {
  const imagePrefix = `${path}\u0000`;
  for (const key of imageDimensionCache.keys()) {
    if (key.startsWith(imagePrefix)) {
      imageDimensionCache.delete(key);
    }
  }
  invalidateCardSizeCache(path);
}

function invalidateImageCaches(): void {
  imageDimensionCache.clear();
  cardSizeCache.clear();
}

function clearCardSizeCache(): void {
  cardSizeCache.clear();
}

function invalidateRenderedSnippetCache(
  cache: Map<string, HTMLElement>,
  path: string
): void {
  for (const key of cache.keys()) {
    if (key.includes(`:${path}:`)) {
      cache.delete(key);
    }
  }
}

function waitForPluginRenderToSettle(
  container: HTMLElement,
  isCancelled: () => boolean
): Promise<void> {
  if (
    isCancelled() ||
    !container.querySelector('.dataview, .bases-view, .bases-embed')
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let quietTimerId: number | null = null;
    let timeoutId: number | null = null;
    let cancelPollId: number | null = null;
    const observer = new MutationObserver(() => {
      scheduleQuietCheck();
    });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      if (quietTimerId !== null) window.clearTimeout(quietTimerId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (cancelPollId !== null) window.clearInterval(cancelPollId);
      resolve();
    };

    const scheduleQuietCheck = (): void => {
      if (isCancelled()) {
        finish();
        return;
      }
      if (quietTimerId !== null) window.clearTimeout(quietTimerId);
      quietTimerId = window.setTimeout(finish, PLUGIN_RENDER_QUIET_MS);
    };

    observer.observe(container, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      characterData: true,
      childList: true,
      subtree: true,
    });
    timeoutId = window.setTimeout(finish, PLUGIN_RENDER_TIMEOUT_MS);
    cancelPollId = window.setInterval(() => {
      if (isCancelled()) finish();
    }, 100);
    scheduleQuietCheck();
  });
}

function waitForBasesViewsToSettle(
  container: HTMLElement,
  isCancelled: () => boolean
): Promise<void> {
  const hasLoadingView = (): boolean =>
    container.querySelector('.bases-view .is-loading') !== null;

  if (isCancelled() || !hasLoadingView()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;
    let cancelPollId: number | null = null;
    const observer = new MutationObserver(() => {
      if (isCancelled() || !hasLoadingView()) finish();
    });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (cancelPollId !== null) window.clearInterval(cancelPollId);
      resolve();
    };

    observer.observe(container, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      subtree: true,
    });
    timeoutId = window.setTimeout(finish, BASES_RENDER_TIMEOUT_MS);
    cancelPollId = window.setInterval(() => {
      if (isCancelled()) finish();
    }, 100);
  });
}

function hasSameOrder(
  batch: readonly NotePreview[],
  paths: readonly string[]
): boolean {
  return (
    batch.length === paths.length &&
    batch.every((preview, index) => preview.path === paths[index])
  );
}

function isMediaOnlyPreview(preview: NotePreview): boolean {
  if (preview.mediaOnly) return true;

  // Older cached previews predate the explicit mediaOnly flag.
  return (
    (Boolean(preview.imagePath) && preview.snippet === '(no preview text)') ||
    /^📎 .+ attached$/.test(preview.snippet ?? '')
  );
}

function parseViewState(state: unknown): DoomscrollViewState | null {
  if (!isRecord(state)) return null;

  const batchPaths = stringArray(state.batchPaths);
  const rawHistory = state.batchHistoryPaths;
  if (!batchPaths || !Array.isArray(rawHistory)) return null;

  const batchHistoryPaths: string[][] = [];
  for (const paths of rawHistory) {
    const parsed = stringArray(paths);
    if (!parsed) return null;
    batchHistoryPaths.push(parsed);
  }

  const cursor = state.batchHistoryCursor;
  const scrollTop = state.scrollTop;
  const rawAnchor = state.scrollAnchor;
  const scrollAnchor =
    isRecord(rawAnchor) &&
    typeof rawAnchor.path === 'string' &&
    typeof rawAnchor.topOffset === 'number' &&
    Number.isFinite(rawAnchor.topOffset)
      ? { path: rawAnchor.path, topOffset: rawAnchor.topOffset }
      : null;
  return {
    batchPaths,
    batchHistoryPaths,
    batchHistoryCursor:
      typeof cursor === 'number' && Number.isInteger(cursor) ? cursor : 0,
    scrollTop:
      typeof scrollTop === 'number' && Number.isFinite(scrollTop)
        ? Math.max(0, scrollTop)
        : 0,
    focusedPath:
      typeof state.focusedPath === 'string' ? state.focusedPath : null,
    scrollAnchor,
  };
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
