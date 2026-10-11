import { Injectable } from '@nestjs/common';
import { badRequest, DomainError } from '../../i18n/domain-error';
import { MetaVirtualPropertyRepository } from './meta-virtual-property.repository';
import { ExpressionCompilerService } from '../shared/expression-compiler.service';
import { AttributeResolverService } from '../shared/attribute-resolver.service';
import { MetaVirtualEventService } from './meta-virtual-event.service';
import { CreateMetaVirtualPropertyDto, UpdateMetaVirtualPropertyDto } from './dto/meta-virtual-property.dto';

@Injectable()
export class MetaVirtualPropertyService {
  constructor(
    private readonly repository: MetaVirtualPropertyRepository,
    private readonly expressionCompiler: ExpressionCompilerService,
    private readonly attributeResolver: AttributeResolverService,
    private readonly virtualEvents: MetaVirtualEventService,
  ) {}

  async list(projectName: string, eventKey?: string) {
    if (!eventKey) return this.repository.findMany(projectName);
    const def = await this.virtualEvents.findDefinition(eventKey, projectName);
    if (def?.events?.length) {
      return this.repository.findForEventKeys(projectName, def.events);
    }
    return this.repository.findMany(projectName, eventKey);
  }

  async create(projectName: string, dto: CreateMetaVirtualPropertyDto) {
    this.validatePropKey(dto.prop_key);
    await this.validateExpression(dto.expression, projectName, dto.event_key);

    const existing = await this.repository.findByKey(dto.prop_key, projectName, dto.event_key);
    if (existing) {
      throw badRequest({
        code: 'meta.virtualProperty.keyExists',
        messageKey: 'meta:error.virtualProperty.keyExists',
        message: '同一项目/事件下虚拟属性标识已存在',
      });
    }

    return this.repository.create(projectName, {
      prop_key: dto.prop_key,
      display_name: dto.display_name,
      data_type: dto.data_type,
      expression: dto.expression,
      event_key: dto.event_key,
      description: dto.description,
    });
  }

  async update(id: string, projectName: string, dto: UpdateMetaVirtualPropertyDto) {
    const existing = await this.repository.findById(id, projectName);
    if (!existing) {
      throw badRequest({
        code: 'meta.virtualProperty.notFound',
        messageKey: 'meta:error.virtualProperty.notFound',
        message: '虚拟属性不存在',
      });
    }

    if (dto.expression) {
      await this.validateExpression(dto.expression, projectName, dto.event_key ?? existing.event_key ?? undefined);
    }

    const data: any = { ...dto };
    if (dto.expression || dto.status === 'active') {
      data.invalid_reason = null;
    }

    await this.repository.update(id, projectName, data);
    return this.repository.findById(id, projectName);
  }

  async delete(id: string, projectName: string) {
    const result = await this.repository.delete(id, projectName);
    if (result.count === 0) {
      throw badRequest({
        code: 'meta.virtualProperty.notFound',
        messageKey: 'meta:error.virtualProperty.notFound',
        message: '虚拟属性不存在',
      });
    }
    return { success: true };
  }

  async validate(id: string, projectName: string) {
    const vp = await this.repository.findById(id, projectName);
    if (!vp) {
      throw badRequest({
        code: 'meta.virtualProperty.notFound',
        messageKey: 'meta:error.virtualProperty.notFound',
        message: '虚拟属性不存在',
      });
    }
    try {
      await this.validateExpression(vp.expression, projectName, vp.event_key ?? undefined);
      await this.repository.update(id, projectName, { status: 'active', invalid_reason: null });
      return { valid: true };
    } catch (error) {
      // invalid_reason 是审计/展示数据，保留原文；抛错优先复用领域错误的 errorCode
      const reason = error instanceof Error ? error.message : String(error);
      await this.repository.update(id, projectName, { status: 'invalid', invalid_reason: reason });
      if (error instanceof DomainError) throw error;
      throw badRequest({
        code: 'meta.virtualProperty.expressionInvalid',
        messageKey: 'meta:error.virtualProperty.expressionInvalid',
        params: { reason },
        message: reason,
      });
    }
  }

  private validatePropKey(key: string) {
    if (!key.startsWith('vp_')) {
      throw badRequest({
        code: 'meta.virtualProperty.keyPrefixRequired',
        messageKey: 'meta:error.virtualProperty.keyPrefixRequired',
        message: '虚拟属性标识必须以 vp_ 开头',
      });
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$/.test(key)) {
      throw badRequest({
        code: 'meta.virtualProperty.keyInvalid',
        messageKey: 'meta:error.virtualProperty.keyInvalid',
        message: '虚拟属性标识格式不合法',
      });
    }
  }

  private async validateExpression(expression: string, projectName: string, eventKey?: string) {
    if (!expression || expression.trim().length === 0) {
      throw badRequest({
        code: 'meta.virtualProperty.expressionRequired',
        messageKey: 'meta:error.virtualProperty.expressionRequired',
        message: '表达式不能为空',
      });
    }
    if (expression.length > 1000) {
      throw badRequest({
        code: 'meta.virtualProperty.expressionTooLong',
        messageKey: 'meta:error.virtualProperty.expressionTooLong',
        message: '表达式长度超过限制',
      });
    }

    const props = this.expressionCompiler.extractProps(expression);
    for (const prop of props) {
      // 禁止虚拟属性嵌套引用其他虚拟属性
      const existingVp = await this.repository.findByKey(prop, projectName, eventKey);
      if (existingVp) {
        throw badRequest({
          code: 'meta.virtualProperty.nestedReferenceNotAllowed',
          messageKey: 'meta:error.virtualProperty.nestedReferenceNotAllowed',
          params: { prop },
          message: `虚拟属性表达式不能引用其他虚拟属性: ${prop}`,
        });
      }

      const dataType = await this.attributeResolver.inferBaseEventDataType(prop, {
        project: projectName,
        event: eventKey,
      });
      await this.attributeResolver.resolveBaseEventProperty(prop, dataType, {
        project: projectName,
        event: eventKey,
      });
    }

    // 尝试编译一次，确保函数/运算符合法
    await this.expressionCompiler.compile(
      expression,
      { project: projectName, event: eventKey },
      async (referencedProp: string) => {
        const refDataType = await this.attributeResolver.inferBaseEventDataType(referencedProp, {
          project: projectName,
          event: eventKey,
        });
        return this.attributeResolver.resolveBaseEventProperty(referencedProp, refDataType, {
          project: projectName,
          event: eventKey,
        });
      },
    );
  }
}
