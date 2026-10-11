import { Body, Controller, Post } from '@nestjs/common';
import { badRequest } from '../../i18n/domain-error';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { CurrentProject } from '../../common/decorators/project.decorator';
import { RequirePermission } from '../iam/require-permission';
import { MetricEvalService } from './metric-eval.service';
import { formatMetricValue } from './metric-value-pick';

class PreviewMetricDto {
  @IsOptional()
  @IsIn(['event'])
  kind?: 'event';

  @IsObject()
  definition_json!: Record<string, unknown>;

  @IsOptional()
  @IsIn(['number', 'percent'])
  format?: 'number' | 'percent';

  /** 未设查询时间时用于试算的兜底窗口（默认 7 天） */
  @IsOptional()
  fallback_window_days?: number;

  @IsOptional()
  @IsString()
  remark?: string;
}

/**
 * 指标试算（phase: clklog-analytics-metric-v2）。
 *
 * 放在查询模块而不是 meta 模块：试算就是「按定义跑一次事件分析」，
 * 而 QueryModule 已经依赖 MetaModule（反向会成环）。路径仍挂在指标下，前端不必关心归属。
 *
 * 与告警求值共用 `MetricEvalService`，因此「编辑器里看到的数」与「告警判断的数」必然一致。
 */
@Controller('sa/api/meta/metrics')
export class MetricEvalController {
  constructor(private readonly metrics: MetricEvalService) {}

  @Post('preview')
  @RequirePermission('metric.view')
  async preview(@CurrentProject() project: string, @Body() body: PreviewMetricDto) {
    if (!body?.definition_json || typeof body.definition_json !== 'object') {
      throw badRequest({
        code: 'analysis.metricEval.definitionNotObject',
        messageKey: 'analysis:error.metricEval.definitionNotObject',
        message: 'definition_json 必须是对象',
      });
    }
    const outcome = await this.metrics.evaluateEvent({
      project,
      definition: body.definition_json,
      kind: body.kind ?? 'event',
      fallbackWindowDays: body.fallback_window_days,
      withSeries: true,
      refresh: true,
    });
    return {
      value: outcome.value,
      value_fmt: outcome.value === null ? '—' : formatMetricValue(outcome.value, '', body.format),
      series: outcome.series,
      pick: outcome.pick,
      pick_label: outcome.pick_label,
      pick_note: outcome.pick_note,
      pick_explicit: outcome.pick_explicit,
      used_overall: outcome.used_overall,
      // 窗口：中文 `label` 原值保留（老客户端兜底），另给**结构**——
      // 界面按查看者语言用 `metricWindowPayloadLabel` 渲染（i18n 收口）。
      // `relative` 只在指标自带查询时间（source=metric）时下发：其余路径的中文是短形态「近 N 天」，
      // 前端按天数生成同一形态；结构里不含任何语言的文案。
      window: {
        start: outcome.window.start,
        end: outcome.window.end,
        days: outcome.window.days,
        label: outcome.window.label,
        source: outcome.window.source,
        relative: outcome.window.source === 'metric' ? outcome.window.range.relative ?? null : null,
      },
      elapsed_ms: outcome.elapsed_ms,
    };
  }
}
