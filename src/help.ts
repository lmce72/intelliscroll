import { App, Modal } from 'obsidian';
import { t } from './i18n';

/**
 * The shortcut list.
 *
 * Built per call rather than kept as a module-level constant: a constant would
 * capture the descriptions in whichever language was active when this module
 * was imported, so switching language later would leave the help in English.
 */
function shortcuts(): Array<[string[], string]> {
  return [
    [['j', '↓'], t('view.help.next')],
    [['k', '↑'], t('view.help.previous')],
    [['Home'], t('view.help.first')],
    [['End'], t('view.help.last')],
    [['Enter', 'o'], t('view.help.open')],
    [['Esc'], t('view.help.clear')],
    [['r'], t('view.help.reshuffle')],
    [['p'], t('view.help.previousBatch')],
    [['?'], t('view.help.show')],
  ];
}

export class ShortcutsModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(t('view.help.title'));
    const list = this.contentEl.createEl('dl', { cls: 'doomscroll-help-list' });
    for (const [keys, description] of shortcuts()) {
      const dt = list.createEl('dt');
      keys.forEach((key) => dt.createEl('kbd', { text: key }));
      list.createEl('dd', { text: description });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
