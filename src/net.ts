import { buildSpecV2 } from './library';
import type { ReconcileItem, SpecVersion, SyncState } from './types';

const ONLINE_KEY = 'sologsb-1010-connection-online';

export function readSimulatedOnline(): boolean {
  const stored = localStorage.getItem(ONLINE_KEY);
  if (stored === null) return false; // 默认离线：先演示“规范库没取回，学校照旧能改”
  return stored === '1';
}

export function writeSimulatedOnline(online: boolean): void {
  localStorage.setItem(ONLINE_KEY, online ? '1' : '0');
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 模拟从教研组规范库取回：离线/断网时抛错，由调用方保留学校现有版本，不动稿子。 */
export async function fetchRemoteSpec(sync: SyncState): Promise<{ versions: SpecVersion[]; fetchedAt: string }> {
  await delay(650);
  if (!sync.online) {
    throw new Error('无法连接教研组规范库（当前为离线/断网模拟）');
  }
  return { versions: [buildSpecV2()], fetchedAt: new Date().toISOString() };
}

/**
 * 模拟把老师逐行认定结果上报教研组。
 * 只传“还没对上”的条目；调用方在成功后把它们标记为 reported。
 */
export async function reportReconcileDecisions(
  sync: SyncState,
  items: ReconcileItem[],
): Promise<{ reportedIds: string[]; syncedAt: string }> {
  await delay(700);
  if (!sync.online) {
    throw new Error('同步失败：教研组端点不可达，已保留本侧决定，恢复后只补未对上的条目');
  }
  if (items.length === 0) {
    return { reportedIds: [], syncedAt: new Date().toISOString() };
  }
  return { reportedIds: items.map((item) => item.id), syncedAt: new Date().toISOString() };
}
