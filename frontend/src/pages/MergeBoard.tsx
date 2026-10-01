/**
 * 模块 6：/merge 现场离线台账并入中心对账。
 *
 * 现场布设班在平板离线登记仪器（型号、序列号、安装日期、所属台站），网络恢复后
 * 把现场那份 JSON 并到台网中心标定室的正式台账：
 * - 现场字段以现场版为准；在用状态、历次标定与响应结论始终保留中心版；
 * - 两边都改过的仪器两版都留，生成待认条目逐条认（可逐字段改回中心版）；
 * - 序列号撞在册仪器（或现场批内重号）的整台挂起，不进台账；
 * - 并入前先留存中心上一版快照；业务事务失败自动重试一遍，两度失败则中心不动，
 *   留存失败批次与快照，可整批回滚。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Radio,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { CloudSyncOutlined, RollbackOutlined, UploadOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations, selectReplaces } from '@/stores/calibrationSlice';
import {
  acknowledgeMergeSuspended,
  clearMergeReceipt,
  mergeFieldLedger,
  resolveMergeReview,
  rollbackMergeBatch,
  selectActiveSuspendedCount,
  selectMergeBatches,
  selectMergeError,
  selectMergeReady,
  selectMergeReceipt,
  selectMergeReviewItems,
  selectMergeRunning,
  selectMergeSuspended,
  selectPendingReviewCount,
} from '@/stores/mergeSlice';
import { DB_VERSION, type BackupPayload } from '@/utils/db';
import { readFileText } from '@/utils/export';
import { parseFieldSnapshot, FieldMergeValidationError } from '@/utils/merge';
import { buildMergePlan, type MergePlan } from '@/utils/mergePlan';
import { MERGE_SUSPEND_REASON_TEXT, type MergeReviewItem, type MergeSide, type MergeSnapshot, type MergeSuspended, type FieldOwnedKey } from '@/types/merge';

interface PlanPreview {
  fileName: string;
  sourceExportedAt: string | null;
  snapshot: MergeSnapshot;
  plan: MergePlan;
}

interface ReviewFormValues {
  note?: string;
  choices: Record<string, MergeSide>;
}

export default function MergeBoard() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();

  const arrays = useAppSelector(selectArrays);
  const stations = useAppSelector(selectStations);
  const instruments = useAppSelector(selectInstruments);
  const calibrations = useAppSelector(selectCalibrations);
  const replaces = useAppSelector(selectReplaces);

  const ready = useAppSelector(selectMergeReady);
  const running = useAppSelector(selectMergeRunning);
  const error = useAppSelector(selectMergeError);
  const receipt = useAppSelector(selectMergeReceipt);
  const reviewItems = useAppSelector(selectMergeReviewItems);
  const suspendedRows = useAppSelector(selectMergeSuspended);
  const batches = useAppSelector(selectMergeBatches);
  const pendingCount = useAppSelector(selectPendingReviewCount);
  const activeSuspendedCount = useAppSelector(selectActiveSuspendedCount);

  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<MergeReviewItem | null>(null);
  const [reviewForm] = Form.useForm<ReviewFormValues>();
  const [submittingReview, setSubmittingReview] = useState(false);

  const stationCodeMap = useMemo(() => {
    const map = new Map<string, string>();
    stations.forEach((station) => map.set(station.id, station.code));
    return map;
  }, [stations]);

  const pendingItems = reviewItems.filter((row) => row.status === '待认');
  const resolvedItems = reviewItems.filter((row) => row.status === '已认');
  const activeSuspended = suspendedRows.filter((row) => row.status === '挂起中');
  const acknowledgedSuspended = suspendedRows.filter((row) => row.status === '已认领');
  const failedBatches = batches.filter((row) => row.status === '并入失败');
  const rolledBackBatches = batches.filter((row) => row.status === '已回滚');

  /** 选择现场文件后做只读试算，展示并入计划但不写库 */
  const handleSelectFile = async (file: File): Promise<void> => {
    setPreviewError(null);
    setPreview(null);
    try {
      const text = await readFileText(file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new FieldMergeValidationError('文件不是合法的 JSON，无法解析');
      }
      const snapshot = parseFieldSnapshot(parsed);
      const sourceExportedAt =
        parsed && typeof parsed === 'object' && 'exportedAt' in parsed &&
        typeof (parsed as Partial<BackupPayload>).exportedAt === 'string'
          ? ((parsed as BackupPayload).exportedAt as string)
          : null;
      const center: MergeSnapshot = { arrays, stations, instruments, calibrations, replaces };
      const plan = buildMergePlan({ center, field: snapshot });
      setPreview({ fileName: file.name, sourceExportedAt, snapshot, plan });
    } catch (err) {
      const text = err instanceof FieldMergeValidationError
        ? err.message
        : `现场文件读取失败：${err instanceof Error ? err.message : '未知错误'}`;
      setPreviewError(text);
      message.error(text);
    }
  };

  const handleMerge = async (): Promise<void> => {
    if (!preview) return;
    const { stats } = preview.plan;
    const confirmed = window.confirm(
      `并入前会先留存中心台账上一版快照。本次将新增仪器 ${stats.newCount} 台、` +
        `两边都改 ${stats.modifiedCount} 台（生成 ${stats.reviewCount} 条待认）、` +
        `撞号挂起 ${stats.suspendedCount} 台；现场标定记录 ${stats.skippedCalibrationCount} 条不并入。确认继续？`
    );
    if (!confirmed) return;
    try {
      await dispatch(
        mergeFieldLedger({
          raw: preview.snapshot,
          sourceName: preview.fileName,
          sourceExportedAt: preview.sourceExportedAt,
        })
      ).unwrap();
      message.success('现场台账并入完成');
      setPreview(null);
      setFileList([]);
    } catch {
      // 失败信息由全局 error 提示条展示
    }
  };

  const openReview = (item: MergeReviewItem): void => {
    setReviewTarget(item);
    const initialChoices = item.fieldChoices ?? {};
    const choices: Record<string, MergeSide> = {};
    item.diffs
      .filter((diff) => diff.owner === 'field' && diff.key !== 'calibrations')
      .forEach((diff) => {
        choices[diff.key] = initialChoices[diff.key as FieldOwnedKey] ?? 'field';
      });
    reviewForm.setFieldsValue({ note: item.note ?? '', choices });
  };

  const handleReviewSubmit = async (): Promise<void> => {
    if (!reviewTarget) return;
    const values = await reviewForm.validateFields();
    setSubmittingReview(true);
    try {
      await dispatch(
        resolveMergeReview({
          itemId: reviewTarget.id,
          choices: values.choices as Partial<Record<FieldOwnedKey, MergeSide>>,
          note: values.note ?? '',
        })
      ).unwrap();
      message.success('已完成逐条认');
      setReviewTarget(null);
    } catch {
      // 校验失败或写库失败：弹窗保留 / 全局提示
    } finally {
      setSubmittingReview(false);
    }
  };

  const handleAcknowledge = async (row: MergeSuspended): Promise<void> => {
    const confirmed = window.confirm(
      `确认认领挂起仪器「${row.serialNo}」？认领后该台仍不在台账中，需现场核实序列号后重新报入。`
    );
    if (!confirmed) return;
    try {
      await dispatch(acknowledgeMergeSuspended(row.id)).unwrap();
      message.success('已认领挂起记录');
    } catch {
      // 全局提示
    }
  };

  const handleRollback = async (batchId: string): Promise<void> => {
    const confirmed = window.confirm(
      '将用并入前留存的中心快照恢复五张业务表（该批次的待认与挂起记录会清除，批次与快照保留留痕）。确认整批回滚？'
    );
    if (!confirmed) return;
    try {
      await dispatch(rollbackMergeBatch(batchId)).unwrap();
      message.success('已整批回滚到并入前快照');
    } catch {
      // 全局提示
    }
  };

  const reviewColumns: ColumnsType<MergeReviewItem> = [
    { title: '序列号', dataIndex: 'serialNo', width: 200, className: 'gb-mono' },
    { title: '型号', dataIndex: 'model', width: 150 },
    {
      title: '所属台站（中心）',
      width: 150,
      render: (_: unknown, row) => (
        <span>{stationCodeMap.get(row.centerInstrument.stationId) ?? row.centerInstrument.stationId}</span>
      ),
    },
    {
      title: '差异字段',
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          {row.diffs
            .filter((diff) => diff.owner === 'field')
            .map((diff) => (
              <Tag key={diff.key} color="orange">
                {diff.label}
              </Tag>
            ))}
          <Tag color="blue">标定/结论保留中心版</Tag>
        </Space>
      ),
    },
    { title: '现场/中心标定', width: 130, align: 'right', className: 'gb-mono', render: (_: unknown, row) => (
      <span>{row.fieldCalibrationCount} / {row.centerCalibrationCount}</span>
    ) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string, row) =>
        value === '待认' ? <Tag color="red">待认</Tag> : <Tag color="green">已认 · {row.decision}</Tag>,
    },
    {
      title: '操作',
      width: 110,
      render: (_: unknown, row) =>
        row.status === '待认' ? (
          <Button type="link" size="small" onClick={() => openReview(row)}>
            逐条认
          </Button>
        ) : (
          <Button type="link" size="small" onClick={() => setReviewTarget(row)}>
            查看
          </Button>
        ),
    },
  ];

  const suspendedColumns: ColumnsType<MergeSuspended> = [
    { title: '序列号', dataIndex: 'serialNo', width: 200, className: 'gb-mono' },
    { title: '型号', dataIndex: 'model', width: 140 },
    { title: '安装日期', dataIndex: 'installDate', width: 120, className: 'gb-mono' },
    {
      title: '挂起原因',
      dataIndex: 'reason',
      width: 160,
      render: (value: MergeSuspended['reason']) => (
        <Tag color="volcano">{MERGE_SUSPEND_REASON_TEXT[value]}</Tag>
      ),
    },
    { title: '说明', dataIndex: 'detail' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: string) =>
        value === '挂起中' ? <Tag color="volcano">挂起中</Tag> : <Tag>已认领</Tag>,
    },
    {
      title: '操作',
      width: 90,
      render: (_: unknown, row) =>
        row.status === '挂起中' ? (
          <Button type="link" size="small" onClick={() => void handleAcknowledge(row)}>
            认领
          </Button>
        ) : null,
    },
  ];

  const batchColumns: ColumnsType<(typeof batches)[number]> = [
    { title: '批次', dataIndex: 'id', width: 190, className: 'gb-mono' },
    { title: '来源文件', dataIndex: 'sourceName', width: 200 },
    {
      title: '并入时间',
      dataIndex: 'mergedAt',
      width: 170,
      render: (value: number) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: string) => {
        if (value === '已并入') return <Tag color="green">已并入</Tag>;
        if (value === '已回滚') return <Tag>已回滚</Tag>;
        return <Tag color="red">并入失败</Tag>;
      },
    },
    {
      title: '统计（新增/两版/待认/挂起）',
      width: 200,
      className: 'gb-mono',
      render: (_: unknown, row) => (
        <span>
          {row.stats.newCount} / {row.stats.modifiedCount} / {row.stats.reviewCount} /{' '}
          {row.stats.suspendedCount}
        </span>
      ),
    },
    { title: '上一版快照', dataIndex: 'backupId', width: 190, className: 'gb-mono' },
    { title: '备注', dataIndex: 'note' },
    {
      title: '操作',
      width: 100,
      render: (_: unknown, row) =>
        row.status === '已并入' ? (
          <Button
            type="link"
            size="small"
            danger
            icon={<RollbackOutlined />}
            onClick={() => void handleRollback(row.id)}
          >
            整批回滚
          </Button>
        ) : null,
    },
  ];

  const latestSuccessBatchId = useMemo(() => {
    const success = batches.filter((row) => row.status === '已并入');
    return success.length > 0 ? success[0]?.id : null;
  }, [batches]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            现场离线台账并入对账
          </Typography.Title>
          <p className="gb-hint">
            网络恢复后把布设班平板上的现场登记并入标定室正式台账：现场字段按现场版写，在用状态、历次标定与响应结论按中心版留；两边都改过的逐条认，撞号的先挂起。
          </p>
        </div>
        <Tag icon={<CloudSyncOutlined />} color="blue">
          结构 v{DB_VERSION} · 并入前自动留存中心上一版
        </Tag>
      </div>

      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          closable
          onClose={() => dispatch(clearMergeReceipt())}
        />
      ) : null}
      {receipt ? (
        <Alert
          type="success"
          showIcon
          message={receipt}
          closable
          onClose={() => dispatch(clearMergeReceipt())}
        />
      ) : null}

      <div className="gb-stats-row">
        <StatBadge label="待逐条认" value={pendingCount} suffix="条" tone="danger" />
        <StatBadge label="已认" value={resolvedItems.length} suffix="条" tone="success" />
        <StatBadge label="撞号挂起中" value={activeSuspendedCount} suffix="台" tone="warning" />
        <StatBadge label="已认领" value={acknowledgedSuspended.length} suffix="台" tone="default" />
        <StatBadge label="并入失败批次" value={failedBatches.length} suffix="批" tone="danger" />
        <StatBadge label="已回滚批次" value={rolledBackBatches.length} suffix="批" tone="info" />
      </div>

      <Card className="gb-panel" size="small" title="选择现场台账 JSON（离线平板导出）">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Upload
              fileList={fileList}
              maxCount={1}
              accept="application/json"
              beforeUpload={(file) => {
                setFileList([file]);
                void handleSelectFile(file as File);
                return false;
              }}
              onRemove={() => {
                setPreview(null);
                setPreviewError(null);
              }}
            >
              <Button icon={<UploadOutlined />}>选择现场 JSON</Button>
            </Upload>
            <Button
              type="primary"
              icon={<CloudSyncOutlined />}
              loading={running}
              disabled={!preview}
              onClick={() => void handleMerge()}
            >
              并入中心台账
            </Button>
          </Space>

          {previewError ? <Alert type="error" showIcon message={previewError} /> : null}

          {preview ? (
            <Alert
              type="info"
              showIcon
              message={`试算完成：${preview.fileName}${
                preview.sourceExportedAt ? `（现场导出于 ${new Date(preview.sourceExportedAt).toLocaleString('zh-CN')}）` : ''
              }`}
              description={
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Descriptions size="small" column={4} bordered>
                    <Descriptions.Item label="新增仪器">{preview.plan.stats.newCount} 台</Descriptions.Item>
                    <Descriptions.Item label="两边都改">{preview.plan.stats.modifiedCount} 台</Descriptions.Item>
                    <Descriptions.Item label="待逐条认">{preview.plan.stats.reviewCount} 条</Descriptions.Item>
                    <Descriptions.Item label="撞号挂起">{preview.plan.stats.suspendedCount} 台</Descriptions.Item>
                    <Descriptions.Item label="补挂台站">{preview.plan.stats.stationCount} 个</Descriptions.Item>
                    <Descriptions.Item label="补挂台阵">{preview.plan.stats.arrayCount} 个</Descriptions.Item>
                    <Descriptions.Item label="现场标定（不并入）" span={2}>
                      {preview.plan.stats.skippedCalibrationCount} 条
                    </Descriptions.Item>
                  </Descriptions>
                  <span className="gb-hint">
                    试算只读不写库；点「并入中心台账」后先存中心上一版快照，业务写入失败会自动按侧重试一遍。
                  </span>
                </Space>
              }
            />
          ) : (
            <EmptyPanel
              compact
              title="尚未选择现场台账"
              description="现场布设班在平板离线登记后导出的五表 JSON（与备份同构）；选择后先给出并入试算。"
            />
          )}
        </Space>
      </Card>

      <Card
        className="gb-panel"
        size="small"
        title={`两边都改过 · 待逐条认（${pendingItems.length}）`}
        extra={<span className="gb-hint">两版都留着，默认维持现场版，可逐字段改用中心版</span>}
      >
        <Table
          rowKey="id"
          size="small"
          className="gb-table-compact"
          loading={!ready}
          dataSource={reviewItems}
          pagination={false}
          locale={{
            emptyText: (
              <EmptyPanel compact title="没有待认条目" description="两边都改过同一台仪器时，才会在这里逐条认。" />
            ),
          }}
          columns={reviewColumns}
          expandable={{
            expandedRowRender: (row) => (
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                dataSource={row.diffs}
                columns={[
                  { title: '字段', dataIndex: 'label', width: 180 },
                  { title: '现场布设班版', dataIndex: 'fieldValue' },
                  { title: '中心标定室版', dataIndex: 'centerValue' },
                  {
                    title: '归属',
                    dataIndex: 'owner',
                    width: 160,
                    render: (value: MergeSide) =>
                      value === 'field' ? <Tag color="orange">现场拥有，并入取现场</Tag> : <Tag color="blue">中心专属，始终保留</Tag>,
                  },
                ]}
              />
            ),
          }}
        />
      </Card>

      <Card
        className="gb-panel"
        size="small"
        title={`序列号撞号挂起（${activeSuspended.length}）`}
        extra={<span className="gb-hint">挂起仪器不写入 instruments，核实序列号后由现场重新报入</span>}
      >
        <Table
          rowKey="id"
          size="small"
          className="gb-table-compact"
          dataSource={suspendedRows}
          pagination={false}
          locale={{
            emptyText: <EmptyPanel compact title="没有挂起仪器" description="现场序列号与在册仪器撞号时会挂在这里。" />,
          }}
          columns={suspendedColumns}
        />
      </Card>

      <Card
        className="gb-panel"
        size="small"
        title={`并入批次与中心上一版快照（${batches.length}）`}
        extra={
          <span className="gb-hint">
            {latestSuccessBatchId ? '仅最近一个「已并入」批次允许整批回滚' : '尚无成功批次'}
          </span>
        }
      >
        <Table
          rowKey="id"
          size="small"
          className="gb-table-compact"
          dataSource={batches}
          pagination={false}
          locale={{
            emptyText: <EmptyPanel compact title="还没有并入批次" description="并入现场台账后这里会留下批次与快照记录。" />,
          }}
          columns={batchColumns}
        />
      </Card>

      <Modal
        title={
          reviewTarget
            ? `逐条认 · ${reviewTarget.serialNo}（${reviewTarget.model}）`
            : ''
        }
        open={reviewTarget !== null}
        width={720}
        confirmLoading={submittingReview}
        okText={reviewTarget?.status === '待认' ? '提交裁决' : '关闭'}
        cancelText={reviewTarget?.status === '待认' ? '取消' : undefined}
        onOk={() => {
          if (reviewTarget?.status === '待认') void handleReviewSubmit();
          else setReviewTarget(null);
        }}
        onCancel={() => setReviewTarget(null)}
      >
        {reviewTarget ? (
          <Form form={reviewForm} layout="vertical">
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="现场拥有字段默认维持已并入的现场版，可逐个改回中心版；在用状态、历次标定与响应结论归属中心，不可改。"
            />
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={reviewTarget.diffs}
              columns={[
                { title: '字段', dataIndex: 'label', width: 150 },
                { title: '现场版', dataIndex: 'fieldValue' },
                { title: '中心版', dataIndex: 'centerValue' },
                {
                  title: '本条采纳',
                  width: 200,
                  render: (_, diff) =>
                    diff.owner === 'center' || diff.key === 'calibrations' ? (
                      <Tag color="blue">固定中心版</Tag>
                    ) : (
                      <Form.Item name={['choices', diff.key]} valuePropName="value" style={{ marginBottom: 0 }}>
                        <Radio.Group
                          optionType="button"
                          size="small"
                          options={[
                            { label: '现场版', value: 'field' },
                            { label: '中心版', value: 'center' },
                          ]}
                        />
                      </Form.Item>
                    ),
                },
              ]}
            />
            {reviewTarget.status === '已认' ? (
              <Alert
                style={{ marginTop: 12 }}
                type="success"
                showIcon
                message={`该条目已认：${reviewTarget.decision ?? ''}${reviewTarget.note ? `；备注：${reviewTarget.note}` : ''}`}
              />
            ) : (
              <Form.Item name="note" label="裁决备注" style={{ marginTop: 12 }}>
                <Input placeholder="如：现场换过型号铭牌，以现场照片为准" />
              </Form.Item>
            )}
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
