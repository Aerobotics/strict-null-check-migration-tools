import * as fs from 'fs'
import { spawn, ChildProcessWithoutNullStreams, execSync } from 'child_process'
import * as ts from 'typescript'
import * as path from "path";

const buildCompletePattern = /Found (\d+) errors?\. Watching for file changes\./gi

export interface TypeCheckResult {
  hasErrors: boolean;
  errors: TypeCheckError[];
}

export interface TypeCheckError {
  file: string;
  line: number;
  column: number;
  message: string;
  code: number;
  severity: 'error' | 'warning';
  category: string;
}

export class TypeScriptChecker {
  private program: ts.Program;
  private compilerOptions: ts.CompilerOptions;
  private host: ts.CompilerHost;

  constructor(tsconfigPath: string) {
    this.initializeProgram(tsconfigPath);
  }

  private initializeProgram(tsconfigPath: string): void {
    // Read and parse tsconfig.json
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(`Error reading tsconfig.json: ${configFile.error.messageText}`);
    }

    // Parse the config file content
    const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(path.resolve(tsconfigPath)),
        {
          rootDir: path.dirname(path.resolve(tsconfigPath)),
        },

    );

    if (parsedConfig.errors.length > 0) {
      const errorMessages = parsedConfig.errors.map(err => err.messageText).join('\n');
      throw new Error(`Error parsing tsconfig.json: ${errorMessages}`);
    }

    this.compilerOptions = parsedConfig.options;
    this.host = ts.createCompilerHost(this.compilerOptions);
    this.host = {
      ...this.host,
      getCurrentDirectory: () => path.dirname(path.resolve(tsconfigPath)),
    }

    console.log('current host directory:', this.host.getCurrentDirectory());
    // Create the program with all files from the project
    this.program = ts.createProgram(parsedConfig.fileNames, this.compilerOptions, this.host);
  }

  /**
   * Check a specific source file for type errors
   * @param sourceFilePath - Absolute path to the source file to check
   * @returns TypeCheckResult with error information
   */
  public checkSourceFile(sourceFilePath: string): TypeCheckResult {
    // Get the source file from the program
    const sourceFile = this.program.getSourceFile(sourceFilePath);

    if (!sourceFile) {
      return {
        hasErrors: true,
        errors: [{
          file: sourceFilePath,
          line: 0,
          column: 0,
          message: `Source file not found in program: ${sourceFilePath}`,
          code: 0,
          severity: 'error',
          category: 'file'
        }]
      };
    }

    // Get all diagnostics for the source file
    const syntacticDiagnostics = this.program.getSyntacticDiagnostics(sourceFile);
    const semanticDiagnostics = this.program.getSemanticDiagnostics(sourceFile);
    const declarationDiagnostics = this.program.getDeclarationDiagnostics?.(sourceFile) || [];

    // Combine all diagnostics
    const allDiagnostics = [
      ...syntacticDiagnostics,
      ...semanticDiagnostics,
      ...declarationDiagnostics
    ];

    const errors: TypeCheckError[] = allDiagnostics.map(diagnostic => {
      const { line, character } = diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : { line: 0, character: 0 };

      const category = this.getDiagnosticCategory(diagnostic.category);
      const severity = diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : 'warning';

      return {
        file: diagnostic.file?.fileName || sourceFilePath,
        line: line + 1, // Convert to 1-based line numbers
        column: character + 1, // Convert to 1-based column numbers
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        code: diagnostic.code,
        severity,
        category
      };
    });

    return {
      hasErrors: errors.some(error => error.severity === 'error'),
      errors
    };
  }

  /**
   * Refresh the program with updated files (useful if files have changed)
   * @param tsconfigPath - Path to tsconfig.json (optional, uses the same path as initialization)
   */
  public refresh(tsconfigPath?: string): void {
    if (tsconfigPath) {
      this.initializeProgram(tsconfigPath);
    } else {
      // Re-create the program with the same options but fresh file content
      const rootFileNames = this.program.getRootFileNames();
      this.program = ts.createProgram(rootFileNames, this.compilerOptions, this.host, this.program);
    }
  }

  private getDiagnosticCategory(category: ts.DiagnosticCategory): string {
    switch (category) {
      case ts.DiagnosticCategory.Error:
        return 'error';
      case ts.DiagnosticCategory.Warning:
        return 'warning';
      case ts.DiagnosticCategory.Suggestion:
        return 'suggestion';
      case ts.DiagnosticCategory.Message:
        return 'message';
      default:
        return 'unknown';
    }
  }
}

export class ErrorCounter {
  private tscProcess: ChildProcessWithoutNullStreams
  private tsconfigCopyPath: string
  private originalConfig: any
  private checker: TypeScriptChecker;

  // tsconfigPath is the path to the tsconfig.json file, should probably be the root or "alt" config
  constructor(private tsconfigPath: string) {
    this.checker = new TypeScriptChecker(this.tsconfigPath);
  }

  public start(): void {
    this.tsconfigCopyPath = this.tsconfigPath + `copy${Math.floor(Math.random() * (1 << 16))}.json`

    // Make a copy of tsconfig because we're going to keep modifying it.
    execSync(`cp ${this.tsconfigPath} ${this.tsconfigCopyPath}`)
    this.originalConfig = JSON.parse(fs.readFileSync(this.tsconfigCopyPath).toString())

    // Opens TypeScript in watch mode so that it can (hopefully) incrementally
    // compile as we add and remove files from the whitelist.
    this.tscProcess = spawn('node_modules/typescript/bin/tsc', ['-p', this.tsconfigCopyPath, '--watch', '--noEmit'])
  }

  public end(): void {
    this.tscProcess.kill()
    execSync(`rm ${this.tsconfigCopyPath}`)
  }

  public async tryCheckingFile(relativeFilePath: string): Promise<number> {
    const result = this.checker.checkSourceFile(relativeFilePath);

    if (result.hasErrors) {
      if (process.env.DEBUG) {
        for (const error of result.errors) {
          console.log('found tsc error', 'relativeFilePath', relativeFilePath, 'error.message', error.message);
        }
      }

      return result.errors.length
    }

    return 0;
  }
}
