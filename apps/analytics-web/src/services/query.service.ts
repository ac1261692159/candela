import { post } from './api';

/** 与 ClickHouse max_execution_time(300s) 对齐：查询请求前端超时略长于服务端，让真实错误先冒出来 */
const QUERY_TIMEOUT_MS = 310_000;
import type {
  EventAnalysisQuery,
  FunnelQuery,
  RetentionQuery,
  QueryResult,
} from '../types/dsl.types';

export function analyzeEvent(query: EventAnalysisQuery) {
  return post<QueryResult>('/query/event', query, { timeout: QUERY_TIMEOUT_MS });
}

export function analyzeFunnel(query: FunnelQuery) {
  return post<QueryResult>('/query/funnel', query, { timeout: QUERY_TIMEOUT_MS });
}

export function analyzeRetention(query: RetentionQuery) {
  return post<QueryResult>('/query/retention', query, { timeout: QUERY_TIMEOUT_MS });
}
