import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Spin } from 'antd';
import { debounce } from 'lodash-es';
import type { SelectProps } from 'antd';
import { SELECT_POPUP } from './select-popup';
import { useT } from '../i18n';
import { getEvents, getVirtualEvents } from '../services/meta.service';
import { useProjectStore } from '../stores/project.store';
import type { MetaEvent, MetaVirtualEvent } from '../types/meta.types';
import { ANY_EVENT } from '../types/dsl.types';
import { mergeAnalysisEventOptions } from './event-select-options';

export interface EventOption {
  label: string;
  value: string;
}

const PAGE_SIZE = 100;

export function eventToOption(event: MetaEvent): EventOption {
  return {
    value: event.event_key,
    label: event.display_name ? `${event.display_name} (${event.event_key})` : event.event_key,
  };
}

export function eventsForAnalysisPicker(items: MetaEvent[]): EventOption[] {
  return items.filter((item) => item.status !== 'hidden').map(eventToOption);
}

interface EventSelectProps {
  value?: string;
  onChange?: (eventKey: string) => void;
  placeholder?: string;
  style?: SelectProps['style'];
  allowClear?: boolean;
  showAnyEvent?: boolean;
}

export function EventSelect({
  value,
  onChange,
  placeholder,
  style,
  allowClear,
  showAnyEvent,
}: EventSelectProps) {
  const { t } = useT();
  const project = useProjectStore((state) => state.currentProject);
  const [options, setOptions] = useState<EventOption[]>([]);
  const [loading, setLoading] = useState(false);
  const kept = useRef<Map<string, EventOption>>(new Map());
  const virtuals = useRef<MetaVirtualEvent[]>([]);
  const keywordRef = useRef('');
  const valueRef = useRef(value);
  valueRef.current = value;

  const applyItems = (items: MetaEvent[], keepValue?: string, keyword?: string) => {
    const reported = eventsForAnalysisPicker(items);
    const next = mergeAnalysisEventOptions(reported, virtuals.current, keyword, t);
    next.forEach((option) => kept.current.set(option.value, option));
    if (keepValue && kept.current.has(keepValue) && !next.some((option) => option.value === keepValue)) {
      setOptions([kept.current.get(keepValue) as EventOption, ...next]);
      return;
    }
    setOptions(next);
  };

  const load = async (keyword?: string) => {
    const keepValue = valueRef.current;
    keywordRef.current = keyword?.trim() || '';
    setLoading(true);
    try {
      const [res, veRes] = await Promise.all([
        getEvents({
          keyword: keywordRef.current || undefined,
          pageSize: PAGE_SIZE,
          exclude_hidden: true,
          sort_by: 'recent_7d_count',
          sort_order: 'desc',
        }),
        getVirtualEvents().catch(() => ({ items: [] as MetaVirtualEvent[] })),
      ]);
      virtuals.current = veRes.items ?? [];
      applyItems(res.items, keepValue, keywordRef.current);
    } catch {
      const fallback = mergeAnalysisEventOptions([], virtuals.current, keywordRef.current, t);
      if (keepValue && kept.current.has(keepValue)) {
        setOptions([kept.current.get(keepValue) as EventOption, ...fallback.filter((o) => o.value !== keepValue)]);
      } else {
        setOptions(fallback);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    virtuals.current = [];
    void loadRef.current();
  }, [project]);

  useEffect(() => {
    if (!value || options.some((option) => option.value === value) || kept.current.has(value)) return;
    void getEvents({ keyword: value, pageSize: 5, exclude_hidden: true })
      .then((res) => applyItems([...res.items], value, keywordRef.current))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const onSearch = useMemo(
    () =>
      debounce((keyword: string) => {
        void loadRef.current(keyword);
      }, 300),
    [],
  );

  useEffect(() => () => onSearch.cancel(), [onSearch]);

  return (
    <Select
      {...SELECT_POPUP}
      showSearch
      allowClear={allowClear}
      filterOption={false}
      value={value || undefined}
      onChange={(eventKey) => onChange?.(eventKey)}
      onSearch={onSearch}
      onClear={() => void load()}
      options={
        showAnyEvent
          ? [{ label: t('common:eventSelect.anyEvent'), value: ANY_EVENT }, ...options.filter((o) => o.value !== ANY_EVENT)]
          : options
      }
      loading={loading}
      placeholder={placeholder ?? t('common:eventSelect.searchPlaceholder')}
      style={style}
      notFoundContent={loading ? <Spin size="small" /> : t('common:eventSelect.noMatch')}
    />
  );
}
