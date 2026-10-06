import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import { guideSections, type GuideBlock } from './guide.ts';
import { t } from './i18n.ts';

/**
 * The algorithm guide, rendered.
 *
 * A modal rather than a vault note. The whole point of this plugin is that it
 * never writes into your vault, and a reference that arrived as a file would
 * be the one exception — so it is bundled and rendered instead. That also means
 * it is always there, cannot be deleted by accident, and matches the plugin
 * version rather than whatever was copied into the vault years ago.
 *
 * Built with `createEl` throughout: no `innerHTML`, so prose that ever contains
 * an angle bracket is text rather than markup.
 */
export class GuideModal extends Modal {
  onOpen(): void {
    this.modalEl.addClass('intelliscroll-guide-modal');
    this.contentEl.addClass('intelliscroll-guide');

    const header = this.contentEl.createDiv('intelliscroll-guide-header');
    header.createEl('h2', { text: t('guide.title'), cls: 'intelliscroll-guide-h1' });
    header.createDiv({
      cls: 'intelliscroll-guide-subtitle',
      text: t('guide.subtitle'),
    });

    const body = this.contentEl.createDiv('intelliscroll-guide-body');
    for (const section of guideSections()) {
      const el = body.createEl('section', { cls: 'intelliscroll-guide-section' });
      el.id = `intelliscroll-guide-${section.id}`;
      el.createEl('h3', { text: section.title, cls: 'intelliscroll-guide-h2' });
      renderBlocks(el, section.blocks);
    }

    this.contentEl.createDiv({
      cls: 'intelliscroll-guide-footer',
      text: t('guide.footer'),
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function renderBlocks(parent: HTMLElement, blocks: readonly GuideBlock[]): void {
  for (const block of blocks) {
    switch (block.kind) {
      case 'p':
        parent.createEl('p', { text: block.text });
        break;

      case 'h':
        parent.createEl('h4', { text: block.text, cls: 'intelliscroll-guide-h3' });
        break;

      case 'ul':
      case 'ol': {
        const list = parent.createEl(block.kind === 'ul' ? 'ul' : 'ol');
        for (const item of block.items) list.createEl('li', { text: item });
        break;
      }

      case 'code':
        // `textContent`, not `innerText`, so indentation survives into the
        // preformatted block rather than being collapsed.
        parent.createEl('pre', { cls: 'intelliscroll-guide-code' }).createEl('code', {
          text: block.text,
        });
        break;

      case 'table': {
        const table = parent.createEl('table', { cls: 'intelliscroll-guide-table' });
        const head = table.createEl('thead').createEl('tr');
        for (const cell of block.head) head.createEl('th', { text: cell });
        const tbody = table.createEl('tbody');
        for (const row of block.rows) {
          const tr = tbody.createEl('tr');
          for (const cell of row) tr.createEl('td', { text: cell });
        }
        break;
      }

      case 'note':
        parent.createDiv({ cls: 'intelliscroll-guide-note', text: block.text });
        break;

      case 'example': {
        const box = parent.createDiv('intelliscroll-guide-example');
        box.createDiv({ cls: 'intelliscroll-guide-example-title', text: block.title });
        renderBlocks(box, block.blocks);
        break;
      }
    }
  }
}

/** Open the guide. The one entry point every surface shares. */
export function openGuide(app: App): void {
  new GuideModal(app).open();
}
