import type { MessageModule } from '../i18n.ts';

/**
 * Chrome for the algorithm guide (`src/guide.ts`, `src/guideModal.ts`).
 *
 * Only the frame lives here. The guide's own prose is in `src/guide/*.ts`,
 * because it is a document rather than interface text: it has headings,
 * tables, worked examples and callouts, and flattening that into a flat
 * dotted-key table would lose the structure that makes it readable.
 */
export const messages: MessageModule = {
  en: {
    'guide.action.open': 'Algorithm guide',
    'guide.title': 'How the scheduling works',
    'guide.subtitle':
      'What the model is, what a rating actually does, and where the numbers stop being informative.',
    'guide.footer':
      'Every figure in this guide is reproduced by the test suite, so it cannot drift from the behaviour it describes.',
  },
  zh: {
    'guide.action.open': '算法指南',
    'guide.title': '排期是怎么运作的',
    'guide.subtitle':
      '模型是什么、按下评分到底发生了什么、以及哪些数字什么时候会失去信息量。',
    'guide.footer':
      '本指南里的每个数字都由测试复现，因此不会与它所描述的行为脱节。',
  },
};
