import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { analyzeProject, brailleCellCount, buildReconciliation, clearReconciliation, decideReconciliationItem, makeRule, outputText, pendingReconciliationCount, updateRuleInSet } from './braille';
import { createInitialProject } from './sample';
import { fetchStandardsLibrary } from './standards';
import type { Attribution, HistoryState, ProofIssue, ProjectState, Reconciliation, TextbookLine, VersionSnapshot } from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v1';
const HISTORY_LIMIT = 60;

type HistoryAction =
  | { type: 'commit'; label: string; update: (state: ProjectState) => ProjectState }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'restore'; label: string; state: ProjectState };

function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastAction: '撤销',
    };
  }

  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
      lastAction: '重做',
    };
  }

  const next = action.type === 'restore' ? cloneState(action.state) : action.update(cloneState(state.present));
  if (next === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastAction: action.label,
  };
}

function migrateState(parsed: Partial<ProjectState>): ProjectState {
  const fallback = createInitialProject();
  return {
    ...fallback,
    ...parsed,
    attribution: parsed.attribution ?? null,
    ruleSets: parsed.ruleSets?.length ? parsed.ruleSets : fallback.ruleSets,
    lines: parsed.lines?.length ? parsed.lines : fallback.lines,
    issues: parsed.issues ?? [],
    versions: parsed.versions ?? [],
    standardsLibraryId: parsed.standardsLibraryId ?? fallback.standardsLibraryId,
    standardsLibraryVersion: parsed.standardsLibraryVersion ?? 'v1',
    syncStatus: parsed.syncStatus === 'syncing' ? 'idle' : (parsed.syncStatus ?? 'idle'),
    syncMessage: parsed.syncMessage ?? '',
    lastSyncedAt: parsed.lastSyncedAt ?? null,
    reconciliation: parsed.reconciliation ?? null,
  };
}

function loadInitialState(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProjectState>;
      return analyzeProject(migrateState(parsed));
    }
  } catch {
    // 清除损坏草稿并使用内置示例。
  }
  return createInitialProject();
}

function useProject() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: loadInitialState(),
    future: [],
    lastAction: '已恢复本地草稿',
  }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present));
  }, [history.present]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });

  return { state: history.present, history, commit, undo, redo, restore };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RuleSetPanel({
  state,
  onSelect,
  onUpdateRule,
  onToggleContractions,
  onAddRule,
  onRecheck,
}: {
  state: ProjectState;
  onSelect: (id: string) => void;
  onUpdateRule: (ruleId: string, patch: Record<string, unknown>) => void;
  onToggleContractions: () => void;
  onAddRule: (source: string, output: string, suspicious: boolean) => void;
  onRecheck: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  return (
    <aside class="left-panel scroll-pane" aria-label="规则集与规则编辑">
      <Section title="规则集" subtitle="切换后会自动重转录全部行">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>{ruleSet.rules.filter((rule) => rule.enabled).length} 条启用规则</small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="当前规则"
        subtitle={active.description}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用规则' : '查看全部规则'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点" subtitle="可疑规则会在校对区生成提醒">
        <div class="rule-list">
          {visibleRules.map((rule) => (
            <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''}`} key={rule.id}>
              <md-checkbox checked={rule.enabled} onInput={() => onUpdateRule(rule.id, { enabled: !rule.enabled })} aria-label={`启用 ${rule.source}`} />
              <md-outlined-text-field
                class="rule-source"
                value={rule.source}
                label="原文"
                onInput={(event: any) => onUpdateRule(rule.id, { source: event.currentTarget.value })}
              />
              <md-outlined-text-field
                class="rule-output"
                value={rule.output}
                label="盲文"
                onInput={(event: any) => onUpdateRule(rule.id, { output: event.currentTarget.value })}
              />
              <md-icon-button
                class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                onClick={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })}
              >
                {rule.suspicious ? '!' : '○'}
              </md-icon-button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="新增规则" subtitle="可添加缩写、字母组合或自定义符号">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} onInput={() => setSuspicious((value) => !value)} label="标记为可疑规则" />
          <md-filled-button
            disabled={!newSource.trim() || !newOutput.trim()}
            onClick={() => {
              onAddRule(newSource.trim(), newOutput.trim(), suspicious);
              setNewSource('');
              setNewOutput('');
            }}
          >
            添加并检查
          </md-filled-button>
        </div>
      </Section>
    </aside>
  );
}

function LineCard({
  line,
  index,
  selected,
  issues,
  onSelect,
  onChange,
  onNote,
  onStatus,
  onDelete,
}: {
  line: TextbookLine;
  index: number;
  selected: boolean;
  issues: ProofIssue[];
  onSelect: () => void;
  onChange: (source: string) => void;
  onNote: (note: string) => void;
  onStatus: (status: TextbookLine['status']) => void;
  onDelete: () => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const lineIssues = unresolved.filter((issue) => issue.lineId === line.id);

  return (
    <article class={`line-card ${selected ? 'selected' : ''}`} id={`line-card-${line.id}`} onClick={onSelect}>
      <div class="line-gutter">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span class={`line-status ${line.status}`} title={`状态：${line.status}`} />
      </div>
      <div class="line-body">
        <div class="line-source">
          <textarea
            aria-label={`第 ${index + 1} 行原文`}
            value={line.source}
            rows={Math.max(1, Math.ceil(line.source.length / 52))}
            onFocus={onSelect}
            onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="line-actions">
            <md-icon-button aria-label="标记待核对" title="标记待核对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('questionable'); }}>?</md-icon-button>
            <md-icon-button aria-label="标记已校对" title="标记已校对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('reviewed'); }}>✓</md-icon-button>
            <md-icon-button aria-label="批准此行" title="批准此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('approved'); }}>★</md-icon-button>
            <md-icon-button aria-label="删除此行" title="删除此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(); }}>×</md-icon-button>
          </div>
        </div>
        <div class="braille-preview" aria-label={`第 ${index + 1} 行盲文预览`}>
          {line.tokens.length === 0 && <span class="empty-preview">空行</span>}
          {line.tokens.map((token) => (
            token.text === ' ' ? <span class="space-token" title="分词空格" /> : (
              <span
                class={`braille-token ${token.suspicious ? 'suspicious' : ''} ${token.braille.includes('⟦') ? 'error' : ''}`}
                title={`${token.text || '标记'} → ${token.braille}`}
              >
                <b>{token.text || '标记'}</b>
                <span>{token.braille}</span>
              </span>
            )
          ))}
        </div>
        {lineIssues.length > 0 && (
          <div class="line-warnings">
            {lineIssues.slice(0, 3).map((item) => (
              <span class={`issue-chip ${item.severity}`} key={item.id}>{issueLabel(item)} · {item.message}</span>
            ))}
          </div>
        )}
        {selected && (
          <md-outlined-text-field
            class="note-field"
            value={line.note}
            label="校对备注"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  banner,
  onSelectLine,
  onChangeLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
  onEditAttribution,
}: {
  state: ProjectState;
  banner?: ComponentChildren;
  onSelectLine: (id: string) => void;
  onChangeLine: (id: string, source: string) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
  onEditAttribution: () => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>
            {state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格
            {state.attribution && (
              <button class="attribution-chip" onClick={onEditAttribution} title="修改稿件归属">
                {state.attribution.school} · {state.attribution.teacher}{state.attribution.group ? ` · ${state.attribution.group}` : ''}
              </button>
            )}
          </p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
          <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
          <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
        </div>
      </div>

      {showImport && (
        <div class="import-strip">
          <md-outlined-text-field
            type="textarea"
            rows={5}
            value={importText}
            label="粘贴课文；换行或句末标点将被拆成行"
            onInput={(event: any) => setImportText(event.currentTarget.value)}
          />
          <div>
            <md-text-button onClick={() => { setImportText(''); setShowImport(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setShowImport(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      {banner}

      <div class="line-list scroll-pane">
        {state.lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            selected={state.selectedLineId === line.id}
            issues={state.issues}
            onSelect={() => onSelectLine(line.id)}
            onChange={(source) => onChangeLine(line.id, source)}
            onNote={(note) => onNote(line.id, note)}
            onStatus={(status) => onStatus(line.id, status)}
            onDelete={() => onDelete(line.id)}
          />
        ))}
      </div>
    </main>
  );
}

function IssuesPanel({
  issues,
  lines,
  onJump,
  onResolve,
  onBatchFix,
}: {
  issues: ProofIssue[];
  lines: TextbookLine[];
  onJump: (lineId: string) => void;
  onResolve: (issueId: string) => void;
  onBatchFix: (ruleId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const grouped = useMemo(() => {
    const map = new Map<string, ProofIssue[]>();
    unresolved.forEach((item) => {
      const key = item.ruleId ? `rule:${item.ruleId}` : `code:${item.code}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [unresolved]);

  return (
    <div class="inspector-body">
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录版本或导出打印稿。</p></div>}
      {grouped.map(([key, group]) => {
        const lineNumbers = group.map((item) => lines.findIndex((line) => line.id === item.lineId) + 1).join('、');
        return (
          <div class="issue-group" key={key}>
            <div class="issue-group-head">
              <span class={`severity-dot ${group[0].severity}`} />
              <div>
                <strong>{group[0].message}</strong>
                <p>影响第 {lineNumbers} 行 · 共 {group.length} 处</p>
              </div>
            </div>
            <div class="issue-actions">
              <md-text-button onClick={() => onJump(group[0].lineId)}>定位首处</md-text-button>
              {group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用规则并修正同类</md-filled-tonal-button>
              )}
              {!group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => group.forEach((item) => onResolve(item.id))}>全部标记已处理</md-filled-tonal-button>
              )}
              <md-icon-button aria-label="标记此项已处理" title="标记已处理" onClick={() => onResolve(group[0].id)}>✓</md-icon-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleDetailPanel({ state, onUpdateRule, onDeleteRule }: { state: ProjectState; onUpdateRule: (id: string, patch: Record<string, unknown>) => void; onDeleteRule: (id: string) => void }) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row"><span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span><span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span></div>
      </div>
      {active.rules.map((rule) => (
        <div class="rule-detail-card" key={rule.id}>
          <div>
            <strong>{rule.source || '数字符'}</strong>
            <span>{rule.output} · {rule.kind}</span>
            {rule.description && <p>{rule.description}</p>}
          </div>
          <div class="rule-detail-actions">
            <md-checkbox checked={rule.suspicious} onInput={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })} label="可疑" />
            <md-icon-button aria-label="删除规则" title="删除规则" onClick={() => onDeleteRule(rule.id)}>×</md-icon-button>
          </div>
        </div>
      ))}
    </div>
  );
}

function VersionsPanel({ state, onSnapshot, onRestore }: { state: ProjectState; onSnapshot: () => void; onRestore: (version: VersionSnapshot) => void }) {
  return (
    <div class="inspector-body">
      <div class="snapshot-callout">
        <div><strong>本地版本记录</strong><p>保存当前规则、原文、状态和备注的完整快照。</p></div>
        <md-filled-button onClick={onSnapshot}>记录版本</md-filled-button>
      </div>
      {state.versions.length === 0 && <div class="empty-state compact"><strong>还没有版本快照</strong><p>完成一轮校对后记录版本，便于比较和恢复。</p></div>}
      <div class="timeline">
        {state.versions.map((version) => (
          <div class="timeline-item" key={version.id}>
            <span class="timeline-dot" />
            <div>
              <strong>{version.name}</strong>
              <p>{version.action} · {formatTime(version.createdAt)}</p>
              <div class="metric-row"><span>{version.snapshot.lines.length} 行</span><span>{version.snapshot.issues.filter((issue) => !issue.resolved).length} 个未处理问题</span></div>
              <md-text-button onClick={() => onRestore(version)}>恢复此版本</md-text-button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReconciliationPanel({
  reconciliation,
  onDecide,
  onClear,
  onJump,
}: {
  reconciliation: Reconciliation | null;
  onDecide: (lineId: string, decision: 'accepted' | 'kept') => void;
  onClear: () => void;
  onJump: (lineId: string) => void;
}) {
  if (!reconciliation || reconciliation.items.length === 0) {
    return (
      <div class="inspector-body">
        <div class="empty-state">
          <span>⇄</span>
          <strong>没有待认定的对账</strong>
          <p>教研组规范库更新后，这里会按行号摆出新旧盲文；已批准的行需逐行认定，原文和备注不会改动。</p>
        </div>
      </div>
    );
  }

  const pending = reconciliation.items.filter((item) => item.decision === 'pending').length;

  return (
    <div class="inspector-body">
      <div class="recon-callout">
        <div>
          <strong>规范库 {reconciliation.libraryVersion} · {reconciliation.origin === 'sync' ? '教研组同步' : '本地规则变更'}</strong>
          <p>{pending ? `${pending} 行待逐行认定；未批准行已按新规范重走。` : '全部行已认定完成。'}</p>
        </div>
        {!pending && <md-text-button onClick={onClear}>关闭对账</md-text-button>}
      </div>
      {reconciliation.items.map((item) => (
        <div class={`recon-row ${item.decision !== 'pending' ? item.decision : ''} ${item.wasApproved ? 'approved' : ''}`} key={item.lineId}>
          <div class="recon-row-head">
            <button class="recon-line-num" onClick={() => onJump(item.lineId)}>第 {item.lineNumber} 行</button>
            <div class="recon-tags">
              {item.wasApproved && <span class="recon-tag approved">已批准 · 需逐行认定</span>}
              {item.breakAffected && <span class="recon-tag">断词受影响</span>}
              {item.hyphenAffected && <span class="recon-tag">跨行连字符受影响</span>}
            </div>
          </div>
          <p class="recon-source">{item.source}</p>
          <div class="recon-diff">
            <div class="recon-braille old"><small>旧稿</small><span>{item.oldBraille || '（空）'}</span></div>
            <div class="recon-arrow">→</div>
            <div class="recon-braille new"><small>新规范</small><span>{item.newBraille}</span></div>
          </div>
          {item.decision === 'pending' ? (
            <div class="recon-actions">
              <md-filled-tonal-button onClick={() => onDecide(item.lineId, 'accepted')}>采用新盲文</md-filled-tonal-button>
              <md-text-button onClick={() => onDecide(item.lineId, 'kept')}>保留旧盲文</md-text-button>
            </div>
          ) : (
            <div class="recon-decided">{item.decision === 'accepted' ? '已采用新盲文' : '已保留旧盲文'}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function AttributionModal({ initial, onSave, onClose }: { initial: Attribution | null; onSave: (attribution: Attribution) => void; onClose?: () => void }) {
  const [school, setSchool] = useState(initial?.school ?? '');
  const [teacher, setTeacher] = useState(initial?.teacher ?? '');
  const [group, setGroup] = useState(initial?.group ?? '');
  const canSave = school.trim().length > 0 && teacher.trim().length > 0;

  return (
    <div class="modal-scrim" role="dialog" aria-modal="true" aria-label="补全稿件归属">
      <div class="modal-card">
        <span class="eyebrow">{initial ? '修改归属' : '旧稿首次打开 · 先补归属'}</span>
        <h2>这份稿子归谁使用？</h2>
        <p>补全学校 / 教研组与教师信息后再开始校对。归属只随草稿保存在本机，不会随课文和盲文一起改动。</p>
        <div class="stack-sm">
          <md-outlined-text-field value={school} label="学校 / 教研组" onInput={(event: any) => setSchool(event.currentTarget.value)} />
          <md-outlined-text-field value={teacher} label="教师" onInput={(event: any) => setTeacher(event.currentTarget.value)} />
          <md-outlined-text-field value={group} label="班级 / 课文归属（选填）" onInput={(event: any) => setGroup(event.currentTarget.value)} />
        </div>
        <div class="modal-actions">
          {onClose && <md-text-button onClick={onClose}>取消</md-text-button>}
          <md-filled-button
            disabled={!canSave}
            onClick={() => onSave({ school: school.trim(), teacher: teacher.trim(), group: group.trim(), filledAt: new Date().toISOString() })}
          >
            保存归属并开始
          </md-filled-button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { state, history, commit, undo, redo, restore } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'versions' | 'reconciliation'>('issues');
  const [showAttribution, setShowAttribution] = useState(false);
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({
      ...current,
      lines: current.lines.map((line) => line.id === lineId
        ? { ...line, source, status: line.status === 'approved' ? 'reviewed' : line.status }
        : line),
    }));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => line.id === lineId ? { ...line, status } : line);
      const issues = current.issues.map((item) => item.lineId === lineId && status === 'approved' ? { ...item, resolved: true } : item);
      return { ...current, lines, issues, updatedAt: new Date().toISOString() };
    });
  };

  const navigateLine = (direction: number) => {
    const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
    const next = state.lines[Math.max(0, Math.min(state.lines.length - 1, index + direction))];
    if (next && next.id !== selectedLineRef.current) selectLine(next.id, true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        recordVersion('快捷保存');
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        changeStatus(selectedLineRef.current, 'approved');
        const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
        if (state.lines[index + 1]) selectLine(state.lines[index + 1].id, true);
        return;
      }
      if (!editing && (event.key === 'ArrowDown' || event.key === 'j')) {
        event.preventDefault();
        navigateLine(1);
      }
      if (!editing && (event.key === 'ArrowUp' || event.key === 'k')) {
        event.preventDefault();
        navigateLine(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const createSnapshot = (action: string, source = state): VersionSnapshot => {
    const { versions: _versions, ...snapshot } = cloneState(source);
    return {
      id: `version-${Date.now().toString(36)}`,
      name: `${action} · ${source.lines.filter((line) => line.status === 'approved').length}/${source.lines.length} 行完成`,
      createdAt: new Date().toISOString(),
      action,
      snapshot,
    };
  };

  const recordVersion = (action = '手动记录') => {
    commit('记录版本快照', (current) => ({ ...current, versions: [createSnapshot(action, current), ...current.versions].slice(0, 20), updatedAt: new Date().toISOString() }));
  };

  const exportText = () => {
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.title.replace(/[^\p{L}\p{N}-]+/gu, '-')}-盲文.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) return;
    const rows = state.lines.map((line, index) => `
      <tr><td>${index + 1}</td><td>${line.source.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char))}</td><td class="braille">${line.tokens.map((token) => token.braille).join('')}</td></tr>
    `).join('');
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  /** 规则变更后重走：未批准行直接更新，已批准行进入对账逐行认定。 */
  const commitRuleSetsChange = (label: string, mutate: (current: ProjectState) => ProjectState) => {
    commit(label, (current) => {
      const next = mutate(current);
      const { lines, issues, reconciliation } = buildReconciliation(current, next.ruleSets, {
        origin: 'rules-changed',
        libraryId: current.standardsLibraryId,
        libraryVersion: current.standardsLibraryVersion,
      });
      return {
        ...next,
        lines,
        issues,
        reconciliation: reconciliation ?? (current.reconciliation?.status === 'pending' ? current.reconciliation : null),
        updatedAt: new Date().toISOString(),
      };
    });
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>) => {
    commitRuleSetsChange('修改转录规则', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, patch);
      return { ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) };
    });
  };

  const batchFixRule = (ruleId: string) => {
    commitRuleSetsChange('批量修正同类问题', (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, { enabled: false });
      return { ...current, ruleSets: current.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) };
    });
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({ id: `line-import-${Date.now()}-${index}`, source, tokens: [], status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规则集。' : '', continuesPrevious: false, continuesNext: false })),
      selectedLineId: '',
      issues: [],
    }));
  };

  const applyLibrary = (library: Awaited<ReturnType<typeof fetchStandardsLibrary>>, label: string) => {
    commit(label, (current) => {
      const versionChanged = library.version !== current.standardsLibraryVersion;
      const { lines, issues, reconciliation } = buildReconciliation(current, library.ruleSets, {
        origin: 'sync',
        libraryId: library.id,
        libraryVersion: library.version,
      });
      const pending = reconciliation?.items.filter((item) => item.decision === 'pending').length ?? 0;
      return {
        ...current,
        ruleSets: library.ruleSets,
        lines,
        issues,
        standardsLibraryId: library.id,
        standardsLibraryVersion: library.version,
        syncStatus: 'success',
        syncMessage: versionChanged
          ? `规范库已更新到 ${library.version}${pending ? `；${pending} 行已经您批准，需逐行认定` : ''}`
          : '规范库已是最新，稿子无需重走。',
        lastSyncedAt: new Date().toISOString(),
        reconciliation: reconciliation ?? (current.reconciliation?.status === 'pending' ? current.reconciliation : null),
        updatedAt: new Date().toISOString(),
      };
    });
  };

  const syncLibrary = async () => {
    commit('开始同步规范库', (current) => ({ ...current, syncStatus: 'syncing', syncMessage: '正在取回教研组规范库…' }));
    try {
      const library = await fetchStandardsLibrary();
      applyLibrary(library, '同步教研组规范库');
      setInspectorTab('reconciliation');
    } catch (error) {
      const message = error instanceof Error ? error.message : '规范库同步失败。';
      commit('规范库同步失败', (current) => ({ ...current, syncStatus: 'failed', syncMessage: message }));
    }
  };

  const retrySync = async () => {
    commit('按这侧重试同步', (current) => ({ ...current, syncStatus: 'syncing', syncMessage: '正在按学校这份稿子重试…' }));
    try {
      const library = await fetchStandardsLibrary();
      applyLibrary(library, '同步教研组规范库');
      setInspectorTab('reconciliation');
    } catch (error) {
      // 规范库仍未取回：按这侧重试，只用本地规则重走，只补没对上的行。
      const message = error instanceof Error ? error.message : '规范库同步失败。';
      commit('按本地重试对账', (current) => {
        const { lines, issues, reconciliation } = buildReconciliation(current, current.ruleSets, {
          origin: 'rules-changed',
          libraryId: current.standardsLibraryId,
          libraryVersion: current.standardsLibraryVersion,
        });
        return {
          ...current,
          lines,
          issues,
          syncStatus: 'failed',
          syncMessage: `${message} 已按本地规则重走，只补没对上的行；稿子可继续修改。`,
          reconciliation: reconciliation ?? current.reconciliation,
          updatedAt: new Date().toISOString(),
        };
      });
      setInspectorTab('reconciliation');
    }
  };

  const saveAttribution = (attribution: Attribution) => {
    commit('补全稿件归属', (current) => ({ ...current, attribution, updatedAt: new Date().toISOString() }));
    setShowAttribution(false);
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${navigator.onLine ? 'online' : ''}`} />
          {navigator.onLine ? '浏览器本地保存' : '离线模式 · 本地保存可继续'}
          <small>上次自动保存 {formatTime(state.updatedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-outlined-button onClick={syncLibrary} disabled={state.syncStatus === 'syncing'}>
            {state.syncStatus === 'syncing' ? '正在取回规范库…' : '同步规范库'}
          </md-outlined-button>
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      {state.syncStatus === 'failed' && (
        <div class="sync-banner" role="alert">
          <div>
            <strong>规范库未取回，学校这份稿子仍可照常修改。</strong>
            <span>{state.syncMessage}</span>
          </div>
          <md-filled-tonal-button onClick={retrySync}>按这侧重试（只补没对上的）</md-filled-tonal-button>
        </div>
      )}

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用规则</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规则集并重新检查', (current) => analyzeProject({ ...current, activeRuleSetId: id, issues: [] }))}
          onUpdateRule={updateRule}
          onToggleContractions={() => {
            const ruleSet = activeRuleSet;
            commit('切换缩写规则', (current) => analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => set.id === ruleSet.id ? { ...set, contractions: !set.contractions } : set) }));
          }}
          onAddRule={(source, output, suspicious) => {
            commit('新增转写规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: [...set.rules, makeRule(source, output, suspicious)] } : set),
            }));
          }}
          onRecheck={() => commit('重新检查全部内容', analyzeProject)}
        />

        <EditorPanel
          state={state}
          banner={pendingReconciliationCount(state) > 0 ? (
            <div class="recon-banner" role="alert">
              <div>
                <strong>教研组新规范重走后，有 {pendingReconciliationCount(state)} 行已经您批准、不能悄悄变样。</strong>
                <span>请逐行认定保留旧盲文或采用新盲文；原文和校对备注不会被改动。</span>
              </div>
              <md-filled-tonal-button onClick={() => setInspectorTab('reconciliation')}>打开对账（按行号）</md-filled-tonal-button>
            </div>
          ) : null}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => {
            const lines = current.lines.filter((line) => line.id !== lineId);
            return analyzeProject({ ...current, lines: lines.length ? lines : [{ id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false }], selectedLineId: lines[0]?.id ?? '' });
          })}
          onAddLine={() => commit('新增课文行', (current) => {
            const line: TextbookLine = { id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false };
            return analyzeProject({ ...current, lines: [...current.lines, line], selectedLineId: line.id });
          })}
          onSplitLongLines={() => commit('按句拆分长行', (current) => {
            const lines = current.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({ ...line, id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`, source: source.trim(), tokens: [], status: 'unchecked' as const, note: index === 0 ? line.note : '' })));
            return analyzeProject({ ...current, lines });
          })}
          onImport={importCourse}
          onEditAttribution={() => setShowAttribution(true)}
        />

        <aside class="right-panel">
          <div class="inspector-tabs" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规则详情</button>
            <button class={inspectorTab === 'reconciliation' ? 'active' : ''} onClick={() => setInspectorTab('reconciliation')}>对账 {pendingReconciliationCount(state) > 0 && <span>{pendingReconciliationCount(state)}</span>}</button>
            <button class={inspectorTab === 'versions' ? 'active' : ''} onClick={() => setInspectorTab('versions')}>版本 {state.versions.length > 0 && <span>{state.versions.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchFixRule}
            />
          )}
          {inspectorTab === 'rules' && <RuleDetailPanel state={state} onUpdateRule={updateRule} onDeleteRule={(ruleId) => {
            commit('删除转录规则', (current) => analyzeProject({
              ...current,
              ruleSets: current.ruleSets.map((set) => set.id === current.activeRuleSetId ? { ...set, rules: set.rules.filter((rule) => rule.id !== ruleId) } : set),
            }));
          }} />}
          {inspectorTab === 'reconciliation' && (
            <ReconciliationPanel
              reconciliation={state.reconciliation}
              onDecide={(lineId, decision) => commit('逐行认定对账', (current) => decideReconciliationItem(current, lineId, decision))}
              onClear={() => commit('关闭对账', clearReconciliation)}
              onJump={(lineId) => selectLine(lineId, true)}
            />
          )}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            const restored: ProjectState = cloneState({ ...version.snapshot, versions: state.versions });
            restore(restored);
          }} />}
        </aside>
      </div>

      {(!state.attribution || showAttribution) && (
        <AttributionModal
          initial={state.attribution}
          onSave={saveAttribution}
          onClose={state.attribution ? () => setShowAttribution(false) : undefined}
        />
      )}
    </div>
  );
}
