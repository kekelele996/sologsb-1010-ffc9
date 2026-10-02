/* 端到端规则校验：迁移归属、批准冻结、规范对账、同步只补未对上的。 */
import assert from 'node:assert';

// --- 最小浏览器环境桩 ---
const memory = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  setItem: (key: string, value: string) => void memory.set(key, String(value)),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
} as unknown as Storage;
(globalThis as any).navigator = { onLine: false };

const { createInitialProject } = await import('./src/sample.ts');
const { analyzeProject, migrateProject } = await import('./src/braille.ts');
const { buildSpecV2, buildSpecV1 } = await import('./src/library.ts');
const { applySpecVersion, decideReconcileItem, pendingItems, unreportedDecidedItems } = await import('./src/reconcile.ts');
const { reportReconcileDecisions, writeSimulatedOnline } = await import('./src/net.ts');

const brailleText = (state: any, lineId: string) => {
  const line = state.lines.find((l: any) => l.id === lineId);
  return line.tokens.map((t: any) => t.braille).join('');
};

// 1) 新项目：line-4 / line-6 已批准且被冻结
let state = createInitialProject(false);
const l4 = state.lines.find((l: any) => l.id === 'line-4')!;
const l6 = state.lines.find((l: any) => l.id === 'line-6')!;
assert.equal(l4.status, 'approved');
assert.ok(l4.approvedTokens && l4.approvedTokens.length > 0, '批准行应有冻结盲文');
const l6ApprovedBefore = brailleText(state, 'line-6');
const l4ApprovedBefore = brailleText(state, 'line-4');

// 2) 取回 v2（在线），按新规范重走
state.sync.online = true;
const v2 = buildSpecV2();
state = { ...state, specVersions: [...state.specVersions, v2] };
const before = state;
state = applySpecVersion(state, v2.id);
const pending = pendingItems(state);
const numbers = pending.map((i) => i.lineNumber);
console.log('待认行号:', numbers, '原因:', pending.map((i) => i.reasons.join('+')));
assert.ok(numbers.includes(4), 'line-4（已批准，盲文变化）必须列出');
assert.ok(numbers.includes(5), 'line-5（跨行连字符受影响）必须摆出');
assert.ok(numbers.includes(6), 'line-6（已批准 ing + 跨行）必须列出');

// 3) 已批准行盲文没有悄悄变
assert.equal(brailleText(state, 'line-4'), l4ApprovedBefore, '已批准行盲文不得悄悄变样');
assert.equal(brailleText(state, 'line-6'), l6ApprovedBefore, '已批准行盲文不得悄悄变样');

// 4) 未批准、纯盲文转写变化行（line-1：The 改输出但词段切分不变）直接按新规范走
const line1 = state.lines.find((l: any) => l.id === 'line-1')!;
assert.equal(line1.specVersionId, v2.id, '未批准的纯规则变化行应直接切到新规范');
// line-2 因新增 light 缩写断了词，虽未批准也要摆出、先钉旧版本等老师认
const line2 = state.lines.find((l: any) => l.id === 'line-2')!;
assert.equal(line2.specVersionId, 'ueb-2025-spring', '断词受影响的未批准行应先钉在旧版本等认定');

// 5) 原文和备注全程不动
const before2 = before.lines.find((l: any) => l.id === 'line-6')!;
const after2 = state.lines.find((l: any) => l.id === 'line-6')!;
assert.equal(after2.source, before2.source, '原文不能动');
assert.equal(after2.note, before2.note, '校对备注不能动');

// 6) 逐行认：line-6 接受新稿 → 用 v2 重转录并重新冻结
const item6 = pending.find((i) => i.lineNumber === 6)!;
state = decideReconcileItem(state, item6.id, 'accepted-new');
const line6After = state.lines.find((l: any) => l.id === 'line-6')!;
assert.equal(line6After.specVersionId, v2.id);
assert.equal(line6After.status, 'approved', '接受新稿后仍为批准');
assert.ok(line6After.approvedTokens && line6After.approvedTokens.length > 0, '接受后重新冻结');
assert.notEqual(brailleText(state, 'line-6'), l6ApprovedBefore, '接受后盲文应为新稿');

// 7) line-4 保留旧稿 → 继续钉在 v1
const item4 = state.reconcileItems.find((i: any) => i.lineNumber === 4 && i.decision === 'pending')!;
state = decideReconcileItem(state, item4.id, 'kept-old');
const line4After = state.lines.find((l: any) => l.id === 'line-4')!;
assert.equal(line4After.specVersionId, 'ueb-2025-spring', '保留旧稿应钉在旧版本');
assert.equal(brailleText(state, 'line-4'), l4ApprovedBefore, '保留旧稿盲文不变');

// 8) 同步失败（离线）→ 已认定条目仍是“没对上”
writeSimulatedOnline(false);
const unreported1 = unreportedDecidedItems(state);
assert.ok(unreported1.length >= 2, '两条认定都还没对上');
await assert.rejects(() => reportReconcileDecisions({ ...state.sync, online: false }, unreported1), /不可达/);

// 9) 恢复在线重试 → 只补没对上的，成功后全部对上
writeSimulatedOnline(true);
const result = await reportReconcileDecisions({ ...state.sync, online: true }, unreported1);
assert.deepEqual(result.reportedIds.sort(), unreported1.map((i) => i.id).sort());
state = {
  ...state,
  reconcileItems: state.reconcileItems.map((i: any) => (result.reportedIds.includes(i.id) ? { ...i, reported: true } : i)),
};
assert.equal(unreportedDecidedItems(state).length, 0, '重试成功后没有没对上的');

// 10) 旧稿首次打开补归属（legacy 形态：只有 ruleSets，无 spec 字段）
const legacyRaw = JSON.parse(JSON.stringify(createInitialProject(false)));
delete legacyRaw.specVersions;
delete legacyRaw.specAttribution;
delete legacyRaw.reconcileItems;
delete legacyRaw.sync;
legacyRaw.ruleSets = buildSpecV1().ruleSets;
// 旧稿没有逐行规范版本字段，也没有批准冻结快照
legacyRaw.lines = legacyRaw.lines.map((l: any) => {
  delete l.specVersionId;
  delete l.approvedTokens;
  return l;
});
assert.equal(legacyRaw.lines.find((l: any) => l.id === 'line-4').approvedTokens, undefined);
const { state: migrated, migrated: wasLegacy } = migrateProject(legacyRaw);
assert.equal(wasLegacy, true, '应识别为旧稿');
assert.equal(migrated.specAttribution.specVersionId, 'ueb-2025-spring', '补归属到 2025 现行版');
assert.equal(migrated.lines.find((l: any) => l.id === 'line-4').specVersionId, 'ueb-2025-spring');
const migratedAnalyzed = analyzeProject(migrated);
const frozenLine = migratedAnalyzed.lines.find((l: any) => l.id === 'line-4')!;
assert.ok(frozenLine.approvedTokens && frozenLine.approvedTokens.length > 0, '旧稿批准行应用现有盲文冻结');

console.log('\n全部断言通过 ✔');
