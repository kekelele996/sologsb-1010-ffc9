import { analyzeProject } from './braille';
import { buildSpecV1, defaultSyncState, SPEC_V1_ID } from './library';
import type { ProjectState } from './types';

const specV1 = buildSpecV1();

const lines = [
  { id: 'line-1', source: 'The small seed is under the soil.', status: 'questionable' as const, note: '“the”是否符合学生当前缩写进度？' },
  { id: 'line-2', source: 'It needs water, light and time.', status: 'unchecked' as const, note: '' },
  { id: 'line-3', source: 'By Friday, a green shoot appears.', status: 'unchecked' as const, note: '' },
  { id: 'line-4', source: 'The gardener said, "Welcome, little sprout!"', status: 'approved' as const, note: '老师已批准：引号与大写首字复核通过。' },
  { id: 'line-5', source: 'Look-', status: 'unchecked' as const, note: '下一行是同一单词，检查跨行断词。' },
  { id: 'line-6', source: 'ing is learning!', status: 'approved' as const, note: '老师已批准：跨行 Look-ing 断词按现行规范处理。' },
  { id: 'line-7', source: 'Please measure 12 centimetres from the edge.', status: 'unchecked' as const, note: '' },
];

const base: ProjectState = {
  id: 'braille-course-1010',
  title: '春天观察课 · 盲文教材',
  author: '资源教师 / 林老师',
  activeRuleSetId: 'ueb-teaching',
  specVersions: [specV1],
  specAttribution: {
    specVersionId: SPEC_V1_ID,
    specVersionLabel: specV1.label,
    appliedAt: specV1.releasedAt,
  },
  selectedLineId: 'line-1',
  lines: lines.map(({ id, source, status, note }) => ({
    id, source, tokens: [], status, note,
    continuesPrevious: false, continuesNext: false,
    specVersionId: SPEC_V1_ID, approvedTokens: null,
  })),
  issues: [],
  reconcileItems: [],
  sync: defaultSyncState(false),
  versions: [],
  lastCheckedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export function createInitialProject(online = false): ProjectState {
  const analyzed = analyzeProject({ ...base, sync: { ...base.sync, online } });
  // 批准行冻结批准时的盲文。
  return {
    ...analyzed,
    lines: analyzed.lines.map((line) => (line.status === 'approved'
      ? { ...line, approvedTokens: structuredClone(line.tokens) }
      : line)),
  };
}
