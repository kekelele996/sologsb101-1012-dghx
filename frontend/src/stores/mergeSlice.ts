/**
 * 现场台账合并 slice：维护待认条目、挂起仪器、并入批次与上一版快照的实时数据，
 * 以及「并入 / 逐条认 / 认领 / 回滚」异步动作；纯编排逻辑在 utils/merge.ts。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, watchTable } from '@/utils/db';
import type {
  MergeBackup,
  MergeBatch,
  MergeReviewItem,
  MergeSide,
  MergeSuspended,
} from '@/types/merge';
import type { FieldOwnedKey } from '@/types/merge';
import {
  acknowledgeSuspended,
  applyFieldMerge,
  resolveReviewItem,
  rollbackBatch,
} from '@/utils/merge';
import type { RootState } from '@/stores/store';

type WithMerge = RootState;

export interface MergeSliceState {
  reviewItems: MergeReviewItem[];
  suspended: MergeSuspended[];
  batches: MergeBatch[];
  backups: MergeBackup[];
  ready: boolean;
  running: boolean;
  error: string | null;
  /** 最近一次操作回执 */
  lastReceipt: string;
}

const initialState: MergeSliceState = {
  reviewItems: [],
  suspended: [],
  batches: [],
  backups: [],
  ready: false,
  running: false,
  error: null,
  lastReceipt: '',
};

export const mergeFieldLedger = createAsyncThunk(
  'merge/mergeFieldLedger',
  async (payload: { raw: unknown; sourceName: string; sourceExportedAt?: string | null }) => {
    return applyFieldMerge(payload);
  }
);

export const resolveMergeReview = createAsyncThunk(
  'merge/resolveMergeReview',
  async (payload: {
    itemId: string;
    choices: Partial<Record<FieldOwnedKey, MergeSide>>;
    note: string;
  }) => {
    return resolveReviewItem(payload.itemId, payload.choices, payload.note);
  }
);

export const acknowledgeMergeSuspended = createAsyncThunk(
  'merge/acknowledgeMergeSuspended',
  async (suspendedId: string) => {
    await acknowledgeSuspended(suspendedId);
    return suspendedId;
  }
);

export const rollbackMergeBatch = createAsyncThunk(
  'merge/rollbackMergeBatch',
  async (batchId: string) => {
    return rollbackBatch(batchId);
  }
);

const mergeSlice = createSlice({
  name: 'merge',
  initialState,
  reducers: {
    setMergeReviewItems(state, action: PayloadAction<MergeReviewItem[]>) {
      state.reviewItems = action.payload;
      state.ready = true;
      state.error = null;
    },
    setMergeSuspended(state, action: PayloadAction<MergeSuspended[]>) {
      state.suspended = action.payload;
    },
    setMergeBatches(state, action: PayloadAction<MergeBatch[]>) {
      state.batches = action.payload;
    },
    setMergeBackups(state, action: PayloadAction<MergeBackup[]>) {
      state.backups = action.payload;
    },
    setMergeError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    clearMergeReceipt(state) {
      state.lastReceipt = '';
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(mergeFieldLedger.pending, (state) => {
        state.running = true;
        state.error = null;
      })
      .addCase(mergeFieldLedger.fulfilled, (state, action) => {
        state.running = false;
        const { stats } = action.payload.plan;
        state.lastReceipt =
          `现场台账已并入（第 ${action.payload.attempts} 次尝试成功）：新增仪器 ${stats.newCount} 台，` +
          `两边都改 ${stats.modifiedCount} 台并生成 ${stats.reviewCount} 条待认，` +
          `撞号挂起 ${stats.suspendedCount} 台；中心历次标定全部保留。`;
      })
      .addCase(mergeFieldLedger.rejected, (state, action) => {
        state.running = false;
        state.error = action.error.message ?? '现场台账并入失败';
      })
      .addCase(resolveMergeReview.fulfilled, (state, action) => {
        state.lastReceipt = `仪器 ${action.payload.serialNo} 已逐条认：${action.payload.decision ?? ''}`;
      })
      .addCase(resolveMergeReview.rejected, (state, action) => {
        state.error = action.error.message ?? '逐条认失败';
      })
      .addCase(acknowledgeMergeSuspended.fulfilled, (state, action) => {
        state.lastReceipt = `挂起仪器 ${action.payload} 已认领`;
      })
      .addCase(acknowledgeMergeSuspended.rejected, (state, action) => {
        state.error = action.error.message ?? '认领失败';
      })
      .addCase(rollbackMergeBatch.fulfilled, (state, action) => {
        state.lastReceipt = `批次 ${action.payload.id} 已整批回滚，中心台账恢复到并入前快照`;
      })
      .addCase(rollbackMergeBatch.rejected, (state, action) => {
        state.error = action.error.message ?? '回滚失败';
      });
  },
});

export const {
  setMergeReviewItems,
  setMergeSuspended,
  setMergeBatches,
  setMergeBackups,
  setMergeError,
  clearMergeReceipt,
} = mergeSlice.actions;

let started = false;

/** 启动对账四表实时订阅（幂等） */
export function startMergeSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<MergeReviewItem>(() => db.mergeItems).subscribe((rows) => {
    dispatch(setMergeReviewItems(rows));
  });
  watchTable<MergeSuspended>(() => db.mergeSuspended).subscribe((rows) => {
    dispatch(setMergeSuspended(rows));
  });
  watchTable<MergeBatch>(() => db.mergeBatches).subscribe((rows) => {
    dispatch(setMergeBatches(rows));
  });
  watchTable<MergeBackup>(() => db.mergeBackups).subscribe((rows) => {
    dispatch(setMergeBackups(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectMergeState = (state: WithMerge): MergeSliceState => state.merge;
export const selectMergeReady = (state: WithMerge): boolean => state.merge.ready;
export const selectMergeRunning = (state: WithMerge): boolean => state.merge.running;
export const selectMergeError = (state: WithMerge): string | null => state.merge.error;
export const selectMergeReceipt = (state: WithMerge): string => state.merge.lastReceipt;
export const selectMergeReviewItems = (state: WithMerge): MergeReviewItem[] =>
  state.merge.reviewItems;
export const selectMergeSuspended = (state: WithMerge): MergeSuspended[] => state.merge.suspended;
export const selectMergeBatches = (state: WithMerge): MergeBatch[] => state.merge.batches;
export const selectMergeBackups = (state: WithMerge): MergeBackup[] => state.merge.backups;

export const selectPendingReviewCount = (state: WithMerge): number =>
  state.merge.reviewItems.filter((row) => row.status === '待认').length;
export const selectActiveSuspendedCount = (state: WithMerge): number =>
  state.merge.suspended.filter((row) => row.status === '挂起中').length;

export default mergeSlice.reducer;
