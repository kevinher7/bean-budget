import ts from "typescript";
import { resolve, relative } from "node:path";

const root = process.cwd();
const configPath = ts.findConfigFile(root, (path) => ts.sys.fileExists(path), "tsconfig.json");
if (!configPath) throw new Error("Missing tsconfig");
const loaded = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
if (config.errors.length > 0)
  throw new Error(
    config.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
      .join("\n"),
  );
for (const file of config.fileNames) {
  const owner = relative(root, file).split("/").slice(0, 2).join("/");
  if (owner !== "packages/budget" && owner !== "packages/protocol") continue;
  const content = ts.sys.readFile(file);
  if (content === undefined) throw new Error("Cannot read source file: " + file);
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  function inspect(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const dependency = ts.resolveModuleName(
        specifier,
        file,
        config.options,
        ts.sys,
      ).resolvedModule;
      const target = dependency ? relative(root, resolve(dependency.resolvedFileName)) : specifier;
      const allowed =
        target.startsWith(owner + "/") ||
        target.startsWith("node_modules/effect/") ||
        (owner === "packages/protocol" && target.startsWith("packages/budget/"));
      if (!allowed) throw new Error(file + ": forbidden shared-package dependency " + specifier);
    }
    // Shared packages cannot hide platform dependencies in dynamic imports or require.
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      throw new Error(file + ": dynamic dependency is forbidden");
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}
console.log("Shared package import boundaries passed");
