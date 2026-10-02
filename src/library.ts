import type { ProjectState, RuleSet, SpecVersion, SyncState, TranscriptionRule } from './types';

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const SPEC_V1_ID = 'ueb-2025-spring';
export const SPEC_V2_ID = 'ueb-2026-autumn';

const letters = 'abcdefghijklmnopqrstuvwxyz'.split('').map<TranscriptionRule>((letter, index) => ({
  id: `letter-${letter}`,
  source: letter,
  output: '⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵'[index],
  kind: 'letter' as const,
  enabled: true,
  suspicious: false,
  description: '拉丁字母基础表',
}));

const punctuation: TranscriptionRule[] = [
  [',', '⠂', '逗号'], ['.', '⠲', '句号'], ['?', '⠦', '问号'], ['!', '⠖', '叹号'], [';', '⠆', '分号'], [':', '⠒', '冒号'], ['-', '⠤', '连字符'],
].map(([source, output, description]) => ({
  id: `punctuation-${source}`,
  source,
  output,
  kind: 'punctuation' as const,
  enabled: true,
  suspicious: false,
  description,
}));

const contractions: TranscriptionRule[] = [
  ['and', '⠯', false, '高频缩写'], ['the', '⠮', false, '高频缩写'], ['for', '⠿', true, '低年级教材可改为完整拼写'],
  ['of', '⠷', false, '高频缩写'], ['with', '⠾', false, '高频缩写'], ['ing', '⠬', true, '词尾缩写'],
  ['ed', '⠫', true, '词尾缩写'], ['er', '⠻', false, '词尾缩写'], ['ch', '⠡', false, '字母组合'], ['sh', '⠩', false, '字母组合'], ['th', '⠹', false, '字母组合'],
].map(([source, output, suspicious, description]) => ({
  id: `contraction-${source}`,
  source: String(source),
  output: String(output),
  kind: 'contraction' as const,
  enabled: true,
  suspicious: Boolean(suspicious),
  description: String(description),
}));

const commonRules: TranscriptionRule[] = [
  { id: 'number-sign', source: '#', output: '⠼', kind: 'number', enabled: true, suspicious: false, description: '数字起始符' },
  { id: 'capital-sign', source: 'capital', output: '⠠', kind: 'special', enabled: true, suspicious: false, description: '大写起始符' },
  ...letters,
  ...punctuation,
];

export function buildRuleSetsV1(): RuleSet[] {
  // 深拷贝，保证学校本地的规则编辑不污染规范版本原件。
  const sets: RuleSet[] = [
    {
      id: 'ueb-teaching',
      name: 'UEB 教学规则',
      description: '英美盲文教学规则，默认启用常用缩写并将低年级易混淆缩写标为可疑。',
      contractions: true,
      hyphenMode: 'cross-line',
      rules: [...commonRules, ...contractions],
    },
    {
      id: 'literary-standard',
      name: '通用文学盲文',
      description: '保留完整缩写表，适合课外读本和工作表。',
      contractions: true,
      hyphenMode: 'inline',
      rules: [...commonRules, ...contractions.filter((rule) => !rule.suspicious)],
    },
    {
      id: 'spelling-first',
      name: '逐字拼读（无缩写）',
      description: '低年级识字课使用，关闭缩写和跨行连字符压缩。',
      contractions: false,
      hyphenMode: 'inline',
      rules: commonRules,
    },
  ];
  return structuredClone(sets);
}

function patchRule(rules: TranscriptionRule[], source: string, patch: Partial<TranscriptionRule>): TranscriptionRule[] {
  return rules.map((rule) => (rule.source === source ? { ...rule, ...patch } : rule));
}

/** 2026 秋修订：词尾 ing 改用新盲文、新增 light 缩写、教学规则集不再压缩跨行连字符。 */
export function buildSpecV2(): SpecVersion {
  const ruleSets = buildRuleSetsV1().map((set) => {
    if (set.id === 'spelling-first') return set;

    let rules = set.rules;
    rules = patchRule(rules, 'ing', { output: '⠘⠬', suspicious: false, description: '词尾缩写（2026 秋修订）' });
    const newContractions: TranscriptionRule[] = [
      { id: 'contraction-light', source: 'light', output: '⠇⠒⠞', kind: 'contraction', enabled: true, suspicious: false, description: '高频缩写（2026 秋新增）' },
      { id: 'contraction-said', source: 'said', output: '⠎⠙', kind: 'contraction', enabled: true, suspicious: false, description: '高频缩写（2026 秋新增）' },
    ];
    newContractions.forEach((rule) => {
      if (!rules.some((item) => item.source === rule.source)) rules = [...rules, rule];
    });
    const next: RuleSet = { ...set, rules };
    if (set.id === 'ueb-teaching') {
      next.hyphenMode = 'inline';
      next.description = '英美盲文教学规则（2026 秋修订）：新增 light 缩写，跨行连字符不再压缩，统一逐行转写。';
    }
    return next;
  });

  return {
    id: SPEC_V2_ID,
    label: 'UEB 教研组规范 · 2026 秋修订',
    releasedAt: '2026-09-20',
    notes: '词尾 ing 盲文更新；新增 light 缩写；教学规则集跨行连字符改为不压缩。受影响的已批准行与断词、跨行连字符需逐行对账。',
    ruleSets,
  };
}

export function buildSpecV1(): SpecVersion {
  return {
    id: SPEC_V1_ID,
    label: 'UEB 教研组规范 · 2025 现行版',
    releasedAt: '2025-08-15',
    notes: '教研组维护的基础版本。',
    ruleSets: buildRuleSetsV1(),
  };
}

export function defaultSyncState(online: boolean): SyncState {
  return {
    endpoint: '教研组规范库（模拟）',
    online,
    fetchStatus: 'idle',
    lastFetchedAt: null,
    lastFetchError: null,
    reportStatus: 'idle',
    lastSyncedAt: null,
    lastSyncError: null,
  };
}

export function findSpec(state: ProjectState, specVersionId?: string): SpecVersion {
  return state.specVersions.find((version) => version.id === specVersionId)
    ?? state.specVersions.find((version) => version.id === state.specAttribution.specVersionId)
    ?? state.specVersions[0];
}

export function findRuleSet(spec: SpecVersion, ruleSetId: string): RuleSet {
  return spec.ruleSets.find((set) => set.id === ruleSetId) ?? spec.ruleSets[0];
}
