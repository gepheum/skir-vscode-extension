import type {
  Module,
  MutableModule,
  Result,
  SkirError,
  Token,
} from "skir-internal";
import {
  checkCompatibility,
  getTokenForBreakingChange,
} from "skir/dist/compatibility_checker.js";
import { SkirConfig } from "skir/dist/config";
import { parseSkirConfig, SkirConfigError } from "skir/dist/config_parser.js";
import { findDefinition } from "skir/dist/definition_finder.js";
import { getShortMessageForBreakingChange } from "skir/dist/error_renderer.js";
import { formatModule } from "skir/dist/formatter.js";
import { ModuleParser, ModuleSet } from "skir/dist/module_set.js";
import { type Packages } from "skir/dist/package_types.js";
import { parseModule } from "skir/dist/parser.js";
import { snapshotFileContentToModuleSet } from "skir/dist/snapshotter.js";
import { tokenizeModule } from "skir/dist/tokenizer.js";
import * as vscode from "vscode";

// Formatting provider for Skir files
class SkirFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
  ): vscode.TextEdit[] {
    const unformattedCode = document.getText();
    const tokens = tokenizeModule(unformattedCode, "");
    if (tokens.errors.length) {
      return [];
    }
    // Make sure no parsing errors exist before formatting
    if (parseModule(tokens.result, "lenient").errors.length) {
      return [];
    }

    const textEdits = formatModule(tokens.result).textEdits;
    return textEdits.map((edit) =>
      vscode.TextEdit.replace(
        new vscode.Range(
          document.positionAt(edit.oldStart),
          document.positionAt(edit.oldEnd),
        ),
        edit.newText,
      ),
    );
  }

  dispose(): void {}
}

export class SkirLanguageExtension {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("skir");
  }

  setFileContent(uri: string, content: FileContent | undefined): void {
    const fileType = getFileType(uri);
    if (fileType) {
      // Clear diagnostics for this file
      this.diagnosticCollection.delete(vscode.Uri.parse(uri));
    }
    switch (fileType) {
      case "skir.yml": {
        if (content) {
          const skirConfigResult = parseSkirConfig(content.content);
          if (skirConfigResult.errors.length <= 0) {
            // The skir config is valid
            const skirConfig: SkirConfigBundle = {
              config: skirConfigResult.skirConfig!,
              yamlContent: content,
            };
            const oldWorkspace = this.workspaces.get(uri);
            if (oldWorkspace) {
              oldWorkspace.skirConfig = skirConfig;
              // The status of whether dependencies are in sync may have changed
              this.setDependencies(oldWorkspace, oldWorkspace.dependencies);
            } else {
              // Create a new workspace and reassign modules
              const workspace = new Workspace(
                uri.replace(/skir\.yml$/, ""),
                skirConfig,
                this.diagnosticCollection,
              );
              this.workspaces.set(uri, workspace);
              this.reassignModulesToWorkspaces();
            }
          } else {
            // The skir config is not valid
            const diagnostics = configErrorsToDiagnostics(
              skirConfigResult.errors,
            );
            this.diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics);
          }
        } else {
          // Delete the workspace
          if (this.workspaces.delete(uri)) {
            this.reassignModulesToWorkspaces();
          }
        }
        break;
      }
      case "*.skir": {
        // Cancel the `scheduledSetFileContent` if it exists
        const timeout = this.uriToTimeout.get(uri);
        if (timeout) {
          clearTimeout(timeout);
          this.uriToTimeout.delete(uri);
        }
        const moduleBundle = this.moduleBundles.get(uri);
        if (moduleBundle) {
          // Remove the module from its workspace
          Workspace.removeModule(moduleBundle);
          // Remove the module bundle from the map
          this.moduleBundles.delete(uri);
        }
        if (content) {
          const moduleBundle = this.parseSkirModule(content, uri);
          const moduleWorkspace = this.findModuleWorkspace(moduleBundle);
          this.moduleBundles.set(uri, moduleBundle);
          if (moduleWorkspace) {
            Workspace.addModule(moduleBundle, moduleWorkspace);
          }
        }
        break;
      }
      case "skir-snapshot.json": {
        const workspaceUri = uri.replace(/\/skir-snapshot\.json$/, "/skir.yml");
        const workspace = this.workspaces.get(workspaceUri);
        if (workspace) {
          workspace.lastSnapshot = undefined;
          workspace.scheduleResolution();
        }
        if (content) {
          // Find the workspace for this snapshot
          if (workspace) {
            const moduleSetOrError = snapshotFileContentToModuleSet(
              content.content,
            );
            if (moduleSetOrError instanceof ModuleSet) {
              workspace.lastSnapshot = {
                moduleSet: moduleSetOrError,
                jsonContent: content,
              };
              workspace.scheduleResolution();
            } else {
              console.error(`Failed to parse snapshot file ${uri}`);
            }
          } else {
            console.error(`No workspace found for snapshot file ${uri}`);
          }
        }
        break;
      }
      case "dependencies.json": {
        const workspaceUri = uri.replace(
          /\/skir-external\/dependencies\.json$/,
          "/skir.yml",
        );
        const workspace = this.workspaces.get(workspaceUri);
        if (workspace) {
          this.setDependencies(workspace, undefined);
        }
        if (content) {
          const workspaceUri = uri.replace(
            /\/skir-external\/dependencies\.json$/,
            "/skir.yml",
          );
          const workspace = this.workspaces.get(workspaceUri);
          if (workspace) {
            let packages: Packages;
            try {
              packages = JSON.parse(content.content) as Packages;
            } catch (error) {
              console.error(`Failed to parse dependencies file ${uri}:`, error);
              break;
            }
            const moduleMap = new Map<string, string>();
            for (const pkg of Object.values(packages)) {
              for (const [modulePath, content] of Object.entries(pkg.modules)) {
                moduleMap.set(modulePath, content);
              }
            }
            const moduleSet = ModuleSet.fromMap(moduleMap);
            this.setDependencies(workspace, {
              moduleSet: moduleSet,
              jsonContent: content,
              packages: packages,
            });
          } else {
            console.error(`No workspace found for dependencies file ${uri}`);
          }
        }
        break;
      }
      default: {
        const _: null = fileType;
      }
    }
  }

  getFileContent(uri: string): FileContent | undefined {
    const { workspaces, moduleBundles } = this;
    const fileType = getFileType(uri);
    switch (fileType) {
      case "dependencies.json": {
        const workspaceUri = uri.replace(
          /\/skir-external\/dependencies\.json$/,
          "/skir.yml",
        );
        return workspaces.get(workspaceUri)?.dependencies?.jsonContent;
      }
      case "*.skir": {
        return moduleBundles.get(uri)?.content;
      }
      case "skir-snapshot.json": {
        const workspaceUri = uri.replace(/\/skir-snapshot\.json$/, "/skir.yml");
        return workspaces.get(workspaceUri)?.lastSnapshot?.jsonContent;
      }
      case "skir.yml": {
        return workspaces.get(uri)?.skirConfig.yamlContent;
      }
      case null: {
        return undefined;
      }
      default: {
        const _: never = fileType;
      }
    }
  }

  scheduleSetFileContent(uri: string, document: vscode.TextDocument): void {
    const oldTimeout = this.uriToTimeout.get(uri);
    if (oldTimeout) {
      clearTimeout(oldTimeout);
    }
    const delayMilliseconds = 100;
    const timeout = setTimeout(() => {
      this.uriToTimeout.delete(uri);
      try {
        this.setFileContent(uri, {
          content: document.getText(),
          lastModified: Date.now(),
        });
      } catch (error) {
        console.error(`Error setting file content for ${uri}:`, error);
      }
    }, delayMilliseconds);
    this.uriToTimeout.set(uri, timeout);
  }

  findDefinitionAt(uri: string, position: number): vscode.Location | null {
    console.log(`Finding definition at ${uri}:${position}`);
    const { moduleBundles } = this;
    const moduleBundle = moduleBundles.get(uri);
    if (!moduleBundle) {
      console.log(`Module bundle not found: ${uri}.`);
      return null;
    }
    const { moduleWorkspace } = moduleBundle;
    if (!moduleWorkspace) {
      console.log(`No workspace for ${uri}.`);
      return null;
    }
    const { workspace } = moduleWorkspace;
    workspace.revolveNow();

    const module = moduleBundle.astTree.result;
    if (!module) {
      console.log(`Module has errors: ${uri}.`);
      return null;
    }
    const definitionMatch = findDefinition(module, position);
    if (!definitionMatch) {
      console.log(`Definition not found: ${uri}.`);
      return null;
    }

    // Convert DefinitionMatch to vscode.Location
    const { modulePath } = definitionMatch;
    const targetUri = workspace.modulePathToUri(modulePath);
    const target = moduleBundles.get(targetUri);
    if (!target) {
      console.warn(
        `Module ${targetUri} not found, skipping definition lookup.`,
      );
      return null;
    }
    const { positionTracker } = target;
    const targetPosition = positionTracker.getPosition(
      definitionMatch.position,
    );
    console.log(
      `Found definition at ${targetUri}:${targetPosition.line}:${targetPosition.column}`,
    );
    return new vscode.Location(
      vscode.Uri.parse(targetUri),
      new vscode.Position(targetPosition.line, targetPosition.column),
    );
  }

  /** Get module bundle for a given URI (used by DocumentLinkProvider) */
  getModuleBundle(uri: string): ModuleBundle | undefined {
    return this.moduleBundles.get(uri);
  }

  private setDependencies(
    workspace: Workspace,
    dependencies: Dependencies | undefined,
  ): void {
    const { oldModules, newModules } = workspace.setDependencies(dependencies);
    for (const oldModule of oldModules) {
      this.moduleBundles.delete(oldModule.uri);
    }
    for (const newModule of newModules) {
      this.moduleBundles.set(newModule.uri, newModule);
    }
  }

  private reassignModulesToWorkspaces(): void {
    if (this.reassigneModulesTimeout) {
      // Already scheduled, do nothing.
      return;
    }
    this.reassigneModulesTimeout = setTimeout(() => {
      console.log("Reassigning modules to workspaces...");
      for (const moduleBundle of this.moduleBundles.values()) {
        if (moduleBundle.isExternalDependency) {
          continue;
        }
        Workspace.removeModule(moduleBundle);
        const newWorkspace = this.findModuleWorkspace(moduleBundle);
        if (newWorkspace) {
          Workspace.addModule(moduleBundle, newWorkspace);
        }
      }
      for (const workspace of this.workspaces.values()) {
        workspace.scheduleResolution();
      }
      this.reassigneModulesTimeout = undefined;
    });
  }

  private parseSkirModule(content: FileContent, uri: string): ModuleBundle {
    let astTree: Result<Module | null>;
    {
      const tokens = tokenizeModule(content.content, uri);
      if (tokens.errors.length !== 0) {
        astTree = {
          result: null,
          errors: tokens.errors,
        };
      } else {
        astTree = parseModule(tokens.result, "lenient");
      }
    }
    const positionTracker = new PositionTracker(content.content);
    const isExternalDependency = false;
    return { uri, isExternalDependency, content, positionTracker, astTree };
  }

  /** Finds the workspace which contains the given module URI. */
  private findModuleWorkspace(
    moduleBundle: ModuleBundle,
  ): ModuleWorkspace | undefined {
    let match: Workspace | undefined;
    const leftIsBetter = (
      left: Workspace,
      right: Workspace | undefined,
    ): boolean => {
      if (right === undefined || left.srcUri.length < right.srcUri.length) {
        return true;
      }
      if (left.srcUri.length === right.srcUri.length) {
        // Completely arbitrary, just to have a consistent order.
        return left.srcUri < right.srcUri;
      }
      return false;
    };
    const moduleUri = moduleBundle.uri;
    for (const workspace of this.workspaces.values()) {
      const { rootUri } = workspace;
      if (moduleUri.startsWith(rootUri) && leftIsBetter(workspace, match)) {
        match = workspace;
      }
    }
    if (match) {
      const { srcUri, externalUri } = match;
      if (moduleUri.startsWith(srcUri)) {
        return {
          workspace: match,
          modulePath: match.moduleUriToPath(moduleUri),
        };
      } else if (moduleUri.startsWith(externalUri)) {
        // The module is in the skir-external/ directory of a workspace: skip it.
        return undefined;
      }
    }
    // Raise a warning and possible lexical/parsing errors.
    const warningMessage = match
      ? "Not in skir-src directory"
      : "No skir workspace found; add a skir.yml file";
    const warning = new vscode.Diagnostic(
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      warningMessage,
      vscode.DiagnosticSeverity.Warning,
    );
    const errors = moduleBundle.astTree.errors.filter(
      (error) => !error.errorIsInOtherModule,
    );
    const diagnostics = [warning].concat(
      errorsToDiagnostics(errors, moduleBundle),
    );
    this.diagnosticCollection.set(vscode.Uri.parse(moduleUri), diagnostics);
    return undefined;
  }

  /** Removes all the files which seem to no longer exist on the filesystem. */
  async runGarbageCollection(): Promise<void> {
    const uris = Array.from(this.moduleBundles.keys());
    for (const workspace of this.workspaces.values()) {
      uris.push(workspace.skirYmlUri);
      if (workspace.lastSnapshot) {
        uris.push(workspace.rootUri + "skir-snapshot.json");
      }
      if (workspace.dependencies) {
        uris.push(workspace.rootUri + "skir-external/dependencies.json");
      }
    }
    for (const uri of uris) {
      let isFile = false;
      try {
        const stat = await vscode.workspace.fs
          .stat(vscode.Uri.parse(uri))
          .then();
        isFile = stat.type === vscode.FileType.File;
      } catch (_error) {
        // Do nothing, the file does not exist.
      }
      if (!isFile) {
        console.log(`File no longer exists, removing: ${uri}`);
        this.setFileContent(uri, undefined);
      }
    }
  }

  private reassigneModulesTimeout?: NodeJS.Timeout;
  private readonly moduleBundles = new Map<string, ModuleBundle>(); // key: file URI
  private readonly workspaces = new Map<string, Workspace>(); // key: skir.yml file URI
  private readonly uriToTimeout = new Map<string, NodeJS.Timeout>();
}

function getFileType(
  uri: string,
): "skir.yml" | "skir-snapshot.json" | "*.skir" | "dependencies.json" | null {
  if (uri.endsWith("/skir-external/dependencies.json")) {
    return "dependencies.json";
  } else if (uri.includes("/skir-external/")) {
    // Ignore other files in skir-external/
    return null;
  } else if (uri.endsWith("/skir.yml")) {
    return "skir.yml";
  } else if (uri.endsWith("/skir-snapshot.json")) {
    return "skir-snapshot.json";
  } else if (uri.endsWith(".skir")) {
    return "*.skir";
  } else {
    return null;
  }
}

interface ModuleWorkspace {
  readonly workspace: Workspace;
  readonly modulePath: string;
}

interface FileContent {
  content: string;
  /** Mtime */
  lastModified: number;
}

interface ModuleBundle {
  readonly uri: string;
  readonly isExternalDependency: boolean;
  readonly content: FileContent;
  readonly positionTracker: PositionTracker;
  readonly astTree: Result<Module | null>;
  moduleWorkspace?: ModuleWorkspace;
}

interface Dependencies {
  readonly moduleSet: ModuleSet;
  readonly jsonContent: FileContent;
  readonly packages: Packages;
}

interface Snapshot {
  readonly moduleSet: ModuleSet;
  readonly jsonContent: FileContent;
}

interface SkirConfigBundle {
  readonly config: SkirConfig;
  yamlContent: FileContent;
}

class Workspace implements ModuleParser {
  constructor(
    readonly rootUri: string,
    public skirConfig: SkirConfigBundle,
    private diagnosticCollection: vscode.DiagnosticCollection,
  ) {}

  readonly srcUri = this.rootUri + "skir-src/";
  readonly externalUri = this.rootUri + "skir-external/";
  readonly skirYmlUri = this.rootUri + "skir.yml";
  // key: module path; does not include dependency modules
  private readonly modules = new Map<string, ModuleBundle>();
  private scheduledResolution?: Readonly<{
    timeout: NodeJS.Timeout;
    promise: Promise<void>;
    callback: () => void;
  }>;
  lastSnapshot?: Snapshot;
  private privateDependencies?: Dependencies;
  private readonly dependencyModules = new Map<string, ModuleBundle>();

  static addModule(
    moduleBundle: ModuleBundle,
    moduleWorkspace: ModuleWorkspace,
  ): void {
    // If the module was already in a workspace, remove it from the old workspace.
    Workspace.removeModule(moduleBundle);
    const { workspace } = moduleWorkspace;
    moduleBundle.moduleWorkspace = moduleWorkspace;
    workspace.modules.set(moduleWorkspace.modulePath, moduleBundle);
    workspace.scheduleResolution();
  }

  static removeModule(moduleBundle: ModuleBundle): void {
    const { moduleWorkspace } = moduleBundle;
    if (!moduleWorkspace) {
      return;
    }
    const { workspace } = moduleWorkspace;
    workspace.modules.delete(moduleWorkspace.modulePath);
    moduleBundle.moduleWorkspace = undefined;
    workspace.scheduleResolution();
  }

  get dependencies(): Dependencies | undefined {
    return this.privateDependencies;
  }

  setDependencies(dependencies: Dependencies | undefined): {
    readonly oldModules: readonly ModuleBundle[];
    readonly newModules: readonly ModuleBundle[];
  } {
    const oldDependencies = this.dependencies;
    if (oldDependencies) {
      // Remove old diagnostics
      const moduleUris = new Set<string>();
      for (const error of oldDependencies.moduleSet.errors) {
        const { moduleUri } = this.getModuleForToken(error.token);
        moduleUris.add(moduleUri);
      }
      for (const moduleUri of moduleUris) {
        this.diagnosticCollection.delete(vscode.Uri.parse(moduleUri));
      }
    }
    const oldModules = [...this.dependencyModules.values()];
    this.dependencyModules.clear();
    this.privateDependencies = dependencies;
    const newModules: ModuleBundle[] = [];
    let dependenciesInSync: boolean;
    if (dependencies) {
      const modulePathToErrors = new Map<string, SkirError[]>();
      for (const error of dependencies.moduleSet.errors) {
        if (error.errorIsInOtherModule) {
          continue;
        }
        const { modulePath } = this.getModuleForToken(error.token);
        const diagnostics = modulePathToErrors.get(modulePath) || [];
        if (diagnostics.length <= 0) {
          modulePathToErrors.set(modulePath, diagnostics);
        }
        diagnostics.push(error);
      }
      for (const [
        modulePath,
        module,
      ] of dependencies.moduleSet.modules.entries()) {
        const moduleUri = this.modulePathToUri(modulePath);
        const content = module.result?.sourceCode ?? "";
        const positionTracker = new PositionTracker(content);
        const moduleBundle: ModuleBundle = {
          uri: moduleUri,
          isExternalDependency: true,
          content: {
            content: content,
            lastModified: 0,
          },
          positionTracker: positionTracker,
          astTree: module,
          moduleWorkspace: {
            workspace: this,
            modulePath,
          },
        };
        this.dependencyModules.set(modulePath, moduleBundle);
        newModules.push(moduleBundle);
        const errors = modulePathToErrors.get(modulePath) || [];
        const diagnostics = errorsToDiagnostics(errors, moduleBundle);
        this.diagnosticCollection.set(vscode.Uri.parse(moduleUri), diagnostics);
      }
      // Verify that the dependencies are in sync with the skir config
      dependenciesInSync = Object.entries(
        this.skirConfig.config.dependencies,
      ).every(
        ([packageId, version]) =>
          dependencies.packages[packageId]?.version === version,
      );
    } else {
      dependenciesInSync = true;
    }
    this.diagnosticCollection.set(
      vscode.Uri.parse(this.skirYmlUri),
      dependenciesInSync
        ? []
        : [
            new vscode.Diagnostic(
              new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 0),
              ),
              "Dependencies out of sync; run npx skir gen",
              vscode.DiagnosticSeverity.Warning,
            ),
          ],
    );
    this.scheduleResolution();
    return { oldModules, newModules };
  }

  parseModule(modulePath: string): Result<MutableModule | null> {
    const moduleBundle = this.modules.get(modulePath);
    if (!moduleBundle) {
      return {
        result: null,
        errors: [],
      };
    }
    return moduleBundle.astTree;
  }

  scheduleResolution(): void {
    if (this.scheduledResolution) {
      clearTimeout(this.scheduledResolution.timeout);
    }
    const delayMilliseconds = 500;
    const timeout = setTimeout(() => {
      this.resolve();
    }, delayMilliseconds);
    const scheduledResolution = {
      timeout,
      promise: Promise.resolve(),
      callback: (() => {
        throw new Error("callback not set");
      }) as () => void,
    };
    scheduledResolution.promise = new Promise<void>((resolve) => {
      scheduledResolution.callback = resolve;
    });
    this.scheduledResolution = scheduledResolution;
  }

  get resolutionDone(): Promise<void> {
    if (this.scheduledResolution) {
      return this.scheduledResolution.promise;
    }
    return Promise.resolve();
  }

  /** Force a resolution to happen *now*, cancel any scheduled resolution. */
  revolveNow(): void {
    if (this.scheduledResolution) {
      clearTimeout(this.scheduledResolution.timeout);
    }
    this.resolve();
  }

  /**
   * Synchronously performs type resolution (and validation).
   * Stores the errors in every module bundle.
   */
  private resolve(): void {
    const { privateDependencies: dependencies, lastSnapshot, modules } = this;
    try {
      const moduleSet = new ModuleSet(this);
      if (dependencies) {
        moduleSet.mergeFrom(dependencies.moduleSet);
      }
      let anyError = false;
      for (const [modulePath, moduleBundle] of modules.entries()) {
        const parseResult = moduleSet.parseAndResolve(modulePath);
        const errors = parseResult.errors.filter(
          (error) => !error.errorIsInOtherModule,
        );
        anyError = anyError || errors.length > 0;
        this.updateDiagnostics(moduleBundle, errors);
      }
      if (anyError || !lastSnapshot) {
        return;
      }
      // Look for breaking changes since the last snapshot.
      const breakingChanges = checkCompatibility({
        before: lastSnapshot.moduleSet,
        after: moduleSet,
      });
      const moduleUriToDiagnostics = new Map<string, vscode.Diagnostic[]>();
      for (const breakingChange of breakingChanges) {
        const token = getTokenForBreakingChange(breakingChange);
        if (!token) {
          // Some breaking change errors can't be tied to a specific token in
          // the new snapshot. We skip them.
          continue;
        }
        const { modulePath, moduleUri } = this.getModuleForToken(token);
        const module = this.getModule(modulePath);
        if (!module) {
          // Should not happen.
          console.error(`Module not found: ${moduleUri}`);
          continue;
        }
        const { positionTracker } = module!;
        const range = getRangeForToken(token, positionTracker);
        const message =
          "Breaking change: " +
          getShortMessageForBreakingChange(
            breakingChange,
            lastSnapshot.moduleSet,
          );

        const diagnostics = moduleUriToDiagnostics.get(moduleUri) || [];
        if (diagnostics.length <= 0) {
          moduleUriToDiagnostics.set(moduleUri, diagnostics);
        }
        diagnostics.push(
          new vscode.Diagnostic(
            range,
            message,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
      for (const [moduleUri, diagnostics] of moduleUriToDiagnostics.entries()) {
        const uri = vscode.Uri.parse(moduleUri);
        this.diagnosticCollection.set(uri, diagnostics);
      }
    } catch (error) {
      console.error("Error during resolution:", error);
    } finally {
      this.scheduledResolution?.callback();
      this.scheduledResolution = undefined;
    }
  }

  private updateDiagnostics(
    moduleBundle: ModuleBundle,
    errors: readonly SkirError[],
  ): void {
    const { uri } = moduleBundle;
    const diagnostics = errorsToDiagnostics(errors, moduleBundle);
    this.diagnosticCollection.set(vscode.Uri.parse(uri), diagnostics);
  }

  private getModule(modulePath: string): ModuleBundle | undefined {
    return (
      this.modules.get(modulePath) ?? this.dependencyModules.get(modulePath)
    );
  }

  private getModuleForToken(token: Token): {
    readonly modulePath: string;
    readonly moduleUri: string;
  } {
    const modulePathOrUri = token.line.modulePath;
    if (modulePathOrUri.startsWith("@")) {
      return {
        modulePath: modulePathOrUri,
        moduleUri: this.modulePathToUri(modulePathOrUri),
      };
    } else {
      return {
        modulePath: this.moduleUriToPath(modulePathOrUri),
        moduleUri: token.line.modulePath,
      };
    }
  }

  moduleUriToPath(uri: string): string {
    if (uri.startsWith(this.srcUri)) {
      return uri
        .substring(this.srcUri.length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
    } else if (uri.startsWith(this.externalUri)) {
      return uri
        .substring(this.externalUri.length)
        .replace(/\.readonly.skir$/, ".skir")
        .split("/")
        .map(decodeURIComponent)
        .join("/");
    } else {
      throw new Error(`Invalid module URI: ${uri}`);
    }
  }

  modulePathToUri(modulePath: string): string {
    if (modulePath.startsWith(this.rootUri)) {
      // Already a URI
      return modulePath;
    } else if (modulePath.startsWith("@")) {
      return (
        this.externalUri +
        modulePath
          .replace(/\.skir$/, ".readonly.skir")
          .split("/")
          .map(encodeURIComponent)
          .join("/")
      );
    } else {
      return (
        this.srcUri + modulePath.split("/").map(encodeURIComponent).join("/")
      );
    }
  }
}

const skirLanguageExtension = new SkirLanguageExtension();

class SkirDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly skirLanguageExtension: SkirLanguageExtension) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location | null {
    try {
      const offset = document.offsetAt(position);
      const uri = document.uri.toString();
      const content = document.getText();

      this.skirLanguageExtension.setFileContent(uri, {
        content,
        lastModified: Date.now(),
      });
      return this.skirLanguageExtension.findDefinitionAt(uri, offset);
    } catch (error) {
      console.error(`Error finding definition at ${position}:`, error);
      throw error;
    }
  }
}

class FileContentManager {
  private readonly documentChangeListener: vscode.Disposable;
  private disposed = false;

  constructor(private readonly skirLanguageExtension: SkirLanguageExtension) {
    // Listen for document changes (unsaved edits)
    this.documentChangeListener = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        const uri = event.document.uri;
        const uriString = uri.toString();

        // Only supported file types
        if (getFileType(uriString)) {
          this.skirLanguageExtension.scheduleSetFileContent(
            uriString,
            event.document,
          );
        }
      },
    );

    this.scheduleScanLoop();
  }

  async runScan(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return;
    }

    for (const folder of workspaceFolders) {
      const files = (
        await vscode.workspace.findFiles(
          new vscode.RelativePattern(
            folder,
            "**/{skir.yml,*.skir,skir-snapshot.json}",
          ),
        )
      ).concat(
        await vscode.workspace.findFiles(
          new vscode.RelativePattern(
            folder,
            "**/skir-external/dependencies.json",
          ),
        ),
      );
      // Make sure skir.yml files are processed first
      const uriToTier = (uri: string): number => {
        if (uri.endsWith("/skir.yml")) {
          return 1;
        } else if (uri.endsWith("/dependencies.json")) {
          return 2;
        } else {
          return 3;
        }
      };
      files.sort((a, b) => uriToTier(a.toString()) - uriToTier(b.toString()));
      for (const uri of files) {
        const uriString = uri.toString();
        const oldContent = this.skirLanguageExtension.getFileContent(uriString);
        let mtime: number | undefined;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          mtime = stat.mtime;
        } catch (error) {
          console.error(`Failed to stat file ${uri}:`, error);
          continue;
        }
        if (
          oldContent &&
          oldContent.lastModified &&
          oldContent.lastModified >= mtime
        ) {
          // No need to read the file again, it hasn't changed.
          continue;
        }
        let content: string;
        try {
          const text = await vscode.workspace.fs.readFile(uri);
          content = Buffer.from(text).toString("utf-8");
        } catch (error) {
          console.error(`Failed to read file ${uri}:`, error);
          continue;
        }
        if (oldContent && oldContent.content === content) {
          // No need to update, content is the same.
          continue;
        }
        this.skirLanguageExtension.setFileContent(uriString, {
          content,
          lastModified: mtime,
        });
      }
    }
  }

  /**
   * Starts a loop that periodically runs garbage collection on all files stored
   * in `skirLanguageExtension` and then runs a scan on the filesystem.
   */
  scheduleScanLoop(): void {
    const delayMilliseconds = 5000; // 5 seconds
    setTimeout(() => this.runScanLoopIteration(), delayMilliseconds);
  }

  private async runScanLoopIteration(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.skirLanguageExtension.runGarbageCollection();
      await this.runScan();
    } catch (error) {
      console.error("Error during scheduled scan:", error);
    }
    this.scheduleScanLoop(); // Reschedule the next scan
  }

  dispose(): void {
    this.documentChangeListener.dispose();
    this.disposed = true;
  }
}

/** Gets the (line number, column number) for a given offset. */
class PositionTracker {
  private readonly lineBreaks: number[];

  constructor(private readonly text: string) {
    this.text = text;
    this.lineBreaks = PositionTracker.findLineBreaks(text);
  }

  private static findLineBreaks(text: string): number[] {
    const breaks: number[] = [0]; // Start of first line
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === "\n") {
        breaks.push(i + 1);
      } else if (char === "\r") {
        // Handle \r\n (don't double-count)
        if (i + 1 < text.length && text[i + 1] === "\n") {
          breaks.push(i + 2);
          i++; // Skip the \n
        } else {
          // Standalone \r
          breaks.push(i + 1);
        }
      }
    }
    return breaks;
  }

  getPosition(offset: number): { line: number; column: number } {
    if (offset < 0 || offset > this.text.length) {
      throw new Error(
        `Offset ${offset} is out of bounds (text length: ${this.text.length})`,
      );
    }

    // Binary search to find the line containing this offset
    let left = 0;
    let right = this.lineBreaks.length - 1;
    let lineIndex = 0;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);

      if (this.lineBreaks[mid] <= offset) {
        lineIndex = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    // If we're beyond the last line break, check if there's a next one
    if (
      lineIndex < this.lineBreaks.length - 1 &&
      offset >= this.lineBreaks[lineIndex + 1]
    ) {
      lineIndex++;
    }

    const lineStart = this.lineBreaks[lineIndex];
    const column = offset - lineStart;

    return { line: lineIndex, column };
  }
}

function errorsToDiagnostics(
  errors: readonly SkirError[],
  moduleBundle: ModuleBundle,
): vscode.Diagnostic[] {
  const { positionTracker } = moduleBundle;
  return errors.map(
    (error) =>
      new vscode.Diagnostic(
        getRangeForToken(error.token, positionTracker),
        error.message || `expected: ${error.expected}`,
        vscode.DiagnosticSeverity.Error,
      ),
  );
}

function configErrorsToDiagnostics(
  errors: readonly SkirConfigError[],
): vscode.Diagnostic[] {
  const zeroRange = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(0, 0),
  );
  return errors.map(
    (e) =>
      new vscode.Diagnostic(
        e.range
          ? new vscode.Range(
              new vscode.Position(
                e.range.start.lineNumber - 1,
                e.range.start.colNumber - 1,
              ),
              new vscode.Position(
                e.range.end.lineNumber - 1,
                e.range.end.colNumber - 1,
              ),
            )
          : zeroRange,
        e.message,
        vscode.DiagnosticSeverity.Error,
      ),
  );
}

function getRangeForToken(
  token: Token,
  positionTracker: PositionTracker,
): vscode.Range {
  const startPos = positionTracker.getPosition(token.position);
  const endPos = positionTracker.getPosition(
    token.position + token.text.length,
  );
  return new vscode.Range(
    new vscode.Position(startPos.line, startPos.column),
    new vscode.Position(endPos.line, endPos.column),
  );
}

const fileContentManager = new FileContentManager(skirLanguageExtension);

// VS Code extension activation
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("Skir Language Support extension is now active");

  // Perform initial scan of workspace
  await fileContentManager.runScan();

  // Register definition provider for skir files
  const definitionProvider = new SkirDefinitionProvider(skirLanguageExtension);
  const definitionDisposable = vscode.languages.registerDefinitionProvider(
    { scheme: "file", language: "skir" },
    definitionProvider,
  );

  // Register document formatting provider for skir files
  const formattingProvider = new SkirFormattingProvider();
  const formattingDisposable =
    vscode.languages.registerDocumentFormattingEditProvider(
      { scheme: "file", language: "skir" },
      formattingProvider,
    );

  // Register format on save handler
  const formatOnSaveDisposable = vscode.workspace.onWillSaveTextDocument(
    async (event) => {
      if (event.document.languageId === "skir") {
        // Format the document before saving
        const edits = formattingProvider.provideDocumentFormattingEdits(
          event.document,
        );

        if (edits && edits.length > 0) {
          const workspaceEdit = new vscode.WorkspaceEdit();
          workspaceEdit.set(event.document.uri, edits);
          event.waitUntil(vscode.workspace.applyEdit(workspaceEdit));
        }
      }
    },
  );

  // Add to subscriptions for proper cleanup
  context.subscriptions.push(
    fileContentManager,
    definitionDisposable,
    formattingProvider,
    formattingDisposable,
    formatOnSaveDisposable,
  );
}

export function deactivate(): void {
  fileContentManager.dispose();
}
