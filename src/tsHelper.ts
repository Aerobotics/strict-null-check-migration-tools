import * as path from 'path'
import * as fs from 'fs'
import * as ts from 'typescript'

/**
 * Given a file, return the list of files it imports as absolute paths.
 */
export function getImportsForFile(file: string, srcRoot: string, tsconfigPath: string) {
  return getImportsForFileWithCompilerAPI(file, tsconfigPath);
  // Follow symlink so directory check works.
  file = fs.realpathSync(file)

  if (fs.lstatSync(file).isDirectory()) {
    const index = path.join(file, "index.ts")
    const indexDts = path.join(file, "index.d.ts")
    const indexTsx = path.join(file, "index.tsx")
    if (fs.existsSync(index)) {
      // https://basarat.gitbooks.io/typescript/docs/tips/barrel.html
      console.warn(`Warning: Barrel import: ${path.relative(srcRoot, file)}`)
      file = index
    } else if (fs.existsSync(indexDts)) {
      // https://basarat.gitbooks.io/typescript/docs/tips/barrel.html
      console.warn(`Warning: Barrel import: ${path.relative(srcRoot, file)}`)
      file = indexDts
    } else if (fs.existsSync(indexTsx)) {
      // https://basarat.gitbooks.io/typescript/docs/tips/barrel.html
      console.warn(`Warning: Barrel import: ${path.relative(srcRoot, file)}`)
      file = indexTsx
    } else {
      throw new Error(`Warning: Importing a directory without an index.ts file: ${path.relative(srcRoot, file)}`)
    }
  }

  const fileInfo = ts.preProcessFile(fs.readFileSync(file).toString());
  return fileInfo.importedFiles
    .map(importedFile => importedFile.fileName)
    // remove svg, css imports
    .filter(fileName => !fileName.endsWith(".css") && !fileName.endsWith(".svg") && !fileName.endsWith(".json"))
    .filter(fileName => !fileName.endsWith(".js") && !fileName.endsWith(".jsx")) // Assume .js/.jsx imports have a .d.ts available
    .filter(x => /\//.test(x)) // remove node modules (the import must contain '/')
    .map(fileName => {
      if (/(^\.\/)|(^\.\.\/)/.test(fileName)) {
        return path.join(path.dirname(file), fileName)
      }
      return path.join(srcRoot, fileName);
    }).map(fileName => {
      if (fs.existsSync(`${fileName}.ts`)) {
        return `${fileName}.ts`
      }
      if (fs.existsSync(`${fileName}.tsx`)) {
        return `${fileName}.tsx`
      }
      if (fs.existsSync(`${fileName}.d.ts`)) {
        return `${fileName}.d.ts`
      }
      if (fs.existsSync(`${fileName}`)) {
        return fileName
      }
      console.warn(`Warning: Unresolved import ${path.relative(srcRoot, fileName)} ` +
                   `in ${path.relative(srcRoot, file)}`)
      return null
    }).filter(fileName => !!fileName)
}

interface ResolvedImports {
  /** The original import specifier as written in the source */
  specifier: string;
  /** The resolved absolute file path */
  resolvedPath: string | null;
  /** Whether the import was successfully resolved */
  isResolved: boolean;
  /** The type of import (relative, absolute, node_modules, etc.) */
  importType: 'relative' | 'absolute' | 'node_modules' | 'builtin';
}

// Function to check if module is a Node.js builtin
function isBuiltinModule(moduleName: string): boolean {
  const builtins = [
    'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram',
    'dns', 'domain', 'events', 'fs', 'http', 'https', 'net', 'os',
    'path', 'punycode', 'querystring', 'readline', 'stream', 'string_decoder',
    'tls', 'tty', 'url', 'util', 'v8', 'vm', 'zlib'
  ];
  return builtins.includes(moduleName) || moduleName.startsWith('node:');
}

function isSourceFileExt(resolvedFileName: string): boolean {
  return resolvedFileName.endsWith('.ts') ||
      resolvedFileName.endsWith('.tsx') ||
      resolvedFileName.endsWith('.js') ||
      resolvedFileName.endsWith('.jsx')
}

/**
 * Resolves all import paths in a TypeScript file to their absolute file paths
 * @param tsFilePath - Absolute path to the TypeScript file to analyze
 * @param tsconfigPath - Absolute path to the tsconfig.json file
 * @returns Array of resolved import information
 */
export function resolveFileImports(
    tsFilePath: string,
    tsconfigPath: string
): ResolvedImports[] {
  // Read and parse tsconfig.json
  const tsconfigContent = fs.readFileSync(tsconfigPath, 'utf8');
  const tsconfig = ts.parseConfigFileTextToJson(tsconfigPath, tsconfigContent);

  if (tsconfig.error) {
    throw new Error(`Failed to parse tsconfig.json: ${tsconfig.error.messageText}`);
  }

  // Get the directory containing tsconfig.json (project root)
  const projectRoot = path.dirname(tsconfigPath);

  // Parse compiler options
  const { options: compilerOptions, errors } = ts.convertCompilerOptionsFromJson(
      tsconfig.config.compilerOptions || {},
      projectRoot
  );

  if (errors.length > 0) {
    throw new Error(`Compiler options errors: ${errors.map(e => e.messageText).join(', ')}`);
  }

  // Create a compiler host
  const host = ts.createCompilerHost(compilerOptions);

  // Read the TypeScript file
  const sourceText = fs.readFileSync(tsFilePath, 'utf8');
  const sourceFile = ts.createSourceFile(
      tsFilePath,
      sourceText,
      compilerOptions.target || ts.ScriptTarget.Latest,
      true
  );

  const resolvedImports: ResolvedImports[] = [];

  // Function to resolve a module
  function resolveModule(moduleName: string, containingFile: string): ResolvedImports {
    const result: ResolvedImports = {
      specifier: moduleName,
      resolvedPath: null,
      isResolved: false,
      importType: getImportType(moduleName)
    };

    // Use TypeScript's module resolution
    const resolution = ts.resolveModuleName(
        moduleName,
        containingFile,
        compilerOptions,
        host
    );

    if (resolution.resolvedModule) {
      result.resolvedPath = resolution.resolvedModule.resolvedFileName;
      result.isResolved = true;
    } else {
      // Try manual resolution for relative paths
      if (moduleName.startsWith('.')) {
        const containingDir = path.dirname(containingFile);
        const possibleExtensions = ['.ts', '.tsx', '.js', '.jsx', '.d.ts'];

        // Try resolving as file
        for (const ext of possibleExtensions) {
          const filePath = path.resolve(containingDir, moduleName + ext);
          if (fs.existsSync(filePath)) {
            result.resolvedPath = filePath;
            result.isResolved = true;
            break;
          }
        }

        // Try resolving as directory with index file
        if (!result.isResolved) {
          const dirPath = path.resolve(containingDir, moduleName);
          for (const ext of possibleExtensions) {
            const indexPath = path.join(dirPath, 'index' + ext);
            if (fs.existsSync(indexPath)) {
              result.resolvedPath = indexPath;
              result.isResolved = true;
              break;
            }
          }
        }
      }
    }

    return result;
  }

  // Function to determine import type
  function getImportType(moduleName: string): ResolvedImports['importType'] {
    if (moduleName.startsWith('.')) {
      return 'relative';
    } else if (moduleName.startsWith('/')) {
      return 'absolute';
    } else if (isBuiltinModule(moduleName)) {
      return 'builtin';
    } else {
      return 'node_modules';
    }
  }

  function getStringLiteralValue(node: ts.Expression): string | null {
    if (ts.isStringLiteral(node)) {
      return node.text;
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    return null;
  }

  // Visitor function to traverse the AST and find import statements
  function visit(node: ts.Node) {
    // Handle import declarations: import { foo } from 'module'
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      resolvedImports.push(resolveModule(moduleName, tsFilePath));
    }

    // Handle export declarations: export { foo } from 'module'
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      resolvedImports.push(resolveModule(moduleName, tsFilePath));
    }

    // Handle import() expressions: const module = await import('module')
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        const moduleName = getStringLiteralValue(node.arguments[0]);
        if (moduleName) {
          resolvedImports.push(resolveModule(moduleName, tsFilePath));
        }
      }
    }

    // Handle require() calls: const module = require('module')
    else if (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])) {

      const moduleName = getStringLiteralValue(node.arguments[0]);
      if (moduleName) {
        resolvedImports.push(resolveModule(moduleName, tsFilePath));
      }
    }

    // Continue traversing child nodes
    ts.forEachChild(node, visit);
  }

  // Start the traversal
  visit(sourceFile);

  return resolvedImports;
}

function getImportsForFileWithCompilerAPI(file: string, tsConfigPath: string): string[] {
  const imported = resolveFileImports(file, tsConfigPath);
  const result: string[] = [];
  for (const imp of imported) {
    if (imp.isResolved) {
      result.push(imp.resolvedPath);
    } else if (!isBuiltinModule(imp.specifier) && isSourceFileExt(imp.specifier)) {
      throw new Error(`Could not resolve import: ${imp.specifier}`);
    }
  }

  return result
}

/**
 * Build a map of files to their imports using the TypeScript compiler API
 * for accurate module resolution.
 */
export function buildImportMapWithCompilerAPI(tsconfigPath: string): Map<string, string[]> {
  // Read and parse tsconfig.json
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(`Error reading tsconfig: ${configFile.error.messageText}`);
  }

  // Create compiler options and get file names
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(tsconfigPath)
  );

  if (parsedConfig.errors.length > 0) {
    const errors = parsedConfig.errors.map(err => err.messageText).join('\n');
    throw new Error(`Error parsing tsconfig: ${errors}`);
  }

  // Create TypeScript program
  const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
  const typeChecker = program.getTypeChecker();
  const importMap = new Map<string, string[]>();

  // Process each source file
  for (const sourceFile of program.getSourceFiles()) {
    // Skip declaration files and files outside our project
    if (sourceFile.isDeclarationFile || !parsedConfig.fileNames.includes(sourceFile.fileName)) {
      continue;
    }

    const imports: string[] = [];
    const moduleSpecifiers: string[] = [];

    // Visit all nodes to find import declarations
    function visitNode(node: ts.Node) {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        moduleSpecifiers.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        moduleSpecifiers.push(node.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(node) &&
                 ts.isExternalModuleReference(node.moduleReference) &&
                 ts.isStringLiteral(node.moduleReference.expression)) {
        moduleSpecifiers.push(node.moduleReference.expression.text);
      }
      ts.forEachChild(node, visitNode);
    }

    visitNode(sourceFile);

    // Resolve each module specifier to actual file path
    for (const moduleSpecifier of moduleSpecifiers) {
      const resolution = ts.resolveModuleName(
        moduleSpecifier,
        sourceFile.fileName,
        parsedConfig.options,
        ts.sys
      );

      if (resolution.resolvedModule) {
        const resolvedFileName = resolution.resolvedModule.resolvedFileName;
        // Only include TypeScript/JavaScript files, exclude node_modules
        if (!resolvedFileName.includes('node_modules') &&
            isSourceFileExt(resolvedFileName)) {
          imports.push(path.resolve(resolvedFileName));
        }
      } else {
        console.warn(`Could not resolve module: ${moduleSpecifier} from ${sourceFile.fileName}`);
      }
    }

    importMap.set(path.resolve(sourceFile.fileName), imports);
  }

  return importMap;
}

/**
 * This class memoizes the list of imports for each file.
 */
export class ImportTracker {
  private imports = new Map<string, string[]>()

  constructor(private srcRoot: string) {}

  public getImports(file: string, tsconfigPath: string): string[] {
    if (this.imports.has(file)) {
      return this.imports.get(file)
    }
    const imports = getImportsForFile(file, this.srcRoot, tsconfigPath)
    this.imports.set(file, imports)
    return imports
  }
}
