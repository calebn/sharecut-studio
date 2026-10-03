import { posix } from "node:path";
import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export type SourceInput = Readonly<{ rel: string; text: string }>;
export type RenderCall = Readonly<{
  file: string;
  line: number;
  column: number;
  callback: string;
}>;

type Call = t.CallExpression | t.OptionalCallExpression;
type Hook = "useStableCallback" | "useMemo" | "useState" | "useReducer";

function unwrap(node: t.Node | null | undefined): t.Node | undefined {
  if (
    t.isParenthesizedExpression(node) ||
    t.isTSAsExpression(node) ||
    t.isTSTypeAssertion(node) ||
    t.isTSNonNullExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSInstantiationExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node ?? undefined;
}

function memberName(node: t.MemberExpression | t.OptionalMemberExpression) {
  if (!node.computed && t.isIdentifier(node.property))
    return node.property.name;
  if (node.computed && t.isStringLiteral(node.property))
    return node.property.value;
  return undefined;
}

function hookName(
  node: t.Node | undefined,
  path: NodePath,
  source: SourceInput,
): Hook | undefined {
  let target = unwrap(node);
  let member: string | undefined;
  if (t.isMemberExpression(target) || t.isOptionalMemberExpression(target)) {
    member = memberName(target);
    if (!member) return undefined;
    target = unwrap(target.object);
  }
  if (!t.isIdentifier(target)) return undefined;
  const imported = path.scope.getBinding(target.name)?.path;
  const declaration = imported?.parentPath;
  if (
    !declaration?.isImportDeclaration() ||
    declaration.node.importKind === "type"
  )
    return undefined;
  const module = declaration.node.source.value;
  let name: string | undefined;
  if (imported?.isImportSpecifier() && imported.node.importKind !== "type") {
    const importedName = t.isIdentifier(imported.node.imported)
      ? imported.node.imported.name
      : imported.node.imported.value;
    name = member
      ? module === "react" && importedName === "default"
        ? member
        : undefined
      : importedName;
  } else if (
    imported?.isImportNamespaceSpecifier() ||
    (imported?.isImportDefaultSpecifier() &&
      declaration.node.source.value === "react")
  ) {
    name = member;
  }
  if (
    module === "react" &&
    (name === "useMemo" || name === "useState" || name === "useReducer")
  )
    return name;
  if (
    name === "useStableCallback" &&
    module.startsWith(".") &&
    posix
      .normalize(posix.join(posix.dirname(source.rel), module))
      .replace(/\.[cm]?[jt]sx?$/, "") === "utils/useStableCallback"
  )
    return name;
  return undefined;
}

function callbackIndex(hook: Hook | undefined): number {
  return hook === "useMemo" || hook === "useState"
    ? 0
    : hook === "useReducer"
      ? 2
      : -1;
}

function eagerArguments(
  fn: NodePath<t.Function>,
  source: SourceInput,
): readonly NodePath[] | undefined {
  if (
    !(fn.isArrowFunctionExpression() || fn.isFunctionExpression()) ||
    fn.node.async ||
    fn.node.generator
  )
    return undefined;
  let expression: NodePath = fn;
  while (
    expression.parentPath &&
    unwrap(expression.parentPath.node) === fn.node
  )
    expression = expression.parentPath;
  const call = expression.parentPath;
  if (!call?.isCallExpression() && !call?.isOptionalCallExpression())
    return undefined;
  const invocation: NodePath<Call> = call;
  if (unwrap(call.node.callee) === fn.node) return invocation.get("arguments");
  const index = callbackIndex(hookName(call.node.callee, call, source));
  if (index < 0 || call.node.arguments[index] !== expression.node)
    return undefined;
  return index === 2 ? invocation.get("arguments").slice(1, 2) : [];
}

function isUndefinedArgument(argument: NodePath | undefined): boolean {
  const node = unwrap(argument?.node);
  return (
    !node ||
    (t.isIdentifier(node, { name: "undefined" }) &&
      !argument?.scope.getBinding("undefined")) ||
    (t.isUnaryExpression(node, { operator: "void" }) &&
      t.isNumericLiteral(node.argument))
  );
}

function parameterExecutes(
  target: NodePath,
  parameter: NodePath,
  argument: NodePath | undefined,
): boolean {
  let value = unwrap(argument?.node);
  let pattern = parameter;
  if (pattern.isAssignmentPattern()) {
    const right = pattern.get("right");
    if (right === target || right.isAncestor(target))
      return isUndefinedArgument(argument);
    if (isUndefinedArgument(argument)) value = unwrap(right.node);
    pattern = pattern.get("left");
  }
  if (
    target.findParent(
      (path) => path.isObjectPattern() || path.isArrayPattern(),
    ) !== pattern
  )
    return false;
  return (
    (pattern.isObjectPattern() &&
      t.isObjectExpression(value) &&
      value.properties.length === 0) ||
    (pattern.isArrayPattern() &&
      t.isArrayExpression(value) &&
      value.elements.length === 0)
  );
}

function isEager(
  target: NodePath,
  owner: NodePath<t.Function>,
  source: SourceInput,
): boolean {
  for (let child = target; child.parentPath; child = child.parentPath) {
    const parent = child.parentPath;
    if (parent === owner) return true;
    if (parent.isTSType()) return false;
    if (
      (parent.isClassProperty() ||
        parent.isClassPrivateProperty() ||
        parent.isClassAccessorProperty()) &&
      child.key === "value" &&
      !parent.node.static
    )
      return false;
    if (parent.isFunction()) {
      if (
        (parent.isObjectMethod() || parent.isClassMethod()) &&
        child.key === "key" &&
        parent.node.computed
      )
        continue;
      const args = eagerArguments(parent, source);
      if (!args) return false;
      if (child.listKey === "params") {
        const index = parent.node.params.findIndex(
          (parameter) => parameter === child.node,
        );
        if (
          args.slice(0, index + 1).some((arg) => arg.isSpreadElement()) ||
          !parameterExecutes(target, child, args[index])
        )
          return false;
      }
    }
  }
  return false;
}

export function findStableCallbackRenderCalls(
  source: SourceInput,
): readonly RenderCall[] {
  const ast = parse(source.text, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"],
  });
  const violations: RenderCall[] = [];
  const report = (target: t.Node | undefined, site: NodePath): void => {
    const identifier = unwrap(target);
    if (!t.isIdentifier(identifier)) return;
    const resolved = site.scope.getBinding(identifier.name);
    if (!resolved?.constant) return;
    const binding = resolved.path;
    if (!binding?.isVariableDeclarator() || !t.isIdentifier(binding.node.id))
      return;
    const init = unwrap(binding.node.init);
    if (
      !(t.isCallExpression(init) || t.isOptionalCallExpression(init)) ||
      hookName(init.callee, binding, source) !== "useStableCallback"
    )
      return;
    const owner = binding.getFunctionParent();
    const start = site.node.loc?.start;
    if (owner && start && isEager(site, owner, source))
      violations.push({
        file: source.rel,
        line: start.line,
        column: start.column + 1,
        callback: identifier.name,
      });
  };
  const visit = (path: NodePath<Call>): void => {
    const callee = unwrap(path.node.callee);
    if (
      (t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) &&
      ["call", "apply"].includes(memberName(callee) ?? "")
    )
      report(callee.object, path);
    else report(callee, path);
    const index = callbackIndex(hookName(path.node.callee, path, source));
    const callback = path.get("arguments")[index];
    if (callback) report(callback.node, callback);
  };
  traverse(ast, { CallExpression: visit, OptionalCallExpression: visit });
  return violations.sort(
    (left, right) => left.line - right.line || left.column - right.column,
  );
}
