import assert from "node:assert/strict";
import ts from "typescript";

const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ".");
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const violations: string[] = [];
function isTank(node: ts.Node): boolean {
  const type = checker.getContextualType(node as ts.Expression) ?? checker.getTypeAtLocation(node);
  return ["goal", "hp", "team", "cooldown"].every((key) => !!type.getProperty(key));
}
function throughGoal(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === "goal" || throughGoal(node.expression);
  if (ts.isElementAccessExpression(node)) return node.argumentExpression.getText() === '"goal"' ||
    node.argumentExpression.getText() === "'goal'" || throughGoal(node.expression);
  return false;
}
for (const source of program.getSourceFiles()) {
  if (source.isDeclarationFile || !/[/\\]src[/\\]/.test(source.fileName.replace(/^src\//, "/src/"))) continue;
  if (source.fileName.endsWith("interrupt-stack.ts")) continue;
  const visit = (node: ts.Node): void => {
    const assignment = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && throughGoal(node.left);
    const initialization = ts.isPropertyAssignment(node) && node.name.getText() === "goal" && isTank(node.parent);
    const deletion = ts.isDeleteExpression(node) && throughGoal(node.expression);
    const mutation = ts.isCallExpression(node) && (
      (ts.isPropertyAccessExpression(node.expression) && throughGoal(node.expression.expression) &&
        ["push", "pop", "splice", "shift", "unshift", "sort", "reverse", "fill", "copyWithin"].includes(node.expression.name.text)) ||
      (node.expression.getText() === "Object.assign" && node.arguments.some((arg) => throughGoal(arg) ||
        (ts.isObjectLiteralExpression(arg) && arg.properties.some((property) => property.name?.getText() === "goal")))));
    if (assignment || initialization || deletion || mutation) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      violations.push(`${source.fileName}:${line + 1}: goal writes must use interrupt-stack`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
assert.deepEqual(violations, [], violations.join("\n"));
console.log("Goal write boundary: passed (src initializers, assignments, nested mutations and Object.assign)");
