import ts from "typescript";
import { resolve, relative } from "node:path";

const root = resolve("apps/mobile/src");
const palette = resolve(root, "ui/theme.ts");
const files = ts.sys.readDirectory(root, [".ts", ".tsx"], undefined, ["**/*"]);
let violations = 0;
for (const file of files) {
  if (resolve(file) === palette) continue;
  const source = ts.createSourceFile(
    file,
    ts.sys.readFile(file) ?? "",
    ts.ScriptTarget.Latest,
    true,
  );
  const tokenImports = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const imported = resolve(file, "..", statement.moduleSpecifier.text);
    if (imported !== palette) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName?.text ?? binding.name.text) === "colors")
          tokenImports.add(binding.name.text);
      }
    }
  }
  function isToken(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return isToken(node.expression);
    if (ts.isConditionalExpression(node)) return isToken(node.whenTrue) && isToken(node.whenFalse);
    return (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      tokenImports.has(node.expression.text)
    );
  }
  function report(node: ts.Node) {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    console.error(
      `${relative(process.cwd(), file)}:${location.line + 1}:${location.character + 1}: Use a semantic color from ui/theme.ts`,
    );
    violations++;
  }
  function inspect(node: ts.Node): void {
    if (ts.isShorthandPropertyAssignment(node) && /color$/i.test(node.name.text)) report(node);
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
          ? node.name.text
          : ts.isComputedPropertyName(node.name) && ts.isStringLiteral(node.name.expression)
            ? node.name.expression.text
            : "";
      if (/color$/i.test(name) && !isToken(node.initializer)) report(node.initializer);
    }
    if (ts.isJsxAttribute(node) && /color$/i.test(node.name.getText(source))) {
      const value = node.initializer;
      if (!value || !ts.isJsxExpression(value) || !value.expression || !isToken(value.expression))
        report(node);
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^(#[\da-f]{3,8}|rgba?\s*\(|hsla?\s*\()/i.test(node.text)
    )
      report(node);
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}
if (violations > 0) process.exitCode = 1;
else console.log("Mobile semantic colors passed");
