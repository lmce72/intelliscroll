import type { MessageModule } from '../i18n.ts';

/**
 * Messages for the settings tab (`src/settings.ts`).
 *
 * Key convention: `<area>.<feature>.<field>`, where field is one of
 * `name` (the control's label), `desc` (its description), `option` (a dropdown
 * entry), or `action` (a button). Keep the area prefix even though this file is
 * already area-scoped: the merged table is flat, so prefixes are what keep two
 * areas from colliding.
 */
export const messages: MessageModule = {
  en: {
    'settings.header.title': 'IntelliScroll settings',

    'settings.language.name': 'Language',
    'settings.language.desc':
      'Language for this plugin. Automatic follows Obsidian.',
    'settings.language.option.auto': 'Automatic',
    'settings.language.option.en': 'English',
    'settings.language.option.zh': '简体中文',

    'settings.batchSize.name': 'Batch size',
    'settings.batchSize.desc': 'Number of cards to show per reshuffle',

    'settings.infiniteScroll.name': 'Infinite scrolling',
    'settings.infiniteScroll.desc':
      'Automatically load more notes as you reach the end of the feed',

    'settings.openNoteBehavior.name': 'Open notes in',
    'settings.openNoteBehavior.desc': 'Choose where a card opens',
    'settings.openNoteBehavior.option.tab': 'New tab',
    'settings.openNoteBehavior.option.reuse': 'Reuse current tab',
    'settings.openNoteBehavior.option.window': 'New window',
  },
  zh: {
    'settings.header.title': 'IntelliScroll 设置',

    'settings.language.name': '语言',
    'settings.language.desc': '本插件的界面语言。「自动」跟随 Obsidian 的设置。',
    'settings.language.option.auto': '自动',
    'settings.language.option.en': 'English',
    'settings.language.option.zh': '简体中文',

    'settings.batchSize.name': '每批卡片数',
    'settings.batchSize.desc': '每次重掷时展示多少张卡片',

    'settings.infiniteScroll.name': '无限滚动',
    'settings.infiniteScroll.desc': '滚动到卡片流末尾时自动加载更多笔记',

    'settings.openNoteBehavior.name': '打开笔记的方式',
    'settings.openNoteBehavior.desc': '选择点击卡片时笔记在哪里打开',
    'settings.openNoteBehavior.option.tab': '新标签页',
    'settings.openNoteBehavior.option.reuse': '复用当前标签页',
    'settings.openNoteBehavior.option.window': '新窗口',
  },
};
