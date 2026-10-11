import { del, get, post, put } from './api';
import type {
  CardRefreshResult,
  CreateCardDto,
  CreateDashboardDto,
  DashboardDetail,
  DashboardShare,
  DashboardSummary,
  DashboardCard,
  SqlSchema,
  ExecuteSqlDto,
  SqlExecuteResult,
  SaveSqlReportDto,
  SqlReportSummary,
  SqlReportDetail,
} from '../types/report.types';

/** 看板列表 */
export function getDashboards() {
  return get<DashboardSummary[]>('/report/dashboards');
}

/** 看板详情（含卡片） */
export function getDashboard(id: string) {
  return get<DashboardDetail>(`/report/dashboards/${id}`);
}

/** 创建看板 */
export function createDashboard(dto: CreateDashboardDto) {
  return post<DashboardSummary>('/report/dashboards', dto);
}

/** 更新看板 */
export function updateDashboard(id: string, dto: Partial<CreateDashboardDto>) {
  return put<DashboardSummary>(`/report/dashboards/${id}`, dto);
}

/** 删除看板 */
export function deleteDashboard(id: string) {
  return del<{ deleted: number }>(`/report/dashboards/${id}`);
}

/** 只读分享详情 */
export function getShareDashboard(token: string) {
  return get<DashboardShare>(`/report/dashboards/share/${token}`);
}

// ---------- 全局分析卡片（卡片库，一等资产） ----------

/** 卡片库列表（可按 type 过滤：event/funnel/retention/sql） */
export function listCards(type?: string) {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  return get<import('../types/report.types').AnalysisCard[]>(`/report/cards${qs}`);
}

/** 创建全局卡片 */
export function createCard(dto: CreateCardDto) {
  return post<import('../types/report.types').AnalysisCard>('/report/cards', dto);
}

/** 卡片详情（跳转分析页还原查询条件用） */
export function getCard(cardId: string) {
  return get<import('../types/report.types').AnalysisCard>(`/report/cards/${cardId}`);
}

/** 删除全局卡片（从所有看板级联移除引用） */
export function deleteCard(cardId: string) {
  return del<{ deleted: number }>(`/report/cards/${cardId}`);
}

// ---------- 看板-卡片关联 ----------

/** 看板卡片列表（卡片内容 + 布局） */
export function getCards(dbId: string) {
  return get<DashboardCard[]>(`/report/dashboards/${dbId}/cards`);
}

/** 添加已有卡片到看板 */
export function addCardToDashboard(
  dbId: string,
  dto: import('../types/report.types').AddCardToDashboardDto,
) {
  return post<import('../types/report.types').AnalysisCard>(`/report/dashboards/${dbId}/cards`, dto);
}

/** 更新看板内卡片布局 */
export function updateCardLayout(
  dbId: string,
  cardId: string,
  dto: Partial<Omit<import('../types/report.types').AddCardToDashboardDto, 'card_id'>>,
) {
  return put<{ ok: boolean }>(`/report/dashboards/${dbId}/cards/${cardId}`, dto);
}

/** 从看板移除卡片（仅删关联，不删卡片） */
export function removeCardFromDashboard(dbId: string, cardId: string) {
  return del<{ ok: boolean }>(`/report/dashboards/${dbId}/cards/${cardId}`);
}

/** 调整卡片顺序 */
export function reorderCards(dbId: string, cardIds: string[]) {
  return post<{ ok: boolean }>(`/report/dashboards/${dbId}/cards/reorder`, { card_ids: cardIds });
}

/** 实时刷新卡片指标 */
export function refreshCard(dbId: string, cardId: string) {
  return post<CardRefreshResult>(`/report/dashboards/${dbId}/cards/${cardId}/refresh`);
}

/** 看板位置级展示样式 */
export function updateCardDisplay(dbId: string, cardId: string, display: { view: string }) {
  return put<{ ok: boolean; display: { view: string } }>(
    `/report/dashboards/${dbId}/cards/${cardId}/display`,
    display,
  );
}

// ---------- 自定义 SQL 分析 ----------

/** 元数据字典 */
export function getSqlSchema() {
  return get<SqlSchema>('/report/schema');
}

/** 执行 SQL */
export function executeSql(dto: ExecuteSqlDto) {
  // SQL 执行走 ClickHouse 300s 墙钟，前端超时略长，避免服务端仍在跑而前端先断
  return post<SqlExecuteResult>('/report/sql/execute', dto, { timeout: 310_000 });
}

/** 保存报表 */
export function saveSqlReport(dto: SaveSqlReportDto) {
  return post<SqlReportSummary>('/report/sql/save', dto);
}

/** 覆盖已有 SQL 卡片 */
export function updateSqlReport(id: string, dto: SaveSqlReportDto) {
  return put<SqlReportDetail>(`/report/sql/${id}`, dto);
}

/** 更新全局卡片（名称 / DSL） */
export function updateCard(cardId: string, dto: Partial<CreateCardDto>) {
  return put<import('../types/report.types').AnalysisCard>(`/report/cards/${cardId}`, dto);
}

/** 批量保存看板网格 */
export function saveDashboardLayout(
  dbId: string,
  items: Array<{ card_id: string; position_x: number; position_y: number; width: number; height: number }>,
) {
  return put<{ ok: boolean }>(`/report/dashboards/${dbId}/layout`, { items });
}

/** 已保存报表列表 */
export function getSqlReports() {
  return get<SqlReportSummary[]>('/report/sql');
}

/** 报表详情 */
export function getSqlReport(id: string) {
  return get<SqlReportDetail>(`/report/sql/${id}`);
}

/** 删除报表 */
export function deleteSqlReport(id: string) {
  return del<{ deleted: number }>(`/report/sql/${id}`);
}
