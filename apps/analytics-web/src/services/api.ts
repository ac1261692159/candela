import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { message } from 'antd';
import { useProjectStore } from '../stores/project.store';
import { useAuthStore } from '../stores/auth.store';
import type { ApiResponse } from '../types/dsl.types';
import { API_ERROR_TOAST_KEY, toUserFacingApiError } from './api-error';
import { isSessionExpired401, redirectToAnalyticsLogin } from './login-path';
import { currentLocale } from '../i18n';

export type ApiRequestConfig = AxiosRequestConfig & { silent?: boolean };

function notifyApiError(content: string) {
  message.error({ content, key: API_ERROR_TOAST_KEY, duration: 5 });
}

function isSilent(config?: AxiosRequestConfig): boolean {
  return Boolean((config as ApiRequestConfig | undefined)?.silent);
}

function isCanceled(error: AxiosError): boolean {
  return error.code === 'ERR_CANCELED' || axios.isCancel(error);
}

const api: AxiosInstance = axios.create({
  baseURL: '/sa/api',
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  const project = useProjectStore.getState().currentProject || 'clklogapp';
  // 显式带头的调用（如建号顺带入会到非当前项目）优先，否则跟随当前项目（v3.1）
  if (config.headers['x-project-name'] === undefined) {
    config.headers['x-project-name'] = project;
  }
  // 让服务端按**用户选的语言**渲染服务端产出内容（通知模板预览、导出表头等），
  // 而不是浏览器语言——浏览器 Accept-Language 与平台内选择可能不一致。
  config.headers['x-locale'] = currentLocale();
  if (!config.params) {
    config.params = { project };
  } else if (
    typeof config.params === 'object' &&
    !Array.isArray(config.params) &&
    !(config.params instanceof URLSearchParams) &&
    (config.params as { project?: unknown }).project == null
  ) {
    config.params = { ...config.params, project };
  }
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response: AxiosResponse<ApiResponse<unknown>>) => {
    const { code, message: msg, data, messageKey, params, errorCode } = response.data as ApiResponse<unknown> & {
      messageKey?: string;
      errorCode?: string;
      params?: Record<string, unknown>;
    };
    if (code !== 0) {
      const friendly = toUserFacingApiError({
        message: msg,
        httpStatus: response.status,
        messageKey,
        params,
      });
      if (!isSilent(response.config)) notifyApiError(friendly);
      return Promise.reject(withErrorMeta(new Error(friendly), errorCode, messageKey));
    }
    return { ...response, data } as AxiosResponse<unknown>;
  },
  (error: AxiosError<ApiResponse<unknown>>) => {
    if (isCanceled(error) || isSilent(error.config)) {
      return Promise.reject(error);
    }
    // 只有带着登录态的 401 才算会话过期；登录接口自身的 401（凭据错 / 账号锁定 / 已禁用）
    // 必须落到下面的正常错误分支去提示，否则登录页「点了没反应」（2026-09-20 实测）
    if (isSessionExpired401(error)) {
      useAuthStore.getState().clearAuth();
      redirectToAnalyticsLogin();
      return Promise.reject(error);
    }
    const data = error.response?.data as
      | {
          message?: string | string[];
          messageKey?: string;
          errorCode?: string;
          params?: Record<string, unknown>;
        }
      | string
      | undefined;
    const rawMessage =
      (typeof data === 'string' && data.trim()) ||
      (data && typeof data === 'object' ? data.message : undefined) ||
      error.message;
    const friendly = toUserFacingApiError({
      message: rawMessage,
      httpStatus: error.response?.status,
      code: error.code,
      messageKey: data && typeof data === 'object' ? data.messageKey : undefined,
      params: data && typeof data === 'object' ? data.params : undefined,
    });
    notifyApiError(friendly);
    return Promise.reject(
      withErrorMeta(new Error(friendly), data && typeof data === 'object' ? data.errorCode : undefined, data && typeof data === 'object' ? data.messageKey : undefined),
    );
  },
);

/**
 * 把后端的机器码挂到错误对象上：调用方需要「按错误码判断分支」时用它，
 * 比按中文文案子串匹配稳（文案会本地化，机器码不会）。
 */
export interface ApiErrorMeta extends Error {
  errorCode?: string;
  messageKey?: string;
}

export function withErrorMeta(error: Error, errorCode?: string, messageKey?: string): ApiErrorMeta {
  const meta = error as ApiErrorMeta;
  if (errorCode) meta.errorCode = errorCode;
  if (messageKey) meta.messageKey = messageKey;
  return meta;
}

export async function get<T>(url: string, config?: ApiRequestConfig): Promise<T> {
  const res = await api.get<ApiResponse<T>>(url, config);
  return res.data as T;
}

export async function post<T>(url: string, data?: unknown, config?: ApiRequestConfig): Promise<T> {
  const res = await api.post<ApiResponse<T>>(url, data, config);
  return res.data as T;
}

export async function put<T>(url: string, data?: unknown, config?: ApiRequestConfig): Promise<T> {
  const res = await api.put<ApiResponse<T>>(url, data, config);
  return res.data as T;
}

export async function patch<T>(url: string, data?: unknown, config?: ApiRequestConfig): Promise<T> {
  const res = await api.patch<ApiResponse<T>>(url, data, config);
  return res.data as T;
}

export async function del<T>(url: string, config?: ApiRequestConfig): Promise<T> {
  const res = await api.delete<ApiResponse<T>>(url, config);
  return res.data as T;
}

export default api;
