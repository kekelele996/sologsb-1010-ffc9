import type {
  BrailleToken,
  ProofIssue,
  ProjectState,
  Reconciliation,
  ReconciliationItem,
  ReconciliationOrigin,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
} from './types';

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

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

  if (continuesPrevious) {
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

function issue(
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
    issues.push(issue(nextLine, 'cross-line-hyphen', '此行以连字符结尾，已插入跨行连接标记；请核对断词位置。', 'warning', nextLine.tokens.at(-1)));
  }

  for (const token of nextLine.tokens) {
    if (token.suspicious) {
      issues.push(issue(nextLine, 'suspicious-rule', `规则“${token.text}”被标记为可疑转写。`, 'warning', token));
    }
    if (token.text && token.braille.includes('⟦')) {
      issues.push(issue(nextLine, 'unknown-symbol', `“${token.text}”没有可用的转写规则。`, 'error', token));
    }
  }

  if (tokenText.replace(/\s/g, '').length > 42) {
    issues.push(issue(nextLine, 'line-too-long', `盲文结果为 ${tokenText.replace(/\s/g, '').length} 格，建议重新分词。`, 'info'));
  }

  if (hasContinuation && nextLine.source.trimEnd().split(/\s+/).at(-1)?.replace(/-$/, '').length === 1) {
    issues.push(issue(nextLine, 'orphan-fragment', '断词后仅剩一个字母，教学排版中通常应整体移到下一行。', 'warning'));
  }

  if (issues.some((item) => item.severity === 'error')) {
    nextLine.status = 'questionable';
  } else if (issues.length > 0 && nextLine.status === 'unchecked') {
    nextLine.status = 'questionable';
  }

  return { line: nextLine, issues };
}

interface RetranscribeResult {
  lines: TextbookLine[];
  issues: ProofIssue[];
  /** 盲文发生变化的行（仅记旧稿已有盲文的行），key 为 lineId。 */
  changed: Map<string, { oldBraille: string; newBraille: string; breakAffected: boolean; hyphenAffected: boolean }>;
}

/**
 * 按给定规则集重走全部行。
 * 已经老师批准的行保留原盲文、不悄悄重走；变化情况记入 changed，
 * 由对账流程逐行认定。原文和备注一律不动。
 */
function retranscribe(state: ProjectState, ruleSets: RuleSet[]): RetranscribeResult {
  const currentActive = state.ruleSets.find((item) => item.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const activeSet = ruleSets.find((item) => item.id === state.activeRuleSetId) ?? ruleSets[0];
  const hyphenModeChanged = currentActive.hyphenMode !== activeSet.hyphenMode;

  const lines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];
  const changed = new Map<string, { oldBraille: string; newBraille: string; breakAffected: boolean; hyphenAffected: boolean }>();

  state.lines.forEach((line, index) => {
    const previousSourceContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const freshTokens = transcribeLine(line.source, activeSet, previousSourceContinues);
    const oldBraille = line.tokens.map((token) => token.braille).join('');
    const newBraille = freshTokens.map((token) => token.braille).join('');
    const hasOldTokens = line.tokens.length > 0;
    const brailleChanged = hasOldTokens && oldBraille !== newBraille;

    if (line.status === 'approved') {
      // 已批准行：原样保留，不重走、不翻状态；只把变化摆进对账。
      lines.push(line);
      issues.push(...state.issues.filter((item) => item.lineId === line.id && !item.resolved));
      if (brailleChanged) {
        changed.set(line.id, {
          oldBraille,
          newBraille,
          breakAffected: contractionOutputChanged(line.tokens, freshTokens),
          hyphenAffected: crossLineAffected(line, previousSourceContinues, hyphenModeChanged, line.tokens, freshTokens),
        });
      }
      return;
    }

    const analyzed = analyzeLine({ ...line, tokens: freshTokens }, state.lines[index - 1]);
    lines.push(analyzed.line);
    issues.push(...analyzed.issues);
    if (brailleChanged) {
      changed.set(line.id, {
        oldBraille,
        newBraille,
        breakAffected: contractionOutputChanged(line.tokens, freshTokens),
        hyphenAffected: crossLineAffected(line, previousSourceContinues, hyphenModeChanged, line.tokens, freshTokens),
      });
    }
  });

  return { lines, issues, changed };
}

function contractionOutputChanged(oldTokens: BrailleToken[], newTokens: BrailleToken[]): boolean {
  const key = (tokens: BrailleToken[]) => tokens.filter((token) => token.kind === 'contraction').map((token) => token.braille).join('␟');
  return key(oldTokens) !== key(newTokens);
}

function crossLineAffected(
  line: TextbookLine,
  previousSourceContinues: boolean,
  hyphenModeChanged: boolean,
  oldTokens: BrailleToken[],
  newTokens: BrailleToken[],
): boolean {
  const inCrossLinePair = previousSourceContinues || line.source.trimEnd().endsWith('-');
  if (!inCrossLinePair) return false;
  if (hyphenModeChanged) return true;
  const key = (tokens: BrailleToken[]) => tokens.filter((token) => token.braille.includes('↳')).map((token) => token.braille).join('␟');
  return key(oldTokens) !== key(newTokens);
}

export function analyzeProject(state: ProjectState): ProjectState {
  const { lines, issues } = retranscribe(state, state.ruleSets);
  return {
    ...state,
    lines,
    issues,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 按新规则集重走并生成对账。
 * 未批准行直接采用新盲文（标记 accepted）；已批准行保留旧盲文（标记 pending），
 * 等老师逐行认定。只摆变化的行，按行号对齐。
 */
export function buildReconciliation(
  state: ProjectState,
  ruleSets: RuleSet[],
  meta: { origin: ReconciliationOrigin; libraryId: string; libraryVersion: string },
): { lines: TextbookLine[]; issues: ProofIssue[]; reconciliation: Reconciliation | null } {
  const { lines, issues, changed } = retranscribe(state, ruleSets);

  const items: ReconciliationItem[] = state.lines
    .map((line, index) => {
      const diff = changed.get(line.id);
      if (!diff) return null;
      const item: ReconciliationItem = {
        lineId: line.id,
        lineNumber: index + 1,
        source: line.source,
        oldBraille: diff.oldBraille,
        newBraille: diff.newBraille,
        wasApproved: line.status === 'approved',
        breakAffected: diff.breakAffected,
        hyphenAffected: diff.hyphenAffected,
        decision: line.status === 'approved' ? 'pending' : 'accepted',
      };
      return item;
    })
    .filter((item): item is ReconciliationItem => item !== null);

  const pendingCount = items.filter((item) => item.decision === 'pending').length;
  const reconciliation: Reconciliation | null = items.length
    ? {
        id: `recon-${Date.now().toString(36)}`,
        origin: meta.origin,
        libraryId: meta.libraryId,
        libraryVersion: meta.libraryVersion,
        createdAt: new Date().toISOString(),
        status: pendingCount ? 'pending' : 'resolved',
        items,
      }
    : null;

  return { lines, issues, reconciliation };
}

/**
 * 老师逐行认定对账：接受新盲文 / 保留旧盲文。
 * 只动目标行的 tokens 与状态；原文、备注和其他行一律不动。
 */
export function decideReconciliationItem(state: ProjectState, lineId: string, decision: 'accepted' | 'kept'): ProjectState {
  const reconciliation = state.reconciliation;
  if (!reconciliation) return state;
  const item = reconciliation.items.find((entry) => entry.lineId === lineId);
  if (!item || item.decision !== 'pending') return state;

  const index = state.lines.findIndex((line) => line.id === lineId);
  const target = state.lines[index];
  let lines = state.lines;
  let issues = state.issues;

  if (decision === 'accepted') {
    const activeSet = state.ruleSets.find((set) => set.id === state.activeRuleSetId) ?? state.ruleSets[0];
    const previousContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const tokens = transcribeLine(target.source, activeSet, previousContinues);
    const analyzed = analyzeLine({ ...target, tokens }, state.lines[index - 1]);
    const status: TextbookLine['status'] = analyzed.line.status === 'questionable' ? 'questionable' : 'reviewed';
    lines = state.lines.map((line) => (line.id === lineId ? { ...analyzed.line, status } : line));
    issues = [...state.issues.filter((entry) => entry.lineId !== lineId), ...analyzed.issues];
  }

  const items = reconciliation.items.map((entry) => (entry.lineId === lineId ? { ...entry, decision } : entry));
  const pendingLeft = items.some((entry) => entry.decision === 'pending');

  return {
    ...state,
    lines,
    issues,
    reconciliation: { ...reconciliation, items, status: pendingLeft ? 'pending' : 'resolved' },
    updatedAt: new Date().toISOString(),
  };
}

export function clearReconciliation(state: ProjectState): ProjectState {
  return { ...state, reconciliation: null, updatedAt: new Date().toISOString() };
}

export function pendingReconciliationCount(state: ProjectState): number {
  return state.reconciliation?.items.filter((item) => item.decision === 'pending').length ?? 0;
}

export function updateRuleInSet(ruleSet: RuleSet, ruleId: string, patch: Partial<TranscriptionRule>): RuleSet {
  return {
    ...ruleSet,
    rules: ruleSet.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
  };
}

export function makeRule(source: string, output: string, suspicious: boolean, kind: TranscriptionRule['kind'] = 'contraction'): TranscriptionRule {
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
