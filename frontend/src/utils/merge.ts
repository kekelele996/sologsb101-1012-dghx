/**
 * 现场离线台账并入中心台账的执行编排（读写 IndexedDB）。
 *
 * 并入流程（中心那份上一版先保住）：
 * 1. 读取当前中心五表快照，在独立事务中先留存为 MergeBackup（业务写入前必须已落盘）；
 * 2. 用 utils/mergePlan 构建对账计划（撞号挂起、两版对照）；
 * 3. 业务写入放在单个事务里：失败自动按侧重试一遍，两度失败则业务事务整体回滚、
 *    中心台账保持并入前状态，留存失败批次与上一版快照，可在页面查看并手动回滚/重报。
 */
import { createId, db, readCenterSnapshot } from '@/utils/db';
import { buildMergePlan, validateFieldSnapshot, type MergePlan } from '@/utils/mergePlan';
import type {
  MergeBackup,
  MergeBatch,
  MergeReviewItem,
  MergeSide,
  MergeSnapshot,
  MergeSuspended,
} from '@/types/merge';
import { FIELD_OWNED_KEYS, type FieldOwnedKey } from '@/types/merge';

export interface FieldMergeInput {
  /** 现场台账 JSON（备份同构：五表） */
  raw: unknown;
  /** 现场文件名等来源说明 */
  sourceName: string;
  /** 现场快照导出时间（若文件里带） */
  sourceExportedAt?: string | null;
}

export interface FieldMergeResult {
  batchId: string;
  backupId: string;
  plan: MergePlan;
  attempts: number;
}

export class FieldMergeValidationError extends Error {}

/** 解析并校验现场文件 */
export function parseFieldSnapshot(raw: unknown): MergeSnapshot {
  const validation = validateFieldSnapshot(raw);
  if (!validation.ok || !validation.snapshot) {
    throw new FieldMergeValidationError(`现场台账校验失败：${validation.errors.join('；')}`);
  }
  return validation.snapshot;
}

const BUSINESS_TABLES = [
  db.arrays,
  db.stations,
  db.instruments,
  db.calibrations,
  db.replaces,
  db.mergeItems,
  db.mergeSuspended,
  db.mergeBatches,
] as const;

/** 第一步：留存中心台账上一版快照（独立事务，先于任何业务写入提交） */
async function persistCenterBackup(batchId: string): Promise<MergeBackup> {
  const snapshot = await readCenterSnapshot();
  const backup: MergeBackup = {
    id: createId('mbk'),
    batchId,
    createdAt: Date.now(),
    snapshot,
  };
  await db.transaction('rw', [db.mergeBackups], async () => {
    await db.mergeBackups.put(backup);
  });
  return backup;
}

/** 第二步：单事务写入整个批次（事务内异常会整体回滚） */
async function writeMergedBatch(
  batchId: string,
  backupId: string,
  plan: MergePlan,
  sourceName: string,
  sourceExportedAt: string | null
): Promise<void> {
  const now = Date.now();
  await db.transaction('rw', BUSINESS_TABLES, async () => {
    // 引用骨架：现场台站 / 台阵缺失才补挂（按主键 put，已有数据不动）
    if (plan.arraysToAttach.length > 0) await db.arrays.bulkPut(plan.arraysToAttach);
    if (plan.stationsToAttach.length > 0) await db.stations.bulkPut(plan.stationsToAttach);

    // 仪器：新仪器直接进；两边都改过的按「现场字段 + 中心 state/标定」拼合后整行 put
    await db.instruments.bulkPut(plan.mergedInstruments);
    // 注意：现场 calibrations / replaces 一律不写入（标定与更换是标定室专属数据）

    const reviewRows: MergeReviewItem[] = plan.reviewItems.map((item) => ({
      ...item,
      id: createId('mri'),
      batchId,
      status: '待认',
      note: '',
      createdAt: now,
      updatedAt: now,
    }));
    if (reviewRows.length > 0) await db.mergeItems.bulkPut(reviewRows);

    const suspendedRows: MergeSuspended[] = plan.suspended.map((item) => ({
      ...item,
      id: createId('msu'),
      batchId,
      status: '挂起中',
      createdAt: now,
    }));
    if (suspendedRows.length > 0) await db.mergeSuspended.bulkPut(suspendedRows);

    const batch: MergeBatch = {
      id: batchId,
      sourceName,
      sourceExportedAt,
      mergedAt: now,
      status: '已并入',
      stats: plan.stats,
      backupId,
      note: `新增 ${plan.stats.newCount} 台，两边都改 ${plan.stats.modifiedCount} 台，挂起 ${plan.stats.suspendedCount} 台`,
    };
    await db.mergeBatches.put(batch);
  });
}

/** 两度失败后的尽力登记：留一条「并入失败」批次，快照 id 写进备注便于追溯 */
async function recordFailedBatch(
  batchId: string,
  backupId: string,
  plan: MergePlan | null,
  sourceName: string,
  sourceExportedAt: string | null,
  error: unknown
): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  const batch: MergeBatch = {
    id: batchId,
    sourceName,
    sourceExportedAt,
    mergedAt: Date.now(),
    status: '并入失败',
    stats: plan?.stats ?? {
      arrayCount: 0,
      stationCount: 0,
      newCount: 0,
      modifiedCount: 0,
      reviewCount: 0,
      suspendedCount: 0,
      skippedCalibrationCount: 0,
    },
    backupId,
    note: `重试后仍失败，中心台账已回滚到并入前；原因：${reason}`,
  };
  try {
    await db.transaction('rw', [db.mergeBatches], async () => {
      await db.mergeBatches.put(batch);
    });
  } catch {
    // 连失败登记都写不进去时不再抛出（IndexedDB 可能不可用），错误已由调用方上报
  }
}

/**
 * 并入现场台账：先存中心上一版快照，业务事务失败后按侧重试一遍。
 */
export async function applyFieldMerge(input: FieldMergeInput): Promise<FieldMergeResult> {
  const field = parseFieldSnapshot(input.raw);
  const batchId = createId('mbh');

  // 1) 中心上一版先保住（独立事务，失败则直接终止，不做任何业务写入）
  const backup = await persistCenterBackup(batchId);

  // 2) 构建对账计划（纯计算，可安全重试）
  const center = await readCenterSnapshot();
  const plan = buildMergePlan({ center, field });

  // 3) 业务事务：首试 + 按侧重试一遍
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await writeMergedBatch(
        batchId,
        backup.id,
        plan,
        input.sourceName,
        input.sourceExportedAt ?? null
      );
      return { batchId, backupId: backup.id, plan, attempts: attempt };
    } catch (error) {
      lastError = error;
      // 事务已随异常整体回滚，中心数据仍是并入前状态，可安全重试
    }
  }

  await recordFailedBatch(
    batchId,
    backup.id,
    plan,
    input.sourceName,
    input.sourceExportedAt ?? null,
    lastError
  );
  throw new Error(
    `现场台账并入失败（已重试一遍，业务事务已回滚，中心台账未改动；上一版快照 ${backup.id} 已留存）`
  );
}

/**
 * 逐条认：对一个待认条目按字段裁决。
 * 未显式选择的现场拥有字段维持并入时的现场版；任一字段改用中心版即记「改用中心版」。
 * 中心拥有字段（state、历次标定、响应结论）任何情况下都不动。
 */
export async function resolveReviewItem(
  itemId: string,
  choices: Partial<Record<FieldOwnedKey, MergeSide>>,
  note: string
): Promise<MergeReviewItem> {
  const item = await db.mergeItems.get(itemId);
  if (!item) throw new Error('待认条目不存在或已被清理');
  if (item.status === '已认') throw new Error('该条目已逐条认，不能重复裁决');

  const now = Date.now();
  const instrument = await db.instruments.get(item.instrumentId);
  if (!instrument) throw new Error('对应仪器已不在台账中，无法回写裁决');

  // 以当前仪器为基底（并入后就是「现场字段 + 中心 state」），按裁决改回中心版的字段
  const patch: Partial<import('@/types/instrument').Instrument> = {};
  FIELD_OWNED_KEYS.forEach((key) => {
    if (choices[key] === 'center') {
      (patch as Record<string, unknown>)[key] = item.centerInstrument[key];
    }
  });

  const usedCenter = FIELD_OWNED_KEYS.some((key) => choices[key] === 'center');
  await db.transaction('rw', [db.instruments, db.mergeItems], async () => {
    await db.instruments.update(item.instrumentId, { ...patch, updatedAt: now } as never);
    await db.mergeItems.update(itemId, {
      status: '已认',
      decision: usedCenter ? '改用中心版' : '维持现场版',
      fieldChoices: choices,
      note,
      resolvedAt: now,
      updatedAt: now,
    } as never);
  });

  return {
    ...item,
    status: '已认',
    decision: usedCenter ? '改用中心版' : '维持现场版',
    fieldChoices: choices,
    note,
    resolvedAt: now,
    updatedAt: now,
  };
}

/** 挂起仪器认领（确认已知悉撞号，现场处理后会重新报入） */
export async function acknowledgeSuspended(suspendedId: string): Promise<void> {
  const exists = await db.mergeSuspended.get(suspendedId);
  if (!exists) throw new Error('挂起记录不存在');
  await db.mergeSuspended.update(suspendedId, {
    status: '已认领',
    acknowledgedAt: Date.now(),
  } as never);
}

/**
 * 整批回滚：用并入前留存的快照恢复中心五表。
 * 仅允许回滚最近一个成功批次（之后并入过新批次时拒绝，避免覆盖后续工作）。
 */
export async function rollbackBatch(batchId: string): Promise<MergeBatch> {
  const batch = await db.mergeBatches.get(batchId);
  if (!batch) throw new Error('批次不存在');
  if (batch.status !== '已并入') throw new Error(`批次状态为「${batch.status}」，不能回滚`);

  const later = await db.mergeBatches
    .where('mergedAt')
    .above(batch.mergedAt)
    .filter((row) => row.status === '已并入')
    .count();
  if (later > 0) throw new Error('该批次之后又并入过新台账，请先回滚后续批次');

  const backup = await db.mergeBackups.get(batch.backupId);
  if (!backup) throw new Error('并入前快照已丢失，无法回滚');

  await db.transaction(
    'rw',
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.calibrations,
      db.replaces,
      db.mergeItems,
      db.mergeSuspended,
      db.mergeBatches,
    ],
    async () => {
      await db.arrays.clear();
      await db.stations.clear();
      await db.instruments.clear();
      await db.calibrations.clear();
      await db.replaces.clear();
      await db.arrays.bulkPut(backup.snapshot.arrays);
      await db.stations.bulkPut(backup.snapshot.stations);
      await db.instruments.bulkPut(backup.snapshot.instruments);
      await db.calibrations.bulkPut(backup.snapshot.calibrations);
      await db.replaces.bulkPut(backup.snapshot.replaces);

      // 本批次的待认 / 挂起记录随回滚清掉，批次与快照保留留痕
      await db.mergeItems.where('batchId').equals(batchId).delete();
      await db.mergeSuspended.where('batchId').equals(batchId).delete();
      await db.mergeBatches.update(batchId, {
        status: '已回滚',
        note: `${batch.note}；已于 ${new Date().toLocaleString('zh-CN')} 整批回滚到并入前快照`,
      } as never);
    }
  );

  return { ...batch, status: '已回滚' };
}
