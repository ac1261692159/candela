import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { nanoid } from 'nanoid';
import { badRequest, conflict, notFound } from '../../i18n/domain-error';
import { PrismaService } from '../shared/prisma.service';
import { DatatableRowsService } from './datatable-rows.service';
import { DatatableLease, RETAIN_MS } from './datatable-lease';
import { DatatableMapService } from './datatable-map.service';
import {
  DATATABLE_LIMITS,
  DatatableCsvError,
  assertHeaderMatches,
  mergeSnapshot,
  parseCsvText,
  parseDatatableCsv,
  type ParsedCsv,
} from './datatable-csv';
import type { CreateDatatableDto, ParseDatatableDto, UpdateDatatableDto } from './dto/datatable.dto';

const TABLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

interface AuditInput {
  project: string;
  datatableId: string;
  mode: string;
  fromVersion: number | null;
  toVersion: number | null;
  parsed: ParsedCsv | null;
  result: 'success' | 'failed';
  operator: string;
  error?: string | null;
}

/**
 * 数据表写入协议（架构 §9）：租约 → 写 pending → CAS 发布 → 审计 → 延后清理。
 * 发布成功后禁止删除生效版本（DT-03）；旧版本保留 RETAIN_MS 再删（DT-14）。
 */
@Injectable()
export class DatatableImportService implements OnModuleInit {
  private readonly logger = new Logger(DatatableImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rows: DatatableRowsService,
    private readonly lease: DatatableLease,
    private readonly maps: DatatableMapService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const expired = await this.lease.recoverExpired();
      for (const item of expired) {
        await this.rows.dropVersion(item.project_name, item.id, item.pending_version).catch((err) => {
          this.logger.warn(`清理过期 pending 失败 ${item.id}@${item.pending_version}: ${(err as Error).message}`);
        });
      }
      if (expired.length) this.logger.log(`启动恢复：丢弃 ${expired.length} 个未发布 pending 版本`);
    } catch (err) {
      this.logger.warn(`启动租约恢复跳过：${(err as Error).message}`);
    }
  }

  async create(project: string, user: string, dto: CreateDatatableDto) {
    if (!TABLE_KEY_PATTERN.test(dto.table_key)) {
      throw badRequest({
        code: 'datatable.table.keyInvalid',
        messageKey: 'datatable:error.table.keyInvalid',
        message: '数据表名称只能以小写字母开头，包含小写字母、数字、下划线，最长 50 个字符',
      });
    }
    const existed = await this.prisma.metaDatatable.findFirst({
      where: { project_name: project, table_key: dto.table_key },
    });
    if (existed && existed.status !== 'deleted') {
      throw conflict({
        code: 'datatable.table.nameExists',
        messageKey: 'datatable:error.table.nameExists',
        message: '项目内已存在同名数据表',
      });
    }

    const parsed = parseOrThrow(dto);
    await this.rows.ensureTable();

    const id = existed ? existed.id : `dt_${nanoid(10)}`;
    if (existed) {
      await this.rows.dropAll(project, id).catch(() => undefined);
      await this.prisma.metaDatatableColumn.deleteMany({ where: { datatable_id: id } });
      await this.prisma.metaDatatable.update({
        where: { id },
        data: {
          remark: dto.remark ?? null,
          column_count: parsed.columns.length,
          status: 'active',
          row_count: 0,
          version_seq: 0,
          active_version: 0,
          pending_version: null,
          import_owner: null,
          lease_until: null,
          updated_by: user,
        },
      });
    } else {
      await this.prisma.metaDatatable.create({
        data: {
          id,
          project_name: project,
          table_key: dto.table_key,
          remark: dto.remark ?? null,
          column_count: parsed.columns.length,
          created_by: user,
          updated_by: user,
        },
      });
    }
    await this.prisma.metaDatatableColumn.createMany({
      data: parsed.columns.map((column) => ({
        id: `dtc_${nanoid(10)}`,
        datatable_id: id,
        field_key: column.field_key,
        data_type: column.data_type,
        display_name: column.display_name,
        is_primary: column.is_primary,
        sort_order: column.sort_order,
      })),
    });

    try {
      await this.writeAndPublish({
        project,
        user,
        id,
        mode: 'create',
        parsed,
        mergeFrom: parsed.rows,
        fromVersion: 0,
      });
      return id;
    } catch (err) {
      const table = await this.prisma.metaDatatable.findFirst({ where: { id } });
      if (!table || table.active_version < 1) {
        await this.rows.dropAll(project, id).catch(() => undefined);
        await this.prisma.metaDatatableColumn.deleteMany({ where: { datatable_id: id } });
        await this.prisma.metaDatatable.delete({ where: { id } }).catch(() => undefined);
      }
      throw err;
    }
  }

  async update(project: string, user: string, id: string, dto: UpdateDatatableDto) {
    const table = await this.requireTable(project, id);
    const saved = await this.prisma.metaDatatableColumn.findMany({
      where: { datatable_id: id },
      orderBy: { sort_order: 'asc' },
    });
    if (saved.length === 0) {
      throw badRequest({
        code: 'datatable.table.noFields',
        messageKey: 'datatable:error.table.noFields',
        message: '数据表没有字段，无法更新',
      });
    }
    const header = (parseCsvText(dto.csv_text)[0] ?? []).map((cell) => cell.trim());
    assertHeaderMatches(header, saved);
    const parsed = parseOrThrow({
      ...dto,
      columns: saved.map((column) => ({
        field_key: column.field_key,
        data_type: column.data_type as 'number' | 'string' | 'datetime' | 'boolean',
        display_name: column.display_name ?? undefined,
      })),
    });

    const fromVersion = table.active_version;
    const prior =
      dto.mode === 'incr' ? await this.rows.readSnapshot(project, id, fromVersion) : new Map<string, string>();
    const merged = mergeSnapshot(prior, parsed.rows, dto.mode);
    if (merged.size > DATATABLE_LIMITS.maxRows) {
      throw badRequest({
        code: 'datatable.table.rowLimitExceeded',
        messageKey: 'datatable:error.table.rowLimitExceeded',
        params: { limit: DATATABLE_LIMITS.maxRows, rows: merged.size },
        message: `单表最多 ${DATATABLE_LIMITS.maxRows} 行，本次更新后为 ${merged.size} 行，请拆分或精简`,
      });
    }

    let added = 0;
    let updated = 0;
    for (const pk of parsed.rows.keys()) {
      if (prior.has(pk)) updated += 1;
      else added += 1;
    }

    await this.writeAndPublish({
      project,
      user,
      id,
      mode: dto.mode,
      parsed,
      mergeFrom: merged,
      fromVersion,
    });
    return {
      added,
      updated,
      dropped: parsed.droppedRows,
      dropped_detail: parsed.dropped,
      duplicated_keys: parsed.duplicatedKeys,
    };
  }

  async clear(project: string, user: string, id: string) {
    const table = await this.requireTable(project, id);
    await this.writeAndPublish({
      project,
      user,
      id,
      mode: 'clear',
      parsed: null,
      mergeFrom: new Map(),
      fromVersion: table.active_version,
    });
  }

  async remove(project: string, user: string, id: string) {
    const table = await this.requireTable(project, id);
    const owner = `${user}:${nanoid(6)}`;
    const pending = await this.lease.acquire(id, project, owner);
    if (pending == null) {
      throw conflict({
        code: 'datatable.table.busy',
        messageKey: 'datatable:error.table.busy',
        message: '该数据表正在更新中，请稍后再试',
      });
    }
    try {
      await this.prisma.metaDatatableBinding.updateMany({
        where: { datatable_id: id },
        data: { status: 'invalid' },
      });
      await this.prisma.metaDatatable.update({
        where: { id },
        data: {
          status: 'deleted',
          row_count: 0,
          pending_version: null,
          import_owner: null,
          lease_until: null,
          updated_by: user,
        },
      });
      await this.auditSafe({
        project,
        datatableId: id,
        mode: 'delete',
        fromVersion: table.active_version,
        toVersion: null,
        parsed: null,
        result: 'success',
        operator: user,
      });
      this.scheduleDrop(() => this.rows.dropAll(project, id), RETAIN_MS);
      await this.afterPublish(project);
      return { id, status: 'deleted' as const, invalidated_bindings: true };
    } catch (err) {
      await this.lease.release(id, owner).catch(() => undefined);
      throw err;
    }
  }

  private async writeAndPublish(input: {
    project: string;
    user: string;
    id: string;
    mode: string;
    parsed: ParsedCsv | null;
    mergeFrom: Map<string, string>;
    fromVersion: number;
  }): Promise<{ active_version: number; row_count: number }> {
    const owner = `${input.user}:${nanoid(6)}`;
    const pending = await this.lease.acquire(input.id, input.project, owner);
    if (pending == null) {
      throw conflict({
        code: 'datatable.table.busy',
        messageKey: 'datatable:error.table.busy',
        message: '该数据表正在更新中，请稍后再试',
      });
    }
    const batchId = `dti_${nanoid(10)}`;
    const snapshot = input.mergeFrom;
    try {
      await this.rows.writeVersion(input.project, input.id, pending, batchId, snapshot);
      await this.lease.heartbeat(input.id, owner);
      const published = await this.lease.publish(
        input.id,
        owner,
        pending,
        snapshot.size,
        input.user,
      );
      if (!published) {
        await this.rows.dropVersion(input.project, input.id, pending).catch(() => undefined);
        await this.lease.release(input.id, owner).catch(() => undefined);
        throw conflict({
          code: 'datatable.table.busy',
          messageKey: 'datatable:error.table.busy',
          message: '该数据表正在更新中，请稍后再试',
        });
      }
    } catch (err) {
      // 租约冲突（409）不清理他人 pending：ConflictException / DomainError(409) 一视同仁
      if (err instanceof HttpException && err.getStatus() === HttpStatus.CONFLICT) throw err;
      await this.rows.dropVersion(input.project, input.id, pending).catch(() => undefined);
      await this.lease.release(input.id, owner).catch(() => undefined);
      await this.auditSafe({
        project: input.project,
        datatableId: input.id,
        mode: input.mode,
        fromVersion: input.fromVersion,
        toVersion: pending,
        parsed: input.parsed,
        result: 'failed',
        operator: input.user,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    await this.auditSafe({
      project: input.project,
      datatableId: input.id,
      mode: input.mode,
      fromVersion: input.fromVersion || null,
      toVersion: pending,
      parsed: input.parsed,
      result: 'success',
      operator: input.user,
    });
    this.scheduleRetainDrop(input.project, input.id, pending);
    await this.afterPublish(input.project);
    return { active_version: pending, row_count: snapshot.size };
  }

  /** 审计失败不得回滚已发布版本（DT-03） */
  private async auditSafe(input: AuditInput): Promise<void> {
    try {
      await this.prisma.metaDatatableImport.create({
        data: {
          id: `dti_${nanoid(10)}`,
          datatable_id: input.datatableId,
          project_name: input.project,
          mode: input.mode,
          from_version: input.fromVersion,
          to_version: input.toVersion,
          total_rows: input.parsed ? input.parsed.successRows + input.parsed.droppedRows : 0,
          success_rows: input.parsed?.successRows ?? 0,
          dropped_rows: input.parsed?.droppedRows ?? 0,
          dropped_json: input.parsed ? JSON.stringify(input.parsed.dropped) : null,
          result: input.result,
          error: input.error ?? null,
          operator: input.operator,
        },
      });
    } catch (err) {
      this.logger.error(`写入审计失败（数据已按 ${input.result} 处理，不回滚）：${(err as Error).message}`);
    }
  }

  private scheduleRetainDrop(project: string, id: string, publishedVersion: number): void {
    this.scheduleDrop(async () => {
      const table = await this.prisma.metaDatatable.findFirst({ where: { id, project_name: project } });
      if (!table || table.active_version !== publishedVersion) return;
      await this.rows.dropOtherVersions(project, id, publishedVersion);
    }, RETAIN_MS);
  }

  private scheduleDrop(task: () => Promise<void>, delayMs: number): void {
    setTimeout(() => {
      void task().catch((err) => this.logger.warn(`延后清理失败：${(err as Error).message}`));
    }, delayMs).unref?.();
  }

  async touchProject(project: string): Promise<void> {
    await this.afterPublish(project);
  }

  private async afterPublish(project: string): Promise<void> {
    this.maps.invalidateProject(project);
    const cards = await this.prisma.card.findMany({
      where: { project_name: project, type: { in: ['event', 'funnel', 'retention'] } },
      select: { card_id: true },
    });
    if (cards.length === 0) return;
    await this.prisma.cardCache.updateMany({
      where: { card_id: { in: cards.map((card) => card.card_id) } },
      data: { refreshed_at: new Date(0) },
    });
  }

  private async requireTable(project: string, id: string) {
    const table = await this.prisma.metaDatatable.findFirst({
      where: { id, project_name: project, status: { not: 'deleted' } },
    });
    if (!table) {
      throw notFound({
        code: 'datatable.table.notFound',
        messageKey: 'datatable:error.table.notFound',
        message: '数据表不存在',
      });
    }
    return table;
  }
}

function parseOrThrow(dto: ParseDatatableDto): ParsedCsv {
  try {
    return parseDatatableCsv(dto.csv_text, { columns: dto.columns });
  } catch (err) {
    if (err instanceof DatatableCsvError) throw new BadRequestException(err.message);
    throw err;
  }
}
