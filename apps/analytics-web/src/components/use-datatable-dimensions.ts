import { useEffect, useState } from 'react';
import { useProjectStore } from '../stores/project.store';
import {
  listDatatableDimensions,
  type DatatableDimensionProperty,
} from '../services/datatable.service';

/** 当前项目已生效的维度表属性（`{属性}@{字段}`），分析页分组/筛选下拉共用 */
export function useDatatableDimensions(): DatatableDimensionProperty[] {
  const project = useProjectStore((state) => state.currentProject);
  const [items, setItems] = useState<DatatableDimensionProperty[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!project) {
      setItems([]);
      return;
    }
    listDatatableDimensions()
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);
  return items;
}
