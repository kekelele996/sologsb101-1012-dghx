/**
 * 对账 slice：维护现场登记表与对账留痕，执行「并入中心台账」动作。
 * 合并引擎在 utils/merge.ts，本 slice 只管数据订阅与动作分发。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { FieldInstrument, FieldInstrumentDraft } from '@/types/fieldInstrument';
import type { MergeRecord } from '@/types/mergeRecord';
import { reconcileWithRetry, type MergeResult } from '@/utils/merge';
import type { RootState } from '@/stores/store';

type WithReconcile = RootState;

export interface ReconcileSliceState {
  fieldInstruments: FieldInstrument[];
  mergeRecords: MergeRecord[];
  ready: boolean;
  merging: boolean;
  error: string | null;
  lastResult: MergeResult | null;
}

const initialState: ReconcileSliceState = {
  fieldInstruments: [],
  mergeRecords: [],
  ready: false,
  merging: false,
  error: null,
  lastResult: null,
};

/** 新增一条现场登记（离线录入，状态 pending） */
export const createFieldInstrument = createAsyncThunk(
  'reconcile/createFieldInstrument',
  async (payload: FieldInstrumentDraft) => {
    const now = Date.now();
    const row: FieldInstrument = {
      id: createId('fld'),
      tempId: `T-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      ledgerId: payload.ledgerId,
      stationCode: payload.stationCode.trim(),
      type: payload.type,
      model: payload.model.trim(),
      serialNo: payload.serialNo.trim(),
      installDate: payload.installDate,
      mergeStatus: 'pending',
      remark: payload.remark.trim(),
      createdAt: now,
      updatedAt: now,
    };
    await db.fieldInstruments.put(row);
    return row;
  }
);

/** 删除一条现场登记（仅 pending 可删） */
export const removeFieldInstrument = createAsyncThunk(
  'reconcile/removeFieldInstrument',
  async (fieldId: string) => {
    await db.fieldInstruments.delete(fieldId);
    return fieldId;
  }
);

/** 把现场这份并入中心台账（含失败回滚与按侧重试） */
export const mergeFieldIntoCenter = createAsyncThunk(
  'reconcile/mergeFieldIntoCenter',
  async (_, { getState }) => {
    const state = getState() as RootState;
    const result = await reconcileWithRetry(state.reconcile.fieldInstruments);
    return result;
  }
);

/** 逐条核对：切换留痕的「已核对」状态 */
export const toggleMergeReviewed = createAsyncThunk(
  'reconcile/toggleMergeReviewed',
  async (recordId: string) => {
    const record = await db.mergeRecords.get(recordId);
    if (!record) return null;
    const reviewed = !record.reviewed;
    await db.mergeRecords.update(recordId, { reviewed, updatedAt: Date.now() } as never);
    return { recordId, reviewed };
  }
);

const reconcileSlice = createSlice({
  name: 'reconcile',
  initialState,
  reducers: {
    setFieldInstruments(state, action: PayloadAction<FieldInstrument[]>) {
      state.fieldInstruments = action.payload;
      state.ready = true;
    },
    setMergeRecords(state, action: PayloadAction<MergeRecord[]>) {
      state.mergeRecords = action.payload;
    },
    setReconcileError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    clearLastResult(state) {
      state.lastResult = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(mergeFieldIntoCenter.pending, (state) => {
        state.merging = true;
        state.error = null;
      })
      .addCase(mergeFieldIntoCenter.fulfilled, (state, action) => {
        state.merging = false;
        state.lastResult = action.payload;
      })
      .addCase(mergeFieldIntoCenter.rejected, (state, action) => {
        state.merging = false;
        state.error = action.error.message ?? '并入失败';
      })
      .addCase(toggleMergeReviewed.fulfilled, (state, action) => {
        if (!action.payload) return;
        const { recordId, reviewed } = action.payload;
        const record = state.mergeRecords.find((row) => row.id === recordId);
        if (record) record.reviewed = reviewed;
      });
  },
});

export const {
  setFieldInstruments,
  setMergeRecords,
  setReconcileError,
  clearLastResult,
} = reconcileSlice.actions;

let started = false;

/** 启动现场登记与对账留痕表实时订阅（幂等） */
export function startReconcileSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<FieldInstrument>(() => db.fieldInstruments).subscribe((rows) => {
    dispatch(setFieldInstruments(rows));
  });
  watchTable<MergeRecord>(() => db.mergeRecords).subscribe((rows) => {
    dispatch(setMergeRecords(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectReconcileState = (state: WithReconcile): ReconcileSliceState => state.reconcile;
export const selectFieldInstruments = (state: WithReconcile): FieldInstrument[] =>
  state.reconcile.fieldInstruments;
export const selectMergeRecords = (state: WithReconcile): MergeRecord[] =>
  state.reconcile.mergeRecords;
export const selectReconcileMerging = (state: WithReconcile): boolean => state.reconcile.merging;
export const selectReconcileLastResult = (state: WithReconcile): MergeResult | null =>
  state.reconcile.lastResult;

/** 待处理现场登记数 */
export const selectPendingFieldCount = (state: WithReconcile): number =>
  state.reconcile.fieldInstruments.filter((row) => row.mergeStatus === 'pending').length;

/** 未逐条核对的留痕数 */
export const selectUnreviewedCount = (state: WithReconcile): number =>
  state.reconcile.mergeRecords.filter((row) => !row.reviewed).length;

export default reconcileSlice.reducer;
