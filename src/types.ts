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

/** 稿件归属：旧稿首次打开时补全，随草稿保存在本机。 */
export interface Attribution {
  school: string;
  teacher: string;
  group: string;
  filledAt: string;
}

/** 教研组维护的盲文转写规范库。 */
export interface StandardsLibrary {
  id: string;
  name: string;
  version: string;
  updatedAt: string;
  ruleSets: RuleSet[];
}

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'failed';

export type ReconciliationOrigin = 'sync' | 'rules-changed';
export type ReconciliationDecision = 'pending' | 'accepted' | 'kept';

/** 对账条目：只摆变化的行，按行号对齐；原文和备注始终不参与。 */
export interface ReconciliationItem {
  lineId: string;
  lineNumber: number;
  source: string;
  oldBraille: string;
  newBraille: string;
  /** 此行已经老师批准，必须逐行认定，不能自动更新。 */
  wasApproved: boolean;
  /** 断词（缩写/分词）结果受影响。 */
  breakAffected: boolean;
  /** 跨行连字符标记受影响。 */
  hyphenAffected: boolean;
  decision: ReconciliationDecision;
}

export interface Reconciliation {
  id: string;
  origin: ReconciliationOrigin;
  libraryId: string;
  libraryVersion: string;
  createdAt: string;
  status: 'pending' | 'resolved';
  items: ReconciliationItem[];
}

export interface ProjectState {
  id: string;
  title: string;
  author: string;
  attribution: Attribution | null;
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: TextbookLine[];
  selectedLineId: string;
  issues: ProofIssue[];
  versions: VersionSnapshot[];
  standardsLibraryId: string;
  standardsLibraryVersion: string;
  syncStatus: SyncStatus;
  syncMessage: string;
  lastSyncedAt: string | null;
  reconciliation: Reconciliation | null;
  lastCheckedAt: string;
  updatedAt: string;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}
