import { Module } from '@nestjs/common';
import { SharedModule } from '../shared/shared.module';
import { QueryModule } from '../query/query.module';
import { SubjectModule } from '../subject/subject.module';
import { IamModule } from '../iam/iam.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DashboardRepository } from './dashboard.repository';
import { GlobalCardController, CardLinkController } from './card.controller';
import { CardService } from './card.service';
import { CardRepository } from './card.repository';
import { SqlReportController } from './sql-report.controller';
import { SqlReportService } from './sql-report.service';
import { SchemaService } from './schema.service';
import { SqlAstGuardService } from './sql-ast-guard.service';
import { CatalogController } from './catalog.controller';
import { CardCacheWorker } from './card-cache.worker';
import { FolderController } from './folder.controller';
import { FolderService } from './folder.service';

@Module({
  imports: [SharedModule, QueryModule, SubjectModule, IamModule],
  controllers: [
    DashboardController,
    FolderController,
    GlobalCardController,
    CardLinkController,
    SqlReportController,
    CatalogController,
  ],
  providers: [
    DashboardService,
    DashboardRepository,
    FolderService,
    CardService,
    CardRepository,
    SqlReportService,
    SchemaService,
    SqlAstGuardService,
    CardCacheWorker,
  ],
  exports: [SqlAstGuardService],
})
export class ReportModule {}
