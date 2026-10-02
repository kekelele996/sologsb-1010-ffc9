import { analyzeProject, transcribeLine, uid } from './braille';
import { findRuleSet, findSpec } from './library';
import type {
  BrailleToken,
  ProjectState,
  ReconcileItem,
  ReconcileReason,
  RuleSet,
  TextbookLine,
} from './types';

const brailleOf = (tokens: BrailleToken[]) => tokens.map((token) => token.braille).join('');
/** 去掉盲文、只看原文被切成哪些词段——用于判定断词是否受影响。 */
const textSegments = (tokens: BrailleToken[]) => tokens
  .filter((token) => token.text !== ' ')
  .map((token) => token.text)
  .join('|');

function isHyphenLine(line: TextbookLine, previousLine?: TextbookLine): boolean {
  return line.source.trimEnd().endsWith('-') || Boolean(previousLine?.source.trimEnd().endsWith('-'));
}

function oldTokensFor(line: TextbookLine, ruleSet: RuleSet, previousContinues: boolean): BrailleToken[] {
  if (line.status === 'approved' && line.approvedTokens && line.approvedTokens.length > 0) {
    return structuredClone(line.approvedTokens);
  }
  return transcribeLine(line.source, ruleSet, previousContinues);
}

/**
 * 教研组新规范发布后让学校这份稿“重走”一遍：
 * - 未批准行直接按新规范重转录（老师日常工作不被打断）；
 * - 已批准行盲文发生任何变化时，按行号列入对账，等老师逐行认，旧盲文原样保留；
 * - 无论是否批准，只要断词切分或跨行连字符受影响，同样摆出。
 * 原文与校对备注在任何分支都不修改。
 */
export function applySpecVersion(state: ProjectState, targetSpecId: string): ProjectState {
  const targetSpec = state.specVersions.find((version) => version.id === targetSpecId);
  const fromSpec = findSpec(state, state.specAttribution.specVersionId);
  if (!targetSpec || targetSpec.id === fromSpec.id) return state;

  const nowIso = new Date().toISOString();
  const nextLines: TextbookLine[] = [];
  const items: ReconcileItem[] = [];

  state.lines.forEach((line, index) => {
    const previousLine = state.lines[index - 1];
    const previousSourceContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));
    const fromSet = findRuleSet(fromSpec, state.activeRuleSetId);
    const toSet = findRuleSet(targetSpec, state.activeRuleSetId);

    const oldTokens = oldTokensFor(line, fromSet, previousSourceContinues);
    const newTokens = transcribeLine(line.source, toSet, previousSourceContinues);
    const oldBraille = brailleOf(oldTokens);
    const newBraille = brailleOf(newTokens);
    const wasApproved = line.status === 'approved';

    const reasons: ReconcileReason[] = [];
    if (oldBraille !== newBraille) reasons.push('rule-change');
    if (textSegments(oldTokens) !== textSegments(newTokens)) reasons.push('word-break');
    if (isHyphenLine(line, previousLine)) {
      const oldHyphen = oldTokens.filter((token) => token.braille.includes('↳')).map((token) => token.braille).join('');
      const newHyphen = newTokens.filter((token) => token.braille.includes('↳')).map((token) => token.braille).join('');
      if (oldHyphen !== newHyphen) reasons.push('cross-line-hyphen');
    }

    const needsReview = (wasApproved && oldBraille !== newBraille)
      || reasons.includes('word-break')
      || reasons.includes('cross-line-hyphen');

    if (needsReview) {
      items.push({
        id: uid('reconcile'),
        lineId: line.id,
        lineNumber: index + 1,
        fromSpecVersionId: fromSpec.id,
        fromSpecVersionLabel: fromSpec.label,
        toSpecVersionId: targetSpec.id,
        toSpecVersionLabel: targetSpec.label,
        reasons,
        wasApproved,
        oldBraille,
        newBraille,
        decision: 'pending',
        reported: false,
        createdAt: nowIso,
      });
    }

    if (wasApproved) {
      // 批准行：盲文维持批准快照不动，等老师逐行认；继续钉在旧版本。
      nextLines.push({
        ...line,
        specVersionId: fromSpec.id,
        approvedTokens: structuredClone(oldTokens),
      });
    } else {
      // 未批准行直接按新规范转写；断词/连字符被摆出的行先钉在旧版本，等老师选。
      const pinnedSpec = (reasons.includes('word-break') || reasons.includes('cross-line-hyphen'))
        ? fromSpec.id
        : targetSpec.id;
      nextLines.push({ ...line, specVersionId: pinnedSpec, approvedTokens: null });
    }
  });

  // 已逐行认定过的历史决定保留（上报可能还要补）；未决项一律以本次重走结果重新生成。
  const decidedHistory = state.reconcileItems.filter((item) => item.decision !== 'pending');

  const next: ProjectState = {
    ...state,
    lines: nextLines,
    reconcileItems: [...items, ...decidedHistory],
    specAttribution: {
      specVersionId: targetSpec.id,
      specVersionLabel: targetSpec.label,
      appliedAt: nowIso,
    },
  };

  return analyzeProject(next);
}

/** 老师逐行认定：接受新稿（按新规范重转录并重新冻结批准），或保留旧稿（继续钉在旧版本）。 */
export function decideReconcileItem(
  state: ProjectState,
  itemId: string,
  decision: Exclude<ReconcileItem['decision'], 'pending'>,
): ProjectState {
  const item = state.reconcileItems.find((entry) => entry.id === itemId);
  if (!item || item.decision !== 'pending') return state;

  const nowIso = new Date().toISOString();
  const lineIndex = state.lines.findIndex((line) => line.id === item.lineId);

  let lines = state.lines;
  if (lineIndex >= 0) {
    const line = state.lines[lineIndex];
    if (decision === 'accepted-new') {
      // 原文、备注不动；按新规范重转录，批准行在分析时自动冻结为新盲文。
      lines = state.lines.map((entry) => (
        entry.id === line.id ? { ...entry, specVersionId: item.toSpecVersionId, approvedTokens: null } : entry
      ));
    } else {
      // 保留旧稿：继续钉在旧版本；批准行维持原冻结盲文。
      lines = state.lines.map((entry) => (
        entry.id === line.id ? { ...entry, specVersionId: item.fromSpecVersionId } : entry
      ));
    }
  }

  const reconcileItems = state.reconcileItems.map((entry) => (entry.id === itemId
    ? { ...entry, decision, decidedAt: nowIso, reported: false, lineNumber: lineIndex >= 0 ? lineIndex + 1 : entry.lineNumber }
    : entry));

  return analyzeProject({ ...state, lines, reconcileItems });
}

export function pendingItems(state: ProjectState): ReconcileItem[] {
  return state.reconcileItems
    .filter((item) => item.decision === 'pending')
    .sort((a, b) => a.lineNumber - b.lineNumber);
}

/** 同步失败后重试只补这些：老师已认定、但还没成功上报给教研组的。 */
export function unreportedDecidedItems(state: ProjectState): ReconcileItem[] {
  return state.reconcileItems.filter((item) => item.decision !== 'pending' && !item.reported);
}

export const reasonLabels: Record<ReconcileReason, string> = {
  'rule-change': '盲文转写变化',
  'word-break': '断词变化',
  'cross-line-hyphen': '跨行连字符',
};
