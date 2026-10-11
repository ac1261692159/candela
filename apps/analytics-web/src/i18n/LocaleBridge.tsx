/**
 * 壳层语言联动：把当前语言同步给 antd 组件库、dayjs 与 <html lang>。
 *
 * 切换语言时 useTranslation 会触发本组件重渲染（订阅 languageChanged），
 * 因此 antd 的日期选择器 / 分页 / 空态等内置文案随语言变化。
 */
import { useEffect, type ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import enUS from 'antd/locale/en_US';
import zhTW from 'antd/locale/zh_TW';
import jaJP from 'antd/locale/ja_JP';
import koKR from 'antd/locale/ko_KR';
import ruRU from 'antd/locale/ru_RU';
import frFR from 'antd/locale/fr_FR';
import deDE from 'antd/locale/de_DE';
import esES from 'antd/locale/es_ES';
import ptBR from 'antd/locale/pt_BR';
import viVN from 'antd/locale/vi_VN';
import thTH from 'antd/locale/th_TH';
import idID from 'antd/locale/id_ID';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/zh-tw';
import 'dayjs/locale/ja';
import 'dayjs/locale/ko';
import 'dayjs/locale/ru';
import 'dayjs/locale/fr';
import 'dayjs/locale/de';
import 'dayjs/locale/es';
import 'dayjs/locale/pt-br';
import 'dayjs/locale/vi';
import 'dayjs/locale/th';
import 'dayjs/locale/id';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LOCALE, localeDef, resolveLocale, type LocaleDef } from './config';

const ANTD_LOCALES: Record<LocaleDef['antd'], typeof zhCN> = {
  zh_CN: zhCN,
  en_US: enUS,
  zh_TW: zhTW,
  ja_JP: jaJP,
  ko_KR: koKR,
  ru_RU: ruRU,
  fr_FR: frFR,
  de_DE: deDE,
  es_ES: esES,
  pt_BR: ptBR,
  vi_VN: viVN,
  th_TH: thTH,
  id_ID: idID,
};

export function LocaleBridge({ children }: { children: ReactNode }) {
  const { i18n, t } = useTranslation();
  const tag = resolveLocale(i18n.language) ?? DEFAULT_LOCALE;
  const def = localeDef(tag);

  useEffect(() => {
    dayjs.locale(def.dayjs);
    document.documentElement.lang = def.intl;
    document.title = t('shell:document.title');
  }, [def, t]);

  return <ConfigProvider locale={ANTD_LOCALES[def.antd]}>{children}</ConfigProvider>;
}
