/**
 * 模块 6：/reconcile 现场对账合并
 * 野外布设班离线登记的现场仪器（型号 / 序列号 / 安装日期 / 所属台站）并入台网中心台账对账：
 * - 两边都改过：现场字段按布设班那份写，历次标定与响应结论按标定室那份写，两版都留着让人逐条认；
 * - 序列号撞号：先挂起不进台账；
 * - 并入失败：保住中心台账上一版，按侧重试一遍。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudUploadOutlined,
  DiffOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createFieldInstrument,
  mergeFieldIntoCenter,
  removeFieldInstrument,
  selectFieldInstruments,
  selectMergeRecords,
  selectPendingFieldCount,
  selectReconcileLastResult,
  selectReconcileMerging,
  selectUnreviewedCount,
  toggleMergeReviewed,
} from '@/stores/reconcileSlice';
import { INSTRUMENT_TYPES, type InstrumentType } from '@/types/instrument';
import type { FieldInstrument, FieldMergeStatus } from '@/types/fieldInstrument';
import type { MergeRecord } from '@/types/mergeRecord';

const { Title, Text, Paragraph } = Typography;

const STATUS_TAG: Record<FieldMergeStatus, { color: string; text: string }> = {
  pending: { color: 'default', text: '待处理' },
  added: { color: 'success', text: '已新增' },
  merged: { color: 'processing', text: '已合并' },
  suspended: { color: 'error', text: '已挂起' },
};

const KIND_TAG: Record<MergeRecord['kind'], { color: string; text: string }> = {
  added: { color: 'success', text: '新增' },
  merged: { color: 'processing', text: '两边都改' },
  suspended: { color: 'error', text: '撞号挂起' },
};

/** 比较现场版与中心版的差异字段，返回「字段名 + 现场值 / 中心值」 */
function diffFields(record: MergeRecord): Array<{ label: string; field: string; center: string }> {
  if (!record.centerSnapshot) return [];
  const f = record.fieldSnapshot;
  const c = record.centerSnapshot;
  const diffs: Array<{ label: string; field: string; center: string }> = [];
  if (f.type !== c.type) diffs.push({ label: '类型', field: f.type, center: c.type });
  if (f.model !== c.model) diffs.push({ label: '型号', field: f.model, center: c.model });
  if (f.serialNo !== c.serialNo)
    diffs.push({ label: '序列号', field: f.serialNo, center: c.serialNo });
  if (f.installDate !== c.installDate)
    diffs.push({ label: '安装日期', field: f.installDate, center: c.installDate });
  return diffs;
}

export default function ReconcileBoard() {
  const { message, modal } = AntdApp.useApp();
  const dispatch = useAppDispatch();

  const fieldRows = useAppSelector(selectFieldInstruments);
  const records = useAppSelector(selectMergeRecords);
  const merging = useAppSelector(selectReconcileMerging);
  const lastResult = useAppSelector(selectReconcileLastResult);
  const pendingCount = useAppSelector(selectPendingFieldCount);
  const unreviewedCount = useAppSelector(selectUnreviewedCount);

  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  const sortedFieldRows = useMemo(
    () => [...fieldRows].sort((a, b) => a.tempId.localeCompare(b.tempId)),
    [fieldRows]
  );
  const sortedRecords = useMemo(
    () => [...records].sort((a, b) => b.createdAt - a.createdAt),
    [records]
  );

  const handleMerge = async (): Promise<void> => {
    if (pendingCount === 0) {
      message.info('没有待处理的现场登记');
      return;
    }
    const result = await dispatch(mergeFieldIntoCenter()).unwrap();
    if (result.retried) {
      message.warning(
        `首次现场侧重并入失败（${result.failureReason}），已保住中心台账上一版，按中心侧重试成功`
      );
    } else {
      message.success(
        `并入完成：新增 ${result.added} · 合并 ${result.merged} · 挂起 ${result.suspended}`
      );
    }
  };

  const handleCreate = async (): Promise<void> => {
    const values = await form.validateFields();
    await dispatch(
      createFieldInstrument({
        ledgerId: values.ledgerId?.trim() || null,
        stationCode: values.stationCode.trim(),
        type: values.type as InstrumentType,
        model: values.model.trim(),
        serialNo: values.serialNo.trim(),
        installDate: values.installDate,
        remark: values.remark?.trim() || '',
      })
    ).unwrap();
    message.success('现场登记已保存（待并入）');
    setModalOpen(false);
    form.resetFields();
  };

  const handleRemove = (row: FieldInstrument): void => {
    modal.confirm({
      title: '删除这条现场登记？',
      content: `临时单号 ${row.tempId}，删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => dispatch(removeFieldInstrument(row.id)),
    });
  };

  const fieldColumns: ColumnsType<FieldInstrument> = [
    {
      title: '临时单号',
      dataIndex: 'tempId',
      width: 140,
      render: (v: string) => <Text code>{v}</Text>,
    },
    { title: '所属台站', dataIndex: 'stationCode', width: 100 },
    { title: '类型', dataIndex: 'type', width: 100, render: (v: string) => <Tag>{v}</Tag> },
    { title: '型号', dataIndex: 'model', width: 140 },
    { title: '序列号', dataIndex: 'serialNo', width: 200, render: (v: string) => <Text code>{v}</Text> },
    { title: '安装日期', dataIndex: 'installDate', width: 120 },
    {
      title: '对应中心仪器',
      dataIndex: 'ledgerId',
      width: 140,
      render: (v: string | null) => (v ? <Text code>{v}</Text> : <Text type="secondary">新登记</Text>),
    },
    {
      title: '状态',
      dataIndex: 'mergeStatus',
      width: 100,
      render: (v: FieldMergeStatus) => <Tag color={STATUS_TAG[v].color}>{STATUS_TAG[v].text}</Tag>,
    },
    {
      title: '操作',
      width: 80,
      render: (_, row) =>
        row.mergeStatus === 'pending' ? (
          <Button type="link" danger size="small" onClick={() => handleRemove(row)}>
            删除
          </Button>
        ) : null,
    },
  ];

  const recordColumns: ColumnsType<MergeRecord> = [
    {
      title: '现场单号',
      dataIndex: 'fieldTempId',
      width: 140,
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: '种类',
      dataIndex: 'kind',
      width: 110,
      render: (v: MergeRecord['kind']) => <Tag color={KIND_TAG[v].color}>{KIND_TAG[v].text}</Tag>,
    },
    { title: '序列号', dataIndex: 'serialNo', width: 200, render: (v: string) => <Text code>{v}</Text> },
    {
      title: '采用侧重',
      dataIndex: 'strategy',
      width: 100,
      render: (v: MergeRecord['strategy']) => (
        <Tag color={v === 'field' ? 'geekblue' : 'purple'}>
          {v === 'field' ? '现场侧重' : '中心侧重'}
        </Tag>
      ),
    },
    {
      title: '重试',
      dataIndex: 'retried',
      width: 80,
      render: (v: boolean) => (v ? <Tag color="warning">已重试</Tag> : <Text type="secondary">—</Text>),
    },
    {
      title: '逐条核对',
      dataIndex: 'reviewed',
      width: 110,
      render: (_, row) => (
        <Checkbox
          checked={row.reviewed}
          onChange={() => dispatch(toggleMergeReviewed(row.id))}
        >
          已核对
        </Checkbox>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Title level={4} style={{ margin: 0 }}>
          现场对账合并
        </Title>
        <Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
          野外布设班在平板上离线登记的现场仪器（型号 / 序列号 / 安装日期 / 所属台站）并入台网中心台账对账。
          两边都改过的，现场字段按布设班那份写、历次标定与响应结论按标定室那份写，两版都留着让人逐条认；
          序列号撞号的先挂起不进台账；并入失败则保住中心台账上一版、按侧重试一遍。
        </Paragraph>
      </div>

      <Alert
        type="info"
        showIcon
        icon={<DiffOutlined />}
        message="对账规则"
        description={
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>现场字段（型号 / 序列号 / 安装日期 / 所属台站）：两边都改过时按布设班那份写。</li>
            <li>历次标定、响应结论与在用状态：按标定室那份写，合并时不动标定记录。</li>
            <li>现场报的序列号若和在册仪器撞号：这台先挂起，不进台账。</li>
            <li>并入失败：先保住中心台账上一版，再按中心侧重试一遍。</li>
          </ul>
        }
      />

      <Row gutter={16}>
        <Col xs={12} sm={8} md={6}>
          <StatBadge label="现场登记" value={fieldRows.length} suffix="条" tone="primary" />
        </Col>
        <Col xs={12} sm={8} md={6}>
          <StatBadge label="待处理" value={pendingCount} suffix="条" tone="warning" />
        </Col>
        <Col xs={12} sm={8} md={6}>
          <StatBadge label="已挂起" value={fieldRows.filter((r) => r.mergeStatus === 'suspended').length} suffix="条" tone="danger" />
        </Col>
        <Col xs={12} sm={8} md={6}>
          <StatBadge label="未核对留痕" value={unreviewedCount} suffix="条" tone="info" />
        </Col>
      </Row>

      <Card
        title="现场登记表（布设班离线录入）"
        extra={
          <Space>
            <Button icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
              新增现场登记
            </Button>
            <Button
              type="primary"
              icon={<CloudUploadOutlined />}
              loading={merging}
              onClick={handleMerge}
            >
              并入中心台账
            </Button>
          </Space>
        }
      >
        {sortedFieldRows.length === 0 ? (
          <EmptyPanel
            title="暂无现场登记"
            description="现场登记的仪器会显示在这里，可新增后并入中心台账。"
            actionText="新增现场登记"
            onAction={() => setModalOpen(true)}
          />
        ) : (
          <Table<FieldInstrument>
            rowKey="id"
            size="small"
            columns={fieldColumns}
            dataSource={sortedFieldRows}
            pagination={false}
            scroll={{ x: 1100 }}
          />
        )}
      </Card>

      {lastResult && lastResult.retried ? (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message="已按侧重试"
          description={
            <span>
              首次现场侧重并入失败：{lastResult.failureReason}
              。已保住中心台账上一版，按中心侧重试成功，争议字段按中心台账写入，现场版仍留痕待核对。
            </span>
          }
        />
      ) : null}

      <Card title="对账留痕（两版都留着，逐条认）">
        {sortedRecords.length === 0 ? (
          <EmptyPanel
            title="暂无对账留痕"
            description="并入中心台账后，每一条现场登记都会在这里留下现场版与中心版快照。"
          />
        ) : (
          <Table<MergeRecord>
            rowKey="id"
            size="small"
            columns={recordColumns}
            dataSource={sortedRecords}
            pagination={false}
            expandable={{
              expandedRowRender: (record) => <RecordDetail record={record} />,
            }}
          />
        )}
      </Card>

      <Modal
        title="新增现场登记"
        open={modalOpen}
        onOk={handleCreate}
        onCancel={() => {
          setModalOpen(false);
          form.resetFields();
        }}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item
            label="对应中心仪器 id（两边都改时填，新登记留空）"
            name="ledgerId"
          >
            <Input placeholder="如 ins_ltx02_bb，留空表示现场新登记" />
          </Form.Item>
          <Form.Item
            label="所属台站码"
            name="stationCode"
            rules={[{ required: true, message: '请输入台站码' }]}
          >
            <Input placeholder="如 LTX03" />
          </Form.Item>
          <Form.Item label="仪器类型" name="type" initialValue="宽频带">
            <Select options={INSTRUMENT_TYPES.map((t) => ({ value: t, label: t }))} />
          </Form.Item>
          <Form.Item
            label="型号"
            name="model"
            rules={[{ required: true, message: '请输入型号' }]}
          >
            <Input placeholder="如 CMG-3ESPC" />
          </Form.Item>
          <Form.Item
            label="序列号"
            name="serialNo"
            rules={[{ required: true, message: '请输入序列号' }]}
          >
            <Input placeholder="如 CMG-3E-20240501-09" />
          </Form.Item>
          <Form.Item
            label="安装日期"
            name="installDate"
            rules={[{ required: true, message: '请选择安装日期' }]}
          >
            <Input type="date" />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** 留痕详情：现场版 vs 中心版对照（两版都留着） */
function RecordDetail({ record }: { record: MergeRecord }) {
  const diffs = diffFields(record);
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {record.kind === 'suspended' ? (
        <Alert
          type="error"
          showIcon
          icon={<CloseCircleOutlined />}
          message="撞号挂起，不进台账"
          description={record.suspendReason}
        />
      ) : null}
      {record.retried && record.failureReason ? (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message="首次并入失败，已按中心侧重试"
          description={record.failureReason}
        />
      ) : null}
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Card size="small" title="现场版（布设班那份）" type="inner">
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="类型">{record.fieldSnapshot.type}</Descriptions.Item>
              <Descriptions.Item label="型号">{record.fieldSnapshot.model}</Descriptions.Item>
              <Descriptions.Item label="序列号">
                <Text code>{record.fieldSnapshot.serialNo}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="安装日期">{record.fieldSnapshot.installDate}</Descriptions.Item>
              <Descriptions.Item label="所属台站">{record.fieldSnapshot.stationCode}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            size="small"
            title={record.centerSnapshot ? '中心版（标定室那份）' : '中心版（无，新增）'}
            type="inner"
          >
            {record.centerSnapshot ? (
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="类型">{record.centerSnapshot.type}</Descriptions.Item>
                <Descriptions.Item label="型号">{record.centerSnapshot.model}</Descriptions.Item>
                <Descriptions.Item label="序列号">
                  <Text code>{record.centerSnapshot.serialNo}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="安装日期">{record.centerSnapshot.installDate}</Descriptions.Item>
                <Descriptions.Item label="在用状态">
                  <Tag color="green">{record.centerSnapshot.state}</Tag>
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Text type="secondary">现场新登记，中心此前无此仪器。</Text>
            )}
          </Card>
        </Col>
      </Row>
      {record.mergedSnapshot ? (
        <Card size="small" title="合并版（写入中心台账）" type="inner">
          <Space wrap>
            <Tag icon={<CheckCircleOutlined />} color="success">
              类型 {record.mergedSnapshot.type}
            </Tag>
            <Tag color="success">型号 {record.mergedSnapshot.model}</Tag>
            <Tag color="success">序列号 {record.mergedSnapshot.serialNo}</Tag>
            <Tag color="success">安装日期 {record.mergedSnapshot.installDate}</Tag>
            <Tag color="success">状态 {record.mergedSnapshot.state}</Tag>
          </Space>
        </Card>
      ) : null}
      {diffs.length > 0 ? (
        <Alert
          type="info"
          showIcon
          message="两版差异（逐条认）"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {diffs.map((d) => (
                <li key={d.label}>
                  {d.label}：现场版 <Text code>{d.field}</Text> → 中心版 <Text code>{d.center}</Text>
                  ，按{record.strategy === 'field' ? '现场' : '中心'}侧重写入
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
    </Space>
  );
}
