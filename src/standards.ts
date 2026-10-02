import type { StandardsLibrary } from './types';
import { ruleSets } from './sample';

/**
 * 教研组维护的盲文转写规范库。
 * 学校这边只存转好的课文稿；规范库由教研组下发，版本号随同步记录。
 * v2 新规范：低年级课文暂不使用 'the'、'ing' 缩写，跨行断词改为 inline 模式。
 */
export const OFFICIAL_LIBRARY: StandardsLibrary = {
  id: 'official-braille-norms',
  name: '教研组 · 盲文转写规范库',
  version: 'v2',
  updatedAt: '2026-09-01T09:00:00.000Z',
  ruleSets: ruleSets.map((set) => {
    if (set.id === 'ueb-teaching') {
      return {
        ...set,
        hyphenMode: 'inline',
        rules: set.rules.filter((rule) => rule.id !== 'contraction-the' && rule.id !== 'contraction-ing'),
      };
    }
    return set;
  }),
};

const SYNC_DELAY = 650;

/**
 * 模拟向教研组规范库发起同步请求。
 * 规范库没取回（离线 / 请求失败）时 reject，学校这份稿子照旧能改。
 */
export async function fetchStandardsLibrary(): Promise<StandardsLibrary> {
  await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY));
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('规范库未取回：当前设备离线。学校这份稿子仍可照常修改，联网后可重试同步。');
  }
  return structuredClone(OFFICIAL_LIBRARY);
}
