import type { MessageModule } from '../i18n.ts';

/**
 * Messages for the preset manager (`src/presetSettings.ts`).
 *
 * Key convention: `<area>.<feature>.<field>` — see `messages.settings.ts` for
 * the full rule. Preset names the user typed are data, never translated; only
 * the plugin's own labels belong here.
 *
 * `presets.group.*` holds the bare group words so labels that embed one
 * (`Manage {group} presets`) read naturally in every language; the sentence
 * itself is a template, never a concatenation of translated fragments.
 */
export const messages: MessageModule = {
  en: {
    'presets.section.title': 'Preset manager',
    'presets.section.desc':
      'Configuration is stored as named presets. A total preset bundles one filter, one algorithm and one display preset.',

    'presets.group.filter': 'filter',
    'presets.group.algorithm': 'algorithm',
    'presets.group.display': 'display',
    'presets.group.total': 'total',

    'presets.activeFilter.name': 'Filter preset',
    'presets.activeFilter.desc':
      'Which set of filters is in force. The settings below edit this preset.',

    'presets.activeAlgorithm.name': 'Algorithm preset',
    'presets.activeAlgorithm.desc': 'Which scheduling configuration is in force.',

    'presets.activeDisplay.name': 'Display preset',
    'presets.activeDisplay.desc': 'Which set of display options is in force.',

    'presets.activeTotal.name': 'Total preset',
    'presets.activeTotal.desc':
      'A complete configuration. Choose "Custom" to edit the three groups independently.',
    'presets.activeTotal.option.custom': 'Custom (individual presets)',

    'presets.mode.option.blacklist': 'Exclude these',
    'presets.mode.option.whitelist': 'Only these',

    'presets.folders.name': 'Folders',
    'presets.folders.desc':
      'Whether the folder list is excluded, or the only folders allowed.',
    'presets.tags.name': 'Tags',
    'presets.tags.desc': 'Whether the tag list is excluded, or the only tags allowed.',
    'presets.globs.name': 'Filename patterns',
    'presets.globs.desc':
      'Whether the pattern list is excluded, or the only patterns allowed.',
    'presets.fileTypes.name': 'File types',
    'presets.fileTypes.desc':
      'Whether the category list is excluded, or the only categories allowed.',

    'presets.algorithm.option.off': 'Off (shuffled feed)',

    'presets.fileCategories.title': 'File type categories',
    'presets.fileCategories.desc':
      'How the file-type list is read: in "Exclude these" mode a checked category is hidden; in "Only these" mode only checked categories are shown.',
    'presets.fileCategory.image.name': 'Images',
    'presets.fileCategory.image.desc': 'Standalone image files.',
    'presets.fileCategory.document.name': 'Documents',
    'presets.fileCategory.document.desc': 'PDFs, e-books and office documents.',
    'presets.fileCategory.video.name': 'Videos',
    'presets.fileCategory.video.desc': 'Standalone video files.',
    'presets.fileCategory.audio.name': 'Audio',
    'presets.fileCategory.audio.desc': 'Standalone audio files.',
    'presets.fileCategory.other.name': 'Other files',
    'presets.fileCategory.other.desc': 'Any vault file in no other category.',
    'presets.fileCategory.note.name': 'Markdown notes',
    'presets.fileCategory.note.desc': 'Markdown notes in the vault.',

    'presets.manage.name': 'Manage {group} presets',
    'presets.manage.desc':
      'Create, rename, duplicate or delete presets. The last preset in a group cannot be deleted.',

    'presets.action.create': 'New',
    'presets.action.rename': 'Rename',
    'presets.action.duplicate': 'Duplicate',
    'presets.action.delete': 'Delete',
    'presets.action.import': 'Import',
    'presets.action.importJson': 'Import JSON',
    'presets.action.cancel': 'Cancel',
    'presets.action.save': 'Save',

    'presets.rename.title': 'Rename {group} preset',
    'presets.defaultName': 'New {group}',

    'presets.export.library.name': 'Export preset library',
    'presets.export.single.name': 'Export {group} preset',
    'presets.export.desc':
      'Copy the JSON to the clipboard, or save it as a file in the vault.',
    'presets.export.copy': 'Copy JSON',
    'presets.export.vault': 'Save to vault',
    'presets.import.name': 'Import presets',
    'presets.import.desc':
      'Paste exported JSON to add its presets to this library. Existing presets are kept.',
    'presets.importModal.desc':
      'Paste an exported preset JSON below. Imported presets are added to the existing library.',
    'presets.import.placeholder': '{ "version": 1, ... }',

    'presets.backup.title': 'Backup and sharing',

    'presets.notice.exported': 'Exported to {path}',
    'presets.notice.copied': 'Copied preset JSON to the clipboard.',
    'presets.notice.imported':
      'Imported {filters} filter, {algorithms} algorithm, {displays} display and {totals} total presets.',
    'presets.notice.importFailed': 'Import failed: {reason}',
    'presets.notice.importFailedGeneric': 'Import failed.',
    'presets.notice.unknownError': 'unknown error',
    'presets.notice.lastOfGroup': 'The last preset in a group cannot be deleted.',
    'presets.notice.nameRequired': 'A preset needs a non-empty name.',
    'presets.notice.createFailed': 'Could not create the preset.',
    'presets.notice.renameFailed': 'Could not rename the preset.',
    'presets.notice.duplicateFailed': 'Could not duplicate the preset.',
    'presets.notice.deleteFailed': 'Could not delete the preset.',
    'presets.notice.exportBuildFailed': 'Could not build the export.',
    'presets.notice.exportWriteFailed': 'Could not write the export file.',
    'presets.notice.copyFailed': 'Could not copy to the clipboard.',
  },
  zh: {
    'presets.section.title': '预设管理',
    'presets.section.desc':
      '配置以具名预设保存。总预先把过滤、算法、显示各一个预设组合在一起。',

    'presets.group.filter': '过滤',
    'presets.group.algorithm': '算法',
    'presets.group.display': '显示',
    'presets.group.total': '总',

    'presets.activeFilter.name': '过滤预设',
    'presets.activeFilter.desc':
      '当前生效的是哪一套过滤条件。下面的设置修改的就是这个预设。',

    'presets.activeAlgorithm.name': '算法预设',
    'presets.activeAlgorithm.desc': '当前生效的是哪一套调度配置。',

    'presets.activeDisplay.name': '显示预设',
    'presets.activeDisplay.desc': '当前生效的是哪一套显示选项。',

    'presets.activeTotal.name': '总预设',
    'presets.activeTotal.desc': '一套完整的配置。选择「自定义」即可分别编辑三组预设。',
    'presets.activeTotal.option.custom': '自定义（分别选择）',

    'presets.mode.option.blacklist': '排除这些',
    'presets.mode.option.whitelist': '只看这些',

    'presets.folders.name': '文件夹',
    'presets.folders.desc': '排除文件夹列表，还是只允许列表中的文件夹。',
    'presets.tags.name': '标签',
    'presets.tags.desc': '排除标签列表，还是只允许列表中的标签。',
    'presets.globs.name': '文件名模式',
    'presets.globs.desc': '排除模式列表，还是只允许列表中的模式。',
    'presets.fileTypes.name': '文件类型',
    'presets.fileTypes.desc': '排除分类列表，还是只允许列表中的分类。',

    'presets.algorithm.option.off': '关闭（随机卡片流）',

    'presets.fileCategories.title': '文件类型分类',
    'presets.fileCategories.desc':
      '文件类型列表的解读方式：在「排除这些」模式下，勾选的分类会被隐藏；在「只看这些」模式下只显示勾选的分类。',
    'presets.fileCategory.image.name': '图片',
    'presets.fileCategory.image.desc': '独立的图片文件。',
    'presets.fileCategory.document.name': '文档',
    'presets.fileCategory.document.desc': 'PDF、电子书和办公文档。',
    'presets.fileCategory.video.name': '视频',
    'presets.fileCategory.video.desc': '独立的视频文件。',
    'presets.fileCategory.audio.name': '音频',
    'presets.fileCategory.audio.desc': '独立的音频文件。',
    'presets.fileCategory.other.name': '其他文件',
    'presets.fileCategory.other.desc': '不属于其他任何分类的库内文件。',
    'presets.fileCategory.note.name': 'Markdown 笔记',
    'presets.fileCategory.note.desc': '库内的 Markdown 笔记。',

    'presets.manage.name': '管理{group}预设',
    'presets.manage.desc': '新建、重命名、复制或删除预设。一组里最后一个预设不能删除。',

    'presets.action.create': '新建',
    'presets.action.rename': '重命名',
    'presets.action.duplicate': '复制',
    'presets.action.delete': '删除',
    'presets.action.import': '导入',
    'presets.action.importJson': '导入 JSON',
    'presets.action.cancel': '取消',
    'presets.action.save': '保存',

    'presets.rename.title': '重命名{group}预设',
    'presets.defaultName': '新建{group}预设',

    'presets.export.library.name': '导出预设库',
    'presets.export.single.name': '导出{group}预设',
    'presets.export.desc': '把 JSON 复制到剪贴板，或作为文件保存到库内。',
    'presets.export.copy': '复制 JSON',
    'presets.export.vault': '写入库内文件',
    'presets.import.name': '导入预设',
    'presets.import.desc': '粘贴导出的 JSON，把它里面的预设加入本库。现有预设会保留。',
    'presets.importModal.desc':
      '在下方粘贴导出的预设 JSON。导入的预设会加入现有预设库。',
    'presets.import.placeholder': '{ "version": 1, ... }',

    'presets.backup.title': '备份与分享',

    'presets.notice.exported': '已导出到 {path}',
    'presets.notice.copied': '预设 JSON 已复制到剪贴板。',
    'presets.notice.imported':
      '已导入 {filters} 个过滤预设、{algorithms} 个算法预设、{displays} 个显示预设和 {totals} 个总预设。',
    'presets.notice.importFailed': '导入失败：{reason}',
    'presets.notice.importFailedGeneric': '导入失败。',
    'presets.notice.unknownError': '未知错误',
    'presets.notice.lastOfGroup': '一组里最后一个预设不能删除。',
    'presets.notice.nameRequired': '预设的名字不能为空。',
    'presets.notice.createFailed': '无法新建预设。',
    'presets.notice.renameFailed': '无法重命名预设。',
    'presets.notice.duplicateFailed': '无法复制预设。',
    'presets.notice.deleteFailed': '无法删除预设。',
    'presets.notice.exportBuildFailed': '无法生成导出内容。',
    'presets.notice.exportWriteFailed': '无法写入导出文件。',
    'presets.notice.copyFailed': '无法复制到剪贴板。',
  },
};
