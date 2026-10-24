import {
  App,
  FuzzySuggestModal,
  Menu,
  Modal,
  Notice,
  TFile,
  TFolder,
} from 'obsidian';
import type IntelliScrollPlugin from './main';
import { t } from './i18n';
import { normalizeMoveTargetFolder } from './moveTarget.ts';

/**
 * File-level actions on a note: move it somewhere, or delete it.
 *
 * Both the feed card and the floating control expose these through one
 * "note actions" icon. They deliberately live in one module: the two surfaces
 * must offer the same destinations and the same confirmation, and a delete
 * reached from either one has to behave identically.
 *
 * Nothing is written into the note. Moving goes through `FileManager`, which
 * also updates links according to the reader's preference; deleting goes
 * through `trashFile`, so the vault's own trash setting decides whether the
 * note goes to the system trash, Obsidian's `.trash`, or is removed for good.
 */

function folderLabel(path: string): string {
  return path === '/' ? t('view.path.vaultRoot') : path;
}

function destinationPath(folder: string, fileName: string): string {
  return folder === '/' ? fileName : `${folder}/${fileName}`;
}

function resolveFolder(app: App, path: string): TFolder | null {
  if (path === '/') return app.vault.getRoot();
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFolder ? file : null;
}

/**
 * Move the note at `path` into `folderPath`.
 *
 * Returns false when there was nothing to do or the move was refused. The
 * plugin's vault `rename` handler carries the schedule, history and session
 * across, so this only has to perform the file operation.
 */
export async function moveNoteToFolder(
  plugin: IntelliScrollPlugin,
  path: string,
  folderPath: string
): Promise<boolean> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;

  const folder = resolveFolder(plugin.app, folderPath);
  if (!folder) {
    new Notice(t('view.noteActions.folderMissing'));
    return false;
  }

  if (file.parent?.path === folder.path) return true;

  const destination = destinationPath(folder.path, file.name);
  if (plugin.app.vault.getAbstractFileByPath(destination)) {
    // Never overwrite silently: a one-click action must not destroy a note
    // that happens to share the name.
    new Notice(t('view.noteActions.collision'));
    return false;
  }

  try {
    await plugin.app.fileManager.renameFile(file, destination);
    return true;
  } catch (error) {
    console.error('[intelliscroll] could not move note', error);
    new Notice(t('view.noteActions.moveFailed'));
    return false;
  }
}

/**
 * The folder picker used by "Move to…".
 *
 * A fuzzy list of every folder, including the vault root, mirrors Obsidian's
 * own "Move file to…" command. Creating a missing folder is deliberately not
 * offered here; the setting and the built-in command cover that.
 */
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private readonly choose: (folder: TFolder) => void;

  constructor(app: App, choose: (folder: TFolder) => void) {
    super(app);
    this.choose = choose;
    this.setPlaceholder(t('view.noteActions.folderPrompt'));
  }

  getItems(): TFolder[] {
    const folders = new Map<string, TFolder>();
    const root = this.app.vault.getRoot();
    folders.set(root.path, root);
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (file instanceof TFolder) folders.set(file.path, file);
    }
    return Array.from(folders.values()).sort((a, b) =>
      a.path.localeCompare(b.path)
    );
  }

  getItemText(folder: TFolder): string {
    return folderLabel(folder.path);
  }

  onChooseItem(folder: TFolder): void {
    this.choose(folder);
  }
}

export function pickFolderAndMoveNote(
  plugin: IntelliScrollPlugin,
  path: string
): void {
  new FolderSuggestModal(plugin.app, (folder) => {
    void moveNoteToFolder(plugin, path, folder.path);
  }).open();
}

class DeleteNoteModal extends Modal {
  private readonly name: string;
  private readonly resolve: (confirmed: boolean) => void;
  private decided = false;

  constructor(
    app: App,
    name: string,
    resolve: (confirmed: boolean) => void
  ) {
    super(app);
    this.name = name;
    this.resolve = resolve;
  }

  onOpen(): void {
    this.titleEl.setText(t('view.delete.title'));
    this.contentEl.createEl('p', {
      text: t('view.delete.confirm', { name: this.name }),
    });

    const row = this.contentEl.createDiv({ cls: 'modal-button-container' });

    const cancel = row.createEl('button', {
      text: t('view.delete.cancel'),
    });
    cancel.addEventListener('click', () => this.decide(false));

    const confirm = row.createEl('button', {
      cls: 'mod-warning',
      text: t('view.delete.confirmButton'),
    });
    confirm.addEventListener('click', () => this.decide(true));

    // Cancel takes focus, so a stray Enter does not delete the note.
    cancel.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve(false);
  }

  private decide(confirmed: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(confirmed);
    this.close();
  }
}

/**
 * Ask, then delete the note at `path`.
 *
 * Returns false when the path no longer names a file or the reader cancelled;
 * a deletion failure is thrown so the caller can report it instead of
 * pretending the note is gone.
 */
export async function confirmAndDeleteNote(
  plugin: IntelliScrollPlugin,
  path: string
): Promise<boolean> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;

  const confirmed = await new Promise<boolean>((resolve) => {
    new DeleteNoteModal(plugin.app, file.basename, resolve).open();
  });
  if (!confirmed) return false;

  await plugin.app.fileManager.trashFile(file);
  return true;
}

/**
 * The note-actions menu shared by a card and the floating control.
 *
 * The configured one-click destination appears only when one is set; the
 * generic "Move to…" is always present so the action is still reachable with
 * no configuration.
 */
export function showNoteActionsMenu(options: {
  plugin: IntelliScrollPlugin;
  event: MouseEvent;
  path: string;
}): void {
  const { plugin, event, path } = options;
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;

  const configured = normalizeMoveTargetFolder(
    plugin.data.settings.moveTargetFolder
  );
  const menu = new Menu();

  if (configured.length > 0) {
    menu.addItem((item) =>
      item
        .setTitle(
          t('view.noteActions.moveToConfigured', {
            folder: folderLabel(configured),
          })
        )
        .setIcon('folder-input')
        .onClick(() => {
          void moveNoteToFolder(plugin, path, configured);
        })
    );
  }

  menu.addItem((item) =>
    item
      .setTitle(t('view.noteActions.moveTo'))
      .setIcon('folder-search')
      .onClick(() => pickFolderAndMoveNote(plugin, path))
  );

  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(t('view.noteActions.delete'))
      .setIcon('trash-2')
      .onClick(() => {
        void (async () => {
          try {
            await confirmAndDeleteNote(plugin, path);
          } catch (error) {
            console.error('[intelliscroll] could not delete note', error);
            new Notice(t('view.delete.failed'));
          }
        })();
      })
  );

  menu.showAtMouseEvent(event);
}
