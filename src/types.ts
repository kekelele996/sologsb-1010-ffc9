export type RuleKind = 'letter' | 'number' | 'punctuation' | 'contraction' | 'special';
export type LineStatus = 'unchecked' | 'reviewed' | 'questionable' | 'approved';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface TranscriptionRule {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  rules: TranscriptionRule[];
}

/** 教研组发布的规范库版本；学校只能取回与选用，不能改动版本本身。 */
export interface SpecVersion {
  id: string;
  label: string;
  releasedAt: string;
  notes: string;
  ruleSets: RuleSet[];
}

/** 学校这份稿当前归属到的规范版本。 */
export interface SpecAttribution {
  specVersionId: string;
  specVersionLabel: string;
  appliedAt: string;
}

export type ReconcileReason = 'rule-change' | 'word-break' | 'cross-line-hyphen';
export type ReconcileDecision = 'pending' | 'accepted-new' | 'kept-old';

/** 两边按行号摆出来、等老师逐行认定的对账条目。 */
export interface ReconcileItem {
  id: string;
  lineId: string;
  lineNumber: number;
  fromSpecVersionId: string;
  fromSpecVersionLabel: string;
  toSpecVersionId: string;
  toSpecVersionLabel: string;
  reasons: ReconcileReason[];
  /** 老师此前已批准过该行：盲文不能悄悄变，必须逐行认。 */
  wasApproved: boolean;
  oldBraille: string;
  newBraille: string;
  decision: ReconcileDecision;
  decidedAt?: string;
  /** 已成功上报教研组；同步失败重试时只补没有对上的。 */
  reported: boolean;
  createdAt: string;
}

export type FetchStatus = 'idle' | 'fetching' | 'fetched' | 'failed';
export type ReportStatus = 'idle' | 'syncing' | 'synced' | 'failed';

export interface SyncState {
  endpoint: string;
  online: boolean;
  fetchStatus: FetchStatus;
  lastFetchedAt: string | null;
  lastFetchError: string | null;
  reportStatus: ReportStatus;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface BrailleToken {
  id: string;
  text: string;
  braille: string;
  kind: RuleKind;
  ruleId?: string;
  suspicious: boolean;
  offset: number;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
  /** 本行转写所依据的规范版本（对账中保留旧稿的行会钉在旧版本）。 */
  specVersionId?: string;
  /** 批准时刻冻结的盲文；新规范重走时已批准行不允许悄悄变样。 */
  approvedTokens?: BrailleToken[] | null;
}

export interface ProofIssue {
  id: string;
  lineId: string;
  tokenId?: string;
  ruleId?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resolved: boolean;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  action: string;
  snapshot: Omit<ProjectState, 'versions'>;
}

export interface ProjectState {
  id: string;
  title: string;
  author: string;
  activeRuleSetId: string;
  specVersions: SpecVersion[];
  specAttribution: SpecAttribution;
  lines: TextbookLine[];
  selectedLineId: string;
  issues: ProofIssue[];
  reconcileItems: ReconcileItem[];
  sync: SyncState;
  versions: VersionSnapshot[];
  lastCheckedAt: string;
  updatedAt: string;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
  /** 仅初始挂载时使用：旧稿首次打开补归属的提示。 */
  initialNotice?: string | null;
}
