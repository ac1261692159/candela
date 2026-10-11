import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { DatatableController } from './datatable.controller';
import { DatatableImportService } from './datatable-import.service';
import { DatatableLease } from './datatable-lease';
import { DatatableMapService } from './datatable-map.service';
import { DatatableRowsService } from './datatable-rows.service';
import { DatatableService } from './datatable.service';

/**
 * 数据表（维度表）模块。phase: `clklog-analytics-datatable-v1`。
 * 语义边界：元数据 + 行存储 + 绑定；查询侧（结果映射、跨表维度）由 query 模块消费。
 */
@Module({
  imports: [SharedModule],
  controllers: [DatatableController],
  providers: [
    DatatableService,
    DatatableImportService,
    DatatableLease,
    DatatableRowsService,
    DatatableMapService,
  ],
  exports: [DatatableService, DatatableRowsService, DatatableMapService],
})
export class DatatableModule {}
