import { buildSpecV1, findRuleSet, findSpec, SPEC_V1_ID, uid } from './library';
import type {
  BrailleToken,
  ProofIssue,
  ProjectState,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
} from './types';

export { uid, makeRule };

const LETTERS: Record<string, string> = {
  a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊', j: '⠚',
  k: '⠅', l: '⠇', m: '⠍', n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗', s: '⠎', t: '⠞',
  u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵',
};

const DEFAULT_PUNCTUATION: Record<string, string> = {
  ',': '⠂', ';': '⠆', ':': '⠒', '.': '⠲', '!': '⠖', '?': '⠦', '(': '⠐⠣', ')': '⠐⠜',
  '-': '⠤', '—': '⠠⠤', '"': '⠦', "'": '⠄', '/': '⠸⠌', '&': '⠈⠯', '@': '⠈⠁',
};

const DIGITS: Record<string, string> = {
  '0': '⠚', '1': '⠁', '2': '⠃', '3': '⠉', '4': '⠙', '5': '⠑', '6': '⠋', '7': '⠛', '8': '⠓', '9': '⠊',
};

function activeRule(ruleSet: RuleSet, source: string, kind: TranscriptionRule['kind']): TranscriptionRule | undefined {
  return ruleSet.rules.find((rule) => rule.enabled && rule.kind === kind && rule.source.toLocaleLowerCase() === source.toLocaleLowerCase());
}

function matchContraction(ruleSet: RuleSet, source: string, index: number): TranscriptionRule | undefined {
  if (!ruleSet.contractions) return undefined;
  const before = source[index - 1] ?? '';
  if (/[\p{L}\p{N}]/u.test(before)) return undefined;

  const candidates = ruleSet.rules
    .filter((rule) => rule.enabled && rule.kind === 'contraction')
    .sort((a, b) => b.source.length - a.source.length);

  const rest = source.slice(index).toLocaleLowerCase();
  return candidates.find((rule) => rest.startsWith(rule.source.toLocaleLowerCase()));
}

function addToken(
  tokens: BrailleToken[],
  text: string,
  braille: string,
  kind: BrailleToken['kind'],
  offset: number,
  rule?: TranscriptionRule,
): void {
  tokens.push({
    id: uid('token'),
    text,
    braille,
    kind,
    ruleId: rule?.id,
    suspicious: Boolean(rule?.suspicious),
    offset,
  });
}

export function transcribeLine(source: string, ruleSet: RuleSet, continuesPrevious = false): BrailleToken[] {
  const tokens: BrailleToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const lower = char.toLocaleLowerCase();

    if (/\s/u.test(char)) {
      addToken(tokens, char, ' ', 'special', index);
      index += 1;
      continue;
    }

    const contraction = matchContraction(ruleSet, source, index);
    if (contraction) {
      addToken(tokens, source.slice(index, index + contraction.source.length), contraction.output, 'contraction', index, contraction);
      index += contraction.source.length;
      continue;
    }

    if (/\d/u.test(char)) {
      const start = index;
      let number = '';
      while (index < source.length && /\d/u.test(source[index])) {
        number += source[index];
        index += 1;
      }
      const numberRule = activeRule(ruleSet, '#', 'number');
      addToken(tokens, number, `${numberRule?.output ?? '⠼'}${[...number].map((digit) => DIGITS[digit]).join('')}`, 'number', start, numberRule);
      continue;
    }

    if (/[A-Z]/u.test(char)) {
      const capitalRule = activeRule(ruleSet, 'capital', 'special');
      addToken(tokens, char, `${capitalRule?.output ?? '⠠'}${LETTERS[lower]}`, 'letter', index, capitalRule);
      index += 1;
      continue;
    }

    if (/[a-z]/iu.test(char)) {
      const rule = activeRule(ruleSet, lower, 'letter');
      const output = rule?.output ?? LETTERS[lower] ?? '⠿';
      addToken(tokens, char, output, 'letter', index, rule);
      if (!rule) {
        addToken(tokens, '', '⟦未配置⟧', 'special', index);
      }
      index += 1;
      continue;
    }

    const punctuation = activeRule(ruleSet, char, 'punctuation') ?? activeRule(ruleSet, char.toLocaleLowerCase(), 'punctuation');
    if (punctuation) {
      addToken(tokens, char, punctuation.output, 'punctuation', index, punctuation);
      index += 1;
      continue;
    }

    const fallback = DEFAULT_PUNCTUATION[char];
    addToken(tokens, char, fallback ?? '⠿', 'punctuation', index);
    if (!fallback) addToken(tokens, '', '⟦无对应规则⟧', 'special', index);
    index += 1;
  }

  if (source.trimEnd().endsWith('-')) {
    addToken(tokens, '', ruleSet.hyphenMode === 'cross-line' ? '⠤↳' : '⠤', 'special', Math.max(0, source.length - 1));
  }

  if (continuesPrevious && ruleSet.hyphenMode === 'cross-line') {
    tokens.unshift({
      id: uid('token'),
      text: '',
      braille: '↳ ',
      kind: 'special',
      suspicious: true,
      offset: 0,
    });
  }

  return tokens;
}

function makeIssue(
  line: TextbookLine,
  code: string,
  message: string,
  severity: ProofIssue['severity'],
  token?: BrailleToken,
): ProofIssue {
  return {
    id: uid('issue'),
    lineId: line.id,
    tokenId: token?.id,
    ruleId: token?.ruleId,
    severity,
    code,
    message,
    resolved: false,
  };
}

function analyzeLine(line: TextbookLine, previousLine?: TextbookLine): { line: TextbookLine; issues: ProofIssue[] } {
  const issues: ProofIssue[] = [];
  const tokenText = line.tokens.map((token) => token.braille).join('');
  const hasContinuation = line.source.trimEnd().endsWith('-');
  const previousContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));
  const nextLine = {
    ...line,
    continuesPrevious: previousContinues,
    continuesNext: hasContinuation,
  };

  if (hasContinuation) {
    issues.push(makeIssue(nextLine, 'cross-line-hyphen', '此行以连字符结尾，已插入跨行连接标记；请核对断词位置。', 'warning', nextLine.tokens.at(-1)));
  }

  for (const token of nextLine.tokens) {
    if (token.suspicious) {
      issues.push(makeIssue(nextLine, 'suspicious-rule', `规则“${token.text}”被标记为可疑转写。`, 'warning', token));
    }
    if (token.text && token.braille.includes('⟦')) {
      issues.push(makeIssue(nextLine, 'unknown-symbol', `“${token.text}”没有可用的转写规则。`, 'error', token));
    }
  }

  if (tokenText.replace(/\s/g, '').length > 42) {
    issues.push(makeIssue(nextLine, 'line-too-long', `盲文结果为 ${tokenText.replace(/\s/g, '').length} 格，建议重新分词。`, 'info'));
  }

  if (hasContinuation && nextLine.source.trimEnd().split(/\s+/).at(-1)?.replace(/-$/, '').length === 1) {
    issues.push(makeIssue(nextLine, 'orphan-fragment', '断词后仅剩一个字母，教学排版中通常应整体移到下一行。', 'warning'));
  }

  // 已批准行不因规范重走而被悄悄降级；批准冻结以 approvedTokens 为准。
  if (nextLine.status !== 'approved') {
    if (issues.some((item) => item.severity === 'error')) {
      nextLine.status = 'questionable';
    } else if (issues.length > 0 && nextLine.status === 'unchecked') {
      nextLine.status = 'questionable';
    }
  }

  return { line: nextLine, issues };
}

/**
 * 按每行钉住的规范版本重走转录：
 * - 已批准且带冻结盲文的行，盲文与跨行标记保持批准时原样（规范更新只能走对账）；
 * - 对账中“保留旧稿”的行继续按旧版本规则转写，原文与备注不动。
 */
export function analyzeProject(state: ProjectState): ProjectState {
  const nextLines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  state.lines.forEach((line, index) => {
    const previousLine = state.lines[index - 1];
    const previousSourceContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));
    const spec = findSpec(state, line.specVersionId ?? state.specAttribution.specVersionId);
    const ruleSet = findRuleSet(spec, state.activeRuleSetId);

    let working: TextbookLine;
    if (line.status === 'approved' && line.approvedTokens && line.approvedTokens.length > 0) {
      // 冻结批准盲文：连跨行前缀/后缀标记也保持批准时刻原样。
      working = {
        ...line,
        tokens: structuredClone(line.approvedTokens),
        specVersionId: line.specVersionId ?? spec.id,
        continuesPrevious: line.approvedTokens.some((token) => token.braille.startsWith('↳')),
        continuesNext: line.source.trimEnd().endsWith('-'),
      };
    } else {
      const tokens = transcribeLine(line.source, ruleSet, previousSourceContinues);
      working = { ...line, tokens, specVersionId: spec.id, approvedTokens: line.status === 'approved' ? line.approvedTokens ?? null : null };
    }

    const analyzed = analyzeLine(working, previousLine);
    // 批准冻结行不再重新生成问题（批准时的决定不能被新规范悄悄推翻）。
    const frozen = line.status === 'approved' && line.approvedTokens && line.approvedTokens.length > 0;
    if (!frozen && analyzed.line.status === 'approved' && !(analyzed.line.approvedTokens?.length)) {
      analyzed.line.approvedTokens = structuredClone(analyzed.line.tokens);
    }
    nextLines.push(analyzed.line);
    if (!frozen) issues.push(...analyzed.issues);
  });

  return {
    ...state,
    lines: nextLines,
    issues,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function updateRuleInSet(ruleSet: RuleSet, ruleId: string, patch: Partial<TranscriptionRule>): RuleSet {
  return {
    ...ruleSet,
    rules: ruleSet.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
  };
}

/** 学校本地的规则编辑落在当前归属版本上（取回新版本不会覆盖这些本地修改）。 */
export function updateRulesInSpec(state: ProjectState, updateSet: (ruleSet: RuleSet) => RuleSet): ProjectState {
  const specVersionId = state.specAttribution.specVersionId;
  return {
    ...state,
    specVersions: state.specVersions.map((spec) => (spec.id !== specVersionId
      ? spec
      : { ...spec, ruleSets: spec.ruleSets.map((set) => (set.id === state.activeRuleSetId ? updateSet(set) : set)) })),
  };
}

function makeRule(source: string, output: string, suspicious: boolean, kind: TranscriptionRule['kind'] = 'contraction'): TranscriptionRule {
  return {
    id: uid('rule'),
    source,
    output,
    kind,
    enabled: true,
    suspicious,
    description: '自定义规则',
  };
}

export function outputText(state: ProjectState): string {
  return state.lines.map((line, index) => `${String(index + 1).padStart(3, '0')}  ${line.tokens.map((token) => token.braille).join('')}`).join('\n');
}

export function brailleCellCount(state: ProjectState): number {
  return state.lines.reduce((total, line) => total + line.tokens.reduce((count, token) => count + token.braille.replace(/\s/g, '').length, 0), 0);
}

/**
 * 旧稿首次打开补归属：早于规范库版本化的草稿没有 spec 字段，
 * 统一补到 2025 现行版；已批准行用现有盲文就地冻结，原文和校对备注一律不动。
 */
export function migrateProject(raw: any): { state: ProjectState; migrated: boolean } {
  const legacy = Array.isArray(raw?.ruleSets) && !Array.isArray(raw?.specVersions);
  const specV1 = buildSpecV1();

  if (!legacy) {
    const state = raw as ProjectState;
    return { state, migrated: false };
  }

  const legacyRuleSets = (raw.ruleSets ?? []) as RuleSet[];
  const spec: ProjectState['specVersions'][number] = {
    ...specV1,
    ruleSets: legacyRuleSets.length > 0 ? legacyRuleSets : specV1.ruleSets,
  };

  const nowIso = new Date().toISOString();
  const lines = Array.isArray(raw.lines) ? raw.lines : [];
  const migrated: ProjectState = {
    ...raw,
    specVersions: [spec],
    specAttribution: {
      specVersionId: SPEC_V1_ID,
      specVersionLabel: specV1.label,
      appliedAt: nowIso,
    },
    reconcileItems: Array.isArray(raw.reconcileItems) ? raw.reconcileItems : [],
    sync: raw.sync ?? {
      endpoint: '教研组规范库（模拟）',
      online: typeof navigator !== 'undefined' ? navigator.onLine : false,
      fetchStatus: 'idle',
      lastFetchedAt: null,
      lastFetchError: null,
      reportStatus: 'idle',
      lastSyncedAt: null,
      lastSyncError: null,
    },
    lines: lines.map((line: TextbookLine) => ({
      ...line,
      specVersionId: line.specVersionId ?? SPEC_V1_ID,
      approvedTokens: line.status === 'approved'
        ? line.approvedTokens ?? (line.tokens.length > 0 ? structuredClone(line.tokens) : null)
        : (line.approvedTokens ?? null),
    })),
    updatedAt: nowIso,
  };

  return { state: migrated, migrated: true };
}
