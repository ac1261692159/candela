import { Injectable } from '@nestjs/common';
import jsep from 'jsep';

export type PropResolver = (prop: string) => Promise<string>;

interface CompileContext {
  project: string;
  event?: string;
}

const ALLOWED_FUNCTIONS = new Set(['if', 'concat', 'length', 'toString', 'round']);

@Injectable()
export class ExpressionCompilerService {
  /**
   * 解析表达式并提取引用的属性 key（去掉 $ 前缀）。
   */
  extractProps(expression: string): string[] {
    const ast = this.parse(expression);
    const props = new Set<string>();
    this.walk(ast, (node) => {
      if (this.isPropNode(node)) {
        props.add((node as any).name.slice(1));
      }
    });
    return Array.from(props);
  }

  /**
   * 把表达式编译成 ClickHouse SQL 片段。
   * @param resolveProp 用于把 $prop 解析成 ClickHouse 表达式的回调
   */
  async compile(
    expression: string,
    _context: CompileContext,
    resolveProp: PropResolver,
  ): Promise<string> {
    const ast = this.parse(expression);
    return this.compileNode(ast, resolveProp);
  }

  private parse(expression: string): jsep.Expression {
    try {
      return jsep(expression);
    } catch (error) {
      throw new Error(`表达式解析失败: ${error.message}`);
    }
  }

  private async compileNode(node: jsep.Expression, resolveProp: PropResolver): Promise<string> {
    switch (node.type) {
      case 'Literal':
        return this.compileLiteral(node as jsep.Literal);
      case 'Identifier':
        return this.compileIdentifier(node as jsep.Identifier, resolveProp);
      case 'UnaryExpression':
        return this.compileUnary(node as jsep.UnaryExpression, resolveProp);
      case 'BinaryExpression':
        return this.compileBinary(node as jsep.BinaryExpression, resolveProp);
      case 'CallExpression':
        return this.compileCall(node as jsep.CallExpression, resolveProp);
      case 'MemberExpression':
        return this.compileMember(node as jsep.MemberExpression, resolveProp);
      case 'Compound':
        throw new Error('表达式不支持逗号运算符');
      case 'ThisExpression':
      case 'ArrayExpression':
      default:
        throw new Error(`不支持的表达式节点类型: ${node.type}`);
    }
  }

  private compileLiteral(node: jsep.Literal): string {
    if (typeof node.value === 'string') {
      return `'${node.value.replace(/'/g, "\\'")}'`;
    }
    if (typeof node.value === 'boolean') {
      return node.value ? '1' : '0';
    }
    if (node.value === null || node.value === undefined) {
      return 'NULL';
    }
    return String(node.value);
  }

  private async compileIdentifier(
    node: jsep.Identifier,
    resolveProp: PropResolver,
  ): Promise<string> {
    if (this.isPropNode(node)) {
      const prop = (node as any).name.slice(1);
      return resolveProp(prop);
    }
    throw new Error(`未知标识符: ${(node as any).name}，属性引用请以 $ 开头`);
  }

  private async compileUnary(
    node: jsep.UnaryExpression,
    resolveProp: PropResolver,
  ): Promise<string> {
    const arg = await this.compileNode(node.argument, resolveProp);
    if (node.operator === '!') return `not(${arg})`;
    if (node.operator === '-') return `(-${arg})`;
    if (node.operator === '+') return arg;
    throw new Error(`不支持的一元运算符: ${node.operator}`);
  }

  private async compileBinary(
    node: jsep.BinaryExpression,
    resolveProp: PropResolver,
  ): Promise<string> {
    const left = await this.compileNode(node.left, resolveProp);
    const right = await this.compileNode(node.right, resolveProp);
    const op = this.mapBinaryOperator(node.operator);
    return `(${left} ${op} ${right})`;
  }

  private mapBinaryOperator(op: string): string {
    switch (op) {
      case '==':
      case '===':
        return '=';
      case '!=':
      case '!==':
        return '!=';
      case '&&':
        return 'AND';
      case '||':
        return 'OR';
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '>':
      case '>=':
      case '<':
      case '<=':
        return op;
      default:
        throw new Error(`不支持的二元运算符: ${op}`);
    }
  }

  private async compileCall(
    node: jsep.CallExpression,
    resolveProp: PropResolver,
  ): Promise<string> {
    const callee = node.callee as jsep.Identifier;
    const name = (callee as any).name;
    if (!ALLOWED_FUNCTIONS.has(name)) {
      throw new Error(`不支持的函数: ${name}`);
    }
    const args = await Promise.all(
      node.arguments.map((arg) => this.compileNode(arg, resolveProp)),
    );
    return `${name}(${args.join(', ')})`;
  }

  private async compileMember(
    node: jsep.MemberExpression,
    resolveProp: PropResolver,
  ): Promise<string> {
    if (node.computed) {
      throw new Error('不支持计算属性访问');
    }
    const object = await this.compileNode(node.object, resolveProp);
    const property = (node.property as any).name;
    throw new Error(`不支持属性访问: ${object}.${property}`);
  }

  private isPropNode(node: jsep.Expression): node is jsep.Identifier {
    return node.type === 'Identifier' && (node as any).name.startsWith('$');
  }

  private walk(node: jsep.Expression, visitor: (n: jsep.Expression) => void) {
    visitor(node);
    switch (node.type) {
      case 'UnaryExpression':
        this.walk((node as jsep.UnaryExpression).argument, visitor);
        break;
      case 'BinaryExpression':
        this.walk((node as jsep.BinaryExpression).left, visitor);
        this.walk((node as jsep.BinaryExpression).right, visitor);
        break;
      case 'CallExpression':
        (node as jsep.CallExpression).arguments.forEach((arg) => this.walk(arg, visitor));
        break;
      case 'MemberExpression':
        this.walk((node as jsep.MemberExpression).object, visitor);
        this.walk((node as jsep.MemberExpression).property, visitor);
        break;
    }
  }
}
