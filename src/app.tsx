import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  analyzeProject,
  brailleCellCount,
  makeRule,
  migrateProject,
  outputText,
  updateRuleInSet,
  updateRulesInSpec,
} from './braille';
import { findRuleSet, findSpec } from './library';
import { fetchRemoteSpec, readSimulatedOnline, reportReconcileDecisions, writeSimulatedOnline } from './net';
import {
  applySpecVersion,
  decideReconcileItem,
  pendingItems,
  reasonLabels,
  unreportedDecidedItems,
} from './reconcile';
import { createInitialProject } from './sample';
import type {
  HistoryState,
  ProofIssue,
  ProjectState,
  ReconcileItem,
  ReconcileReason,
  TextbookLine,
  VersionSnapshot,
} from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v2';
const MIGRATION_DISMISS_PREFIX = 'sologsb-1010-migration-dismissed-';
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

function loadInitialState(): { state: ProjectState; notice: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('sologsb-1010-braille-project-v1');
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectState;
      const { state: migrated, migrated: wasLegacy } = migrateProject(parsed);
      // 连接模拟开关独立于草稿持久化，加载时以本地开关为准。
      migrated.sync.online = readSimulatedOnline();
      const state = analyzeProject(migrated);
      const notice = wasLegacy
        ? '旧稿首次打开已补归属：按《UEB 教研组规范 · 2025 现行版》继续，已批准行用批准时盲文冻结，原文与校对备注未改动。'
        : null;
      return { state, notice };
    }
  } catch {
    // 清除损坏草稿并使用内置示例。
  }
  return { state: createInitialProject(readSimulatedOnline()), notice: null };
}

function useProject() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => {
    const initial = loadInitialState();
    return {
      past: [],
      present: initial.state,
      future: [],
      lastAction: '已恢复本地草稿',
      initialNotice: initial.notice,
    };
  });
  const initialNotice = history.initialNotice ?? null;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present));
  }, [history.present]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });

  return { state: history.present, history, initialNotice, commit, undo, redo, restore };
}

function formatTime(value: string | null): string {
  if (!value) return '尚未取回';
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
  const spec = findSpec(state, state.specAttribution.specVersionId);
  const active = findRuleSet(spec, state.activeRuleSetId);
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  return (
    <aside class="left-panel scroll-pane" aria-label="规则集与规则编辑">
      <Section title="规则集" subtitle="切换预设会自动重转录全部行（批准行保持冻结）">
        <div class="stack-sm">
          {spec.ruleSets.map((ruleSet) => (
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
        subtitle={`${state.specAttribution.specVersionLabel} · ${active.description}`}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用规则' : '查看全部规则'}
          </md-filled-tonal-button>
        </div>
        <p class="local-edit-hint">本地改动只落在学校这份稿当前归属的版本上，取回新规范不会覆盖。</p>
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
  pendingItem,
  pinnedOldSpec,
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
  pendingItem?: ReconcileItem;
  pinnedOldSpec: boolean;
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
        {pendingItem && (
          <div class="reconcile-banner">
            <strong>规范对账待老师逐行认</strong>
            <span>
              {pendingItem.wasApproved && <em class="approved-tag">★ 此行老师已批准，盲文不得悄悄变样</em>}
              {pendingItem.reasons.map((reason) => <em class="reason-tag" key={reason}>{reasonLabels[reason]}</em>)}
            </span>
          </div>
        )}
        {!pendingItem && pinnedOldSpec && (
          <div class="pinned-hint">本行按旧规范保留，见右侧“规范对账”。</div>
        )}
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
            label="校对备注（规范流程不会改动）"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  pendingByLine,
  onSelectLine,
  onChangeLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
}: {
  state: ProjectState;
  pendingByLine: Map<string, ReconcileItem>;
  onSelectLine: (id: string) => void;
  onChangeLine: (id: string, source: string) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
}) {
  const [showImport, setImportVisible] = useState(false);
  const [importText, setImportText] = useState('');
  const activeSpec = findSpec(state, state.specAttribution.specVersionId);
  const activeRuleSet = findRuleSet(activeSpec, state.activeRuleSetId);

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>
            {state.author} · {activeRuleSet.name} · 归属《{state.specAttribution.specVersionLabel}》
            · {state.lines.length} 行 · {brailleCellCount(state)} 格
          </p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setImportVisible((value) => !value)}>导入课文</md-outlined-button>
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
            <md-text-button onClick={() => { setImportText(''); setImportVisible(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setImportVisible(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      <div class="line-list scroll-pane">
        {state.lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            selected={state.selectedLineId === line.id}
            issues={state.issues}
            pendingItem={pendingByLine.get(line.id)}
            pinnedOldSpec={Boolean(line.specVersionId && line.specVersionId !== state.specAttribution.specVersionId)}
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
  const spec = findSpec(state, state.specAttribution.specVersionId);
  const active = findRuleSet(spec, state.activeRuleSetId);
  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{state.specAttribution.specVersionLabel} · {active.description}</p>
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

function ReconcilePanel({
  state,
  onFetch,
  onToggleOnline,
  onApplySpec,
  onDecide,
  onReport,
}: {
  state: ProjectState;
  onFetch: () => void;
  onToggleOnline: (online: boolean) => void;
  onApplySpec: (specVersionId: string) => void;
  onDecide: (itemId: string, decision: 'accepted-new' | 'kept-old') => void;
  onReport: () => void;
}) {
  const pending = pendingItems(state);
  const unreported = unreportedDecidedItems(state);
  const lineById = useMemo(() => new Map(state.lines.map((line) => [line.id, line])), [state.lines]);
  // 行被删除后，未认项应一并消失；只保留已认定待补传的历史。
  const visiblePending = pending.filter((item) => lineById.has(item.lineId));
  const sync = state.sync;
  const attributionId = state.specAttribution.specVersionId;
  const newerVersions = state.specVersions.filter((version) => version.id !== attributionId);

  return (
    <div class="inspector-body reconcile-body">
      <div class="reconcile-card library-card">
        <div class="reconcile-card-head">
          <strong>教研组规范库</strong>
          <label class="online-toggle">
            <input type="checkbox" checked={sync.online} onChange={(event: any) => onToggleOnline(event.currentTarget.checked)} />
            {sync.online ? '在线' : '离线（模拟断网）'}
          </label>
        </div>
        <p class="muted-note">
          {sync.online ? '与教研组端点连通。' : '规范库没取回时，学校这份稿照旧可以改，重走对账都在本地进行。'}
        </p>
        <div class="reconcile-actions">
          <md-filled-button disabled={sync.fetchStatus === 'fetching'} onClick={onFetch}>
            {sync.fetchStatus === 'fetching' ? '取回中…' : '取回规范库'}
          </md-filled-button>
          <span class={`sync-state ${sync.fetchStatus === 'failed' ? 'bad' : sync.fetchStatus === 'fetched' ? 'good' : ''}`}>
            {sync.fetchStatus === 'failed' ? `取回失败：${sync.lastFetchError}` : `上次取回 ${formatTime(sync.lastFetchedAt)}`}
          </span>
        </div>
        <div class="spec-version-list">
          {state.specVersions.map((version) => (
            <div class={`spec-version-card ${version.id === attributionId ? 'current' : ''}`} key={version.id}>
              <div>
                <strong>{version.label}</strong>
                <p>发布于 {version.releasedAt}{version.id === attributionId && ' · 本稿当前归属'}</p>
                <p class="spec-notes">{version.notes}</p>
              </div>
              {version.id !== attributionId && (
                <md-filled-tonal-button onClick={() => onApplySpec(version.id)}>按此版本重走</md-filled-tonal-button>
              )}
            </div>
          ))}
          {newerVersions.length === 0 && sync.fetchStatus !== 'fetched' && (
            <p class="muted-note">本地只有当前归属版本；在线时“取回规范库”可拿到教研组新规范。</p>
          )}
        </div>
      </div>

      <div class="reconcile-card">
        <div class="reconcile-card-head">
          <strong>两边对账 · 按行号等老师逐行认</strong>
          <span class="count-badge">{visiblePending.length} 行待认</span>
        </div>
        {visiblePending.length === 0 ? (
          <div class="empty-state compact"><strong>没有待认定的行</strong><p>取回新规范并“按此版本重走”后，受影响的批准行、断词与跨行连字符会按行号列在这里。</p></div>
        ) : (
          <div class="reconcile-item-list">
            {visiblePending.map((item) => {
              const line = lineById.get(item.lineId);
              return (
                <div class={`reconcile-item ${item.wasApproved ? 'was-approved' : ''}`} key={item.id}>
                  <div class="reconcile-item-head">
                    <span class="line-number">第 {item.lineNumber} 行</span>
                    {item.wasApproved && <em class="approved-tag">★ 已批准</em>}
                    {item.reasons.map((reason) => <em class="reason-tag" key={reason}>{reasonLabels[reason as ReconcileReason]}</em>)}
                  </div>
                  {line && <p class="source-readonly" title="原文只读展示，对账流程不会改动">原文：{line.source}</p>}
                  <div class="braille-diff">
                    <div class="diff-side old">
                      <span>旧稿 · {item.fromSpecVersionLabel}</span>
                      <b class="braille-font">{item.oldBraille || '（空）'}</b>
                    </div>
                    <div class="diff-arrow">→</div>
                    <div class="diff-side new">
                      <span>新稿 · {item.toSpecVersionLabel}</span>
                      <b class="braille-font">{item.newBraille || '（空）'}</b>
                    </div>
                  </div>
                  <div class="reconcile-item-actions">
                    <md-filled-button onClick={() => onDecide(item.id, 'accepted-new')}>接受新稿</md-filled-button>
                    <md-outlined-button onClick={() => onDecide(item.id, 'kept-old')}>保留旧稿</md-outlined-button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div class="reconcile-card">
        <div class="reconcile-card-head">
          <strong>对账结果同步教研组</strong>
          <span class="count-badge">{unreported.length} 条没对上</span>
        </div>
        <p class="muted-note">
          老师逐行认定后上报；同步失败只保留本侧决定，重试时只补没对上的条目。
          {sync.lastSyncedAt && ` 上次同步成功 ${formatTime(sync.lastSyncedAt)}。`}
        </p>
        {sync.reportStatus === 'failed' && <p class="sync-error">同步失败：{sync.lastSyncError}</p>}
        <div class="reconcile-actions">
          <md-filled-button disabled={unreported.length === 0 || sync.reportStatus === 'syncing'} onClick={onReport}>
            {sync.reportStatus === 'syncing' ? '同步中…' : unreported.length > 0 ? `重试：只补 ${unreported.length} 条没对上的` : '已全部对上'}
          </md-filled-button>
          {sync.reportStatus === 'synced' && <span class="sync-state good">教研组已收到全部认定</span>}
        </div>
        {unreported.length > 0 && (
          <ul class="decision-log">
            {unreported.slice(0, 6).map((item) => (
              <li key={item.id}>第 {item.lineNumber} 行{lineById.has(item.lineId) ? '' : '（该行已删除）'} · {item.decision === 'accepted-new' ? '接受新稿' : '保留旧稿'} · 待补传</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const { state, history, initialNotice, commit, undo, redo, restore } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'versions' | 'reconcile'>('issues');
  const [migrationDismissed, setMigrationDismissed] = useState(() =>
    !initialNotice || localStorage.getItem(`${MIGRATION_DISMISS_PREFIX}${state.id}`) === '1');
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeSpec = findSpec(state, state.specAttribution.specVersionId);
  const activeRuleSet = findRuleSet(activeSpec, state.activeRuleSetId);
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const pending = pendingItems(state).filter((item) => state.lines.some((line) => line.id === item.lineId));
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;
  const pendingByLine = useMemo(() => new Map(pending.map((item) => [item.lineId, item])), [pending]);

  const dismissMigration = () => {
    localStorage.setItem(`${MIGRATION_DISMISS_PREFIX}${state.id}`, '1');
    setMigrationDismissed(true);
  };

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({
      ...current,
      lines: current.lines.map((line) => {
        if (line.id !== lineId) return line;
        // 老师手改已批准行的原文，原批准自然失效；备注原样保留。
        const approvalReset = line.status === 'approved'
          ? { status: 'questionable' as const, approvedTokens: null }
          : {};
        return { ...line, source, ...approvalReset };
      }),
    }));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => {
        if (line.id !== lineId) return line;
        if (status === 'approved') {
          // 批准即冻结当前盲文快照，新规范重走也不能悄悄改掉它。
          return { ...line, status, approvedTokens: structuredClone(line.tokens) };
        }
        return { ...line, status, approvedTokens: null };
      });
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
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}（${state.specAttribution.specVersionLabel}）\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
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
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · ${state.specAttribution.specVersionLabel} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>) => {
    commit('修改转录规则', (current) => analyzeProject(updateRulesInSpec(current, (ruleSet) => updateRuleInSet(ruleSet, ruleId, patch))));
  };

  const batchFixRule = (ruleId: string) => {
    commit('批量修正同类问题', (current) => analyzeProject(updateRulesInSpec(current, (ruleSet) => updateRuleInSet(ruleSet, ruleId, { enabled: false }))));
  };

  const fetchLibrary = async () => {
    if (state.sync.fetchStatus === 'fetching') return;
    const onlineAtRequest = state.sync.online;
    commit('取回教研组规范库', (current) => ({ ...current, sync: { ...current.sync, fetchStatus: 'fetching', lastFetchError: null } }));
    try {
      const { versions, fetchedAt } = await fetchRemoteSpec({ ...state.sync, online: onlineAtRequest });
      commit('合并教研组规范库', (current) => {
        const known = new Set(current.specVersions.map((version) => version.id));
        const merged = [...current.specVersions];
        versions.forEach((version) => { if (!known.has(version.id)) merged.push(version); });
        return {
          ...current,
          specVersions: merged,
          sync: { ...current.sync, fetchStatus: 'fetched', lastFetchedAt: fetchedAt, lastFetchError: null },
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      commit('取回规范库失败', (current) => ({ ...current, sync: { ...current.sync, fetchStatus: 'failed', lastFetchError: message } }));
    }
  };

  const toggleOnline = (online: boolean) => {
    writeSimulatedOnline(online);
    commit(online ? '恢复教研组连接' : '模拟断开教研组连接', (current) => ({ ...current, sync: { ...current.sync, online } }));
  };

  const applyNewSpec = (specVersionId: string) => {
    commit('按教研组新规范重走转录', (current) => applySpecVersion(current, specVersionId));
    setInspectorTab('reconcile');
  };

  const decideItem = (itemId: string, decision: 'accepted-new' | 'kept-old') => {
    commit(decision === 'accepted-new' ? '逐行接受新规范稿' : '逐行保留旧稿', (current) => decideReconcileItem(current, itemId, decision));
  };

  const reportDecisions = async () => {
    const unreported = unreportedDecidedItems(state);
    if (unreported.length === 0 || state.sync.reportStatus === 'syncing') return;
    const onlineAtRequest = state.sync.online;
    const toReport = unreported.map((item) => item.id);
    commit('同步对账结果给教研组', (current) => ({ ...current, sync: { ...current.sync, reportStatus: 'syncing', lastSyncError: null } }));
    try {
      const { syncedAt } = await reportReconcileDecisions({ ...state.sync, online: onlineAtRequest }, unreported);
      commit('对账结果同步成功', (current) => ({
        ...current,
        reconcileItems: current.reconcileItems.map((item) => (toReport.includes(item.id) ? { ...item, reported: true } : item)),
        sync: { ...current.sync, reportStatus: 'synced', lastSyncedAt: syncedAt, lastSyncError: null },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      commit('对账结果同步失败', (current) => ({ ...current, sync: { ...current.sync, reportStatus: 'failed', lastSyncError: message } }));
    }
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({
        id: `line-import-${Date.now()}-${index}`,
        source,
        tokens: [],
        status: index === 0 ? 'questionable' : 'unchecked',
        note: index === 0 ? '导入后待确认规则集。' : '',
        continuesPrevious: false,
        continuesNext: false,
        specVersionId: current.specAttribution.specVersionId,
        approvedTokens: null,
      })),
      selectedLineId: '',
      issues: [],
      reconcileItems: [],
    }));
  };

  const pendingCount = pending.length;

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${state.sync.online ? 'online' : ''}`} />
          {state.sync.online ? `已连接 · ${state.sync.endpoint}` : '离线模式 · 规范库未取回，学校稿照常可改'}
          <small>上次自动保存 {formatTime(state.updatedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      {initialNotice && !migrationDismissed && (
        <div class="migration-banner" role="status">
          <span>{initialNotice}</span>
          <button onClick={dismissMigration}>知道了</button>
        </div>
      )}

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class={`status-stat ${pendingCount > 0 ? 'warning' : ''} reconcile-stat`} onClick={() => setInspectorTab('reconcile')} role="button" title="打开规范对账">
          <strong>{pendingCount}</strong><span>规范对账待认行</span>
        </div>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用规则</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规则预设并重新检查', (current) => analyzeProject({ ...current, activeRuleSetId: id }))}
          onUpdateRule={updateRule}
          onToggleContractions={() => {
            const ruleSetId = activeRuleSet.id;
            commit('切换缩写规则', (current) => analyzeProject(updateRulesInSpec(current, (ruleSet) => (
              ruleSet.id === ruleSetId ? { ...ruleSet, contractions: !ruleSet.contractions } : ruleSet
            ))));
          }}
          onAddRule={(source, output, suspicious) => {
            commit('新增转写规则', (current) => analyzeProject(updateRulesInSpec(current, (ruleSet) => ({ ...ruleSet, rules: [...ruleSet.rules, makeRule(source, output, suspicious)] }))));
          }}
          onRecheck={() => commit('重新检查全部内容', analyzeProject)}
        />

        <EditorPanel
          state={state}
          pendingByLine={pendingByLine}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => {
            const lines = current.lines.filter((line) => line.id !== lineId);
            return analyzeProject({
              ...current,
              lines: lines.length ? lines : [{
                id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '',
                continuesPrevious: false, continuesNext: false,
                specVersionId: current.specAttribution.specVersionId, approvedTokens: null,
              }],
              selectedLineId: lines[0]?.id ?? '',
              reconcileItems: current.reconcileItems.filter(
                (item) => item.decision !== 'pending' || lines.some((line) => line.id === item.lineId),
              ),
            });
          })}
          onAddLine={() => commit('新增课文行', (current) => {
            const line: TextbookLine = {
              id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '',
              continuesPrevious: false, continuesNext: false,
              specVersionId: current.specAttribution.specVersionId, approvedTokens: null,
            };
            return analyzeProject({ ...current, lines: [...current.lines, line], selectedLineId: line.id });
          })}
          onSplitLongLines={() => commit('按句拆分长行', (current) => {
            const specVersionId = current.specAttribution.specVersionId;
            const lines = current.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({
                ...line,
                id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`,
                source: source.trim(),
                tokens: [],
                note: index === 0 ? line.note : '',
                status: index === 0 ? line.status : 'unchecked',
                specVersionId: line.specVersionId ?? specVersionId,
                approvedTokens: index === 0 ? line.approvedTokens ?? null : null,
              })));
            return analyzeProject({ ...current, lines });
          })}
          onImport={importCourse}
        />

        <aside class="right-panel">
          <div class="inspector-tabs four" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'reconcile' ? 'active' : ''} onClick={() => setInspectorTab('reconcile')}>
              规范对账 {pendingCount > 0 && <span class="hot">{pendingCount}</span>}
            </button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规则详情</button>
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
          {inspectorTab === 'reconcile' && (
            <ReconcilePanel
              state={state}
              onFetch={fetchLibrary}
              onToggleOnline={toggleOnline}
              onApplySpec={applyNewSpec}
              onDecide={decideItem}
              onReport={reportDecisions}
            />
          )}
          {inspectorTab === 'rules' && <RuleDetailPanel state={state} onUpdateRule={updateRule} onDeleteRule={(ruleId) => {
            commit('删除转录规则', (current) => analyzeProject(updateRulesInSpec(current, (ruleSet) => ({ ...ruleSet, rules: ruleSet.rules.filter((rule) => rule.id !== ruleId) }))));
          }} />}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            const restored: ProjectState = cloneState({ ...version.snapshot, versions: state.versions });
            restore(restored);
          }} />}
        </aside>
      </div>
    </div>
  );
}
