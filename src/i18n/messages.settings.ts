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
    'settings.header.action.reportIssue': 'Report issue',

    'settings.language.name': 'Language',
    'settings.language.desc':
      'Language for this plugin. Automatic follows Obsidian.',
    'settings.language.option.auto': 'Automatic',
    'settings.language.option.en': 'English',
    'settings.language.option.zh': '简体中文',

    'settings.feed.title': 'Feed',

    'settings.batchSize.name': 'Batch size',
    'settings.batchSize.desc': 'Number of cards to show per reshuffle',

    'settings.infiniteScroll.name': 'Infinite scrolling',
    'settings.infiniteScroll.desc':
      'Automatically load more notes as you reach the end of the feed',

    'settings.includeMediaOnlyNotes.name': 'Include media-only notes',
    'settings.includeMediaOnlyNotes.desc':
      'Show Markdown notes containing only images or other attachments',

    'settings.showNonMarkdownFiles.name': 'Show non-Markdown files',
    'settings.showNonMarkdownFiles.desc':
      'Show standalone vault files such as images, PDFs, and other attachments',

    'settings.simplifiedView.name': 'Simplified view',
    'settings.simplifiedView.desc':
      'Show concise previews with readable tables, links, and code; turn off for full Markdown formatting.',

    'settings.reduceAnimations.name': 'Reduce animation',
    'settings.reduceAnimations.desc':
      'Disable card and scrolling animations during keyboard navigation',

    'settings.previewSize.name': 'Preview size',
    'settings.previewSize.desc': 'How many lines of note text to show on each card',
    'settings.previewSize.option.small': 'Small',
    'settings.previewSize.option.medium': 'Medium',
    'settings.previewSize.option.large': 'Large',

    'settings.searchQuery.name': 'Search query',
    'settings.searchQuery.desc':
      'Filter notes using Obsidian-style search syntax, such as tag:#work or [status:Draft]',

    'settings.openNoteBehavior.name': 'Open notes in',
    'settings.openNoteBehavior.desc': 'Choose where a card opens',
    'settings.openNoteBehavior.option.tab': 'New tab',
    'settings.openNoteBehavior.option.reuse': 'Reuse current tab',
    'settings.openNoteBehavior.option.window': 'New window',

    'settings.excludeTags.name': 'Exclude tags',
    'settings.excludeTags.desc': 'Tags to skip without # (one per line)',

    'settings.excludeGlobs.name': 'Exclude filename patterns',
    'settings.excludeGlobs.desc':
      'Filename patterns to skip (one per line, e.g., _*)',

    'settings.frontmatterImageProps.name': 'Frontmatter image properties',
    'settings.frontmatterImageProps.desc':
      'Property names to check for images in frontmatter (one per line)',

    'settings.frontmatterBeforeProps.name': 'Frontmatter properties before preview',
    'settings.frontmatterBeforeProps.desc':
      'Property names to render before the note body (one per line)',

    'settings.frontmatterAfterProps.name': 'Frontmatter properties after preview',
    'settings.frontmatterAfterProps.desc':
      'Property names to render after the note body (one per line)',

    'settings.excludedFolders.name': 'Excluded folders',
    'settings.excludedFolders.empty': 'No excluded folders',
    'settings.excludedFolders.remove': 'Remove excluded folder {folder}',

    'settings.addExcludedFolder.name': 'Add excluded folder',
    'settings.addExcludedFolder.desc': 'Folders to skip (type or choose a folder)',
    'settings.addExcludedFolder.action': 'Add',

    'settings.notice.folderEmpty':
      'Excluded folder path cannot be empty or the vault root',
    'settings.notice.folderDuplicate': 'That folder is already excluded',

    'settings.algorithm.name': 'Algorithm',
    'settings.algorithm.desc':
      'Decide which notes resurface and when. Off keeps the original shuffled feed and writes nothing.',

    'settings.gradingMode.name': 'Grading',
    'settings.gradingMode.desc': 'How a note gets rated as you scroll past it',
    'settings.gradingMode.option.auto': 'Automatic only',
    'settings.gradingMode.option.hybrid': 'Automatic, with manual override',
    'settings.gradingMode.option.manual': 'Manual only',

    'settings.sensitivity.name': 'Automatic grading sensitivity',
    'settings.sensitivity.desc':
      'How much evidence counts as engagement. Only ever rates a note as engaged; it never records a failure.',
    'settings.sensitivity.option.conservative': 'Conservative',
    'settings.sensitivity.option.medium': 'Medium',
    'settings.sensitivity.option.aggressive': 'Aggressive',

    'settings.requestRetention.name': 'Desired retention',
    'settings.requestRetention.desc':
      'Target chance of still remembering a note when it returns. Higher means shorter intervals and many more reviews; 0.85-0.90 suits most people.',

    'settings.maximumInterval.name': 'Maximum interval',
    'settings.maximumInterval.desc':
      'Longest gap in days before a note is shown again',

    'settings.enableFuzz.name': 'Fuzz due dates',
    'settings.enableFuzz.desc':
      'Spread due dates slightly so notes do not all return on the same day',
  },
  zh: {
    'settings.header.title': 'IntelliScroll 设置',
    'settings.header.action.reportIssue': '反馈问题',

    'settings.language.name': '语言',
    'settings.language.desc': '本插件的界面语言。「自动」跟随 Obsidian 的设置。',
    'settings.language.option.auto': '自动',
    'settings.language.option.en': 'English',
    'settings.language.option.zh': '简体中文',

    'settings.feed.title': '卡片流',

    'settings.batchSize.name': '每批卡片数',
    'settings.batchSize.desc': '每次重掷时展示多少张卡片',

    'settings.infiniteScroll.name': '无限滚动',
    'settings.infiniteScroll.desc': '滚动到卡片流末尾时自动加载更多笔记',

    'settings.includeMediaOnlyNotes.name': '包含纯媒体笔记',
    'settings.includeMediaOnlyNotes.desc':
      '显示只包含图片或其他附件的 Markdown 笔记',

    'settings.showNonMarkdownFiles.name': '显示非 Markdown 文件',
    'settings.showNonMarkdownFiles.desc':
      '显示库内独立的文件，如图片、PDF 和其他附件',

    'settings.simplifiedView.name': '简化视图',
    'settings.simplifiedView.desc':
      '以简洁方式预览，表格、链接和代码更易读；关闭后使用完整的 Markdown 格式。',

    'settings.reduceAnimations.name': '减少动画',
    'settings.reduceAnimations.desc': '键盘导航时禁用卡片和滚动动画',

    'settings.previewSize.name': '预览长度',
    'settings.previewSize.desc': '每张卡片显示多少行笔记正文',
    'settings.previewSize.option.small': '短',
    'settings.previewSize.option.medium': '中',
    'settings.previewSize.option.large': '长',

    'settings.searchQuery.name': '搜索查询',
    'settings.searchQuery.desc':
      '使用 Obsidian 风格的搜索语法过滤笔记，例如 tag:#work 或 [status:Draft]',

    'settings.openNoteBehavior.name': '打开笔记的方式',
    'settings.openNoteBehavior.desc': '选择点击卡片时笔记在哪里打开',
    'settings.openNoteBehavior.option.tab': '新标签页',
    'settings.openNoteBehavior.option.reuse': '复用当前标签页',
    'settings.openNoteBehavior.option.window': '新窗口',

    'settings.excludeTags.name': '排除标签',
    'settings.excludeTags.desc': '要跳过的标签，不带 #（每行一个）',

    'settings.excludeGlobs.name': '排除文件名模式',
    'settings.excludeGlobs.desc': '要跳过的文件名模式（每行一个，例如 _*）',

    'settings.frontmatterImageProps.name': 'Frontmatter 图片属性',
    'settings.frontmatterImageProps.desc':
      '在 frontmatter 中检查图片的属性名（每行一个）',

    'settings.frontmatterBeforeProps.name': '预览前的 Frontmatter 属性',
    'settings.frontmatterBeforeProps.desc':
      '在笔记正文前渲染的属性名（每行一个）',

    'settings.frontmatterAfterProps.name': '预览后的 Frontmatter 属性',
    'settings.frontmatterAfterProps.desc':
      '在笔记正文后渲染的属性名（每行一个）',

    'settings.excludedFolders.name': '排除的文件夹',
    'settings.excludedFolders.empty': '没有排除的文件夹',
    'settings.excludedFolders.remove': '移除排除的文件夹 {folder}',

    'settings.addExcludedFolder.name': '添加排除的文件夹',
    'settings.addExcludedFolder.desc': '要跳过的文件夹（输入或选择文件夹）',
    'settings.addExcludedFolder.action': '添加',

    'settings.notice.folderEmpty': '排除的文件夹路径不能为空，也不能是库根目录',
    'settings.notice.folderDuplicate': '该文件夹已在排除列表中',

    'settings.algorithm.name': '算法',
    'settings.algorithm.desc':
      '决定哪些笔记、何时重新浮现。「关闭」保留原本的随机卡片流，不写入任何数据。',

    'settings.gradingMode.name': '评分方式',
    'settings.gradingMode.desc': '滚动经过笔记时如何给它评级',
    'settings.gradingMode.option.auto': '仅自动',
    'settings.gradingMode.option.hybrid': '自动为主，可手动覆盖',
    'settings.gradingMode.option.manual': '仅手动',

    'settings.sensitivity.name': '自动评分灵敏度',
    'settings.sensitivity.desc':
      '多少证据才算「已浏览」。它只会把笔记评为已浏览，从不记录失败。',
    'settings.sensitivity.option.conservative': '保守',
    'settings.sensitivity.option.medium': '适中',
    'settings.sensitivity.option.aggressive': '激进',

    'settings.requestRetention.name': '目标记忆保持率',
    'settings.requestRetention.desc':
      '笔记再次出现时仍记得的目标概率。数值越高，间隔越短、复习次数越多；0.85-0.90 适合大多数人。',

    'settings.maximumInterval.name': '最大间隔',
    'settings.maximumInterval.desc': '笔记再次出现前的最长间隔天数',

    'settings.enableFuzz.name': '到期日模糊化',
    'settings.enableFuzz.desc': '略微分散到期日，避免所有笔记都在同一天回来',
  },
};
