import * as path from "path";
import * as fs from "fs";

import {
    workspace, window, commands, ExtensionContext, Disposable, TextDocumentSaveReason, TextEditor
} from "vscode";

import {
    LanguageClient, LanguageClientOptions, ServerOptions, TextEdit,
    State as ServerState,
    ErrorHandler, ErrorAction, CloseAction,
    TransportKind, RevealOutputChannelOn
} from "vscode-languageclient";

import { LogTraceNotification } from "vscode-jsonrpc";

import {
    SUPPORT_LANGUAGES,
    StatusNotification, NoConfigNotification, NoLibraryNotification, ExitNotification, AllFixesRequest,
    StartProgressNotification, StopProgressNotification
} from "./types";

import { Status, StatusBar } from "./status";

export interface ExtensionInternal {
    client: LanguageClient;
    statusBar: StatusBar;
    onAllFixesComplete(fn: (te: TextEditor, edits: TextEdit[], ok: boolean) => void);
}

export function activate(context: ExtensionContext): ExtensionInternal {
    let client = newClient(context);
    let statusBar = new StatusBar(SUPPORT_LANGUAGES);
    client.onReady().then(() => {
        client.onDidChangeState(event => {
            statusBar.serverRunning = event.newState === ServerState.Running;
        });
        client.onNotification(StatusNotification.type, (p: StatusNotification.StatusParams) => {
            statusBar.status = to(p.status);
            if (p.message || p.cause) {
                statusBar.status.log(client, p.message, p.cause);
            }
        });
        client.onNotification(NoConfigNotification.type, () => {
            statusBar.status = Status.WARN;
            statusBar.status.log(client, `
No textlint configuration (e.g .textlintrc) found.
File will not be validated. Consider running the 'Create .textlintrc file' command.`);
        });
        client.onNotification(NoLibraryNotification.type, () => {
            statusBar.status = Status.ERROR;
            statusBar.status.log(client, `
Failed to load the textlint library.
To use textlint in this workspace please install textlint using \'npm install textlint\' or globally using \'npm install -g textlint\'.
You need to reopen the workspace after installing textlint.`);
        });
        client.onNotification(StartProgressNotification.type, () => statusBar.startProgress());
        client.onNotification(StopProgressNotification.type, () => statusBar.stopProgress());

        client.onNotification(LogTraceNotification.type, p => client.info(p.message, p.verbose));
        let changeConfigHandler = () => configureAutoFixOnSave(client);
        workspace.onDidChangeConfiguration(changeConfigHandler);
        changeConfigHandler();

    });
    context.subscriptions.push(
        commands.registerCommand("textlint.createConfig", createConfig),
        commands.registerCommand("textlint.applyTextEdits", makeApplyFixFn(client)),
        commands.registerCommand("textlint.executeAutofix", makeAutoFixFn(client)),
        commands.registerCommand("textlint.showOutputChannel", () => client.outputChannel.show()),
        client.start(),
        statusBar
    );
    // for testing purpse
    return {
        client,
        statusBar,
        onAllFixesComplete
    };
}

function newClient(context: ExtensionContext): LanguageClient {
    let module = require.resolve("@taichi/vscode-textlint-server");
    let debugOptions = { execArgv: ["--nolazy", "--inspect=6004"] };

    let serverOptions: ServerOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: { module, transport: TransportKind.ipc, options: debugOptions }
    };

    let defaultErrorHandler: ErrorHandler;
    let languages = SUPPORT_LANGUAGES.map(id => {
        return { language: id, scheme: 'file' };
    });
    let serverCalledProcessExit = false;
    let clientOptions: LanguageClientOptions = {
        documentSelector: languages,
        diagnosticCollectionName: "textlint",
        revealOutputChannelOn: RevealOutputChannelOn.Error,
        synchronize: {
            configurationSection: "textlint",
            fileEvents: [
                workspace.createFileSystemWatcher("**/package.json"),
                workspace.createFileSystemWatcher('**/.textlintrc'),
                workspace.createFileSystemWatcher('**/.textlintrc.{js,json,yml,yaml}')
            ]
        },
        initializationOptions: () => {
            return {
                configPath: getConfig("configPath"),
                nodePath: getConfig("nodePath"),
                run: getConfig("run"),
                trace: getConfig("trace", "off")
            };
        },
        initializationFailedHandler: error => {
            client.error("Server initialization failed.", error);
            return false;
        },
        errorHandler: {
            error: (error, message, count): ErrorAction => {
                return defaultErrorHandler.error(error, message, count);
            },
            closed: (): CloseAction => {
                if (serverCalledProcessExit) {
                    return CloseAction.DoNotRestart;
                }
                return defaultErrorHandler.closed();
            }
        }
    };

    let client = new LanguageClient("textlint", serverOptions, clientOptions);
    defaultErrorHandler = client.createDefaultErrorHandler();
    client.onReady().then(() => {
        client.onNotification(ExitNotification.type, () => {
            serverCalledProcessExit = true;
        });
    });
    return client;
}

function createConfig() {
    if (workspace.rootPath) {
        let rc = path.join(workspace.rootPath, ".textlintrc");
        if (fs.existsSync(rc) === false) {
            fs.writeFileSync(rc, `{
  "filters": {},
  "rules": {}
}`, { encoding: 'utf8' });
        }
    } else {
        window.showErrorMessage("An textlint configuration can only be generated if VS Code is opened on a workspace folder.");
    }
}

let autoFixOnSave: Disposable;

function configureAutoFixOnSave(client: LanguageClient) {
    let auto = getConfig("autoFixOnSave", false);
    if (auto && !autoFixOnSave) {
        let languages = new Set(SUPPORT_LANGUAGES);
        autoFixOnSave = workspace.onWillSaveTextDocument(event => {
            let doc = event.document;
            if (languages.has(doc.languageId) && event.reason !== TextDocumentSaveReason.AfterDelay) {
                let version = doc.version;
                let uri: string = doc.uri.toString();
                event.waitUntil(
                    client.sendRequest(AllFixesRequest.type,
                        { textDocument: { uri } }).then((result: AllFixesRequest.Result) => {
                            return result && result.documentVersion === version ?
                                client.protocol2CodeConverter.asTextEdits(result.edits) :
                                [];
                        })
                );
            }
        });
    }
    if (auto === false) {
        disposeAutoFixOnSave();
    }
}
function disposeAutoFixOnSave() {
    if (autoFixOnSave) {
        autoFixOnSave.dispose();
        autoFixOnSave = undefined;
    }
}

function makeAutoFixFn(client: LanguageClient) {
    return () => {
        let textEditor = window.activeTextEditor;
        if (textEditor) {
            let uri: string = textEditor.document.uri.toString();
            client.sendRequest(AllFixesRequest.type, { textDocument: { uri } })
                .then(async (result: AllFixesRequest.Result) => {
                    if (result) {
                        await applyTextEdits(client, uri, result.documentVersion, result.edits);
                    }
                }, error => {
                    client.error("Failed to apply textlint fixes to the document.", error);
                });
        }
    };
}

function makeApplyFixFn(client: LanguageClient) {
    return async (uri: string, documentVersion: number, edits: TextEdit[]) => {
        await applyTextEdits(client, uri, documentVersion, edits);
    };
}

const allfixesCompletes = [];
function onAllFixesComplete(fn: (te: TextEditor, edits: TextEdit[], ok: boolean) => void) {
    allfixesCompletes.push(fn);
}

async function applyTextEdits(client: LanguageClient, uri: string, documentVersion: number, edits: TextEdit[]): Promise<boolean> {
    let textEditor = window.activeTextEditor;
    if (textEditor && textEditor.document.uri.toString() === uri) {
        if (textEditor.document.version === documentVersion) {
            return textEditor.edit(mutator => {
                edits.forEach(ed => mutator.replace(client.protocol2CodeConverter.asRange(ed.range), ed.newText));
            }).then(ok => {
                client.info("AllFixesComplete");
                allfixesCompletes.forEach(fn => fn(textEditor, edits, ok))
                return true;
            }, errors => {
                client.error(errors.message, errors.stack);
            });
        } else {
            window.showInformationMessage(`textlint fixes are outdated and can't be applied to ${uri}`);
            return true;
        }
    }
}

export function deactivate() {
    disposeAutoFixOnSave();
}

function config() {
    return workspace.getConfiguration("textlint");
}

function getConfig<T>(section: string, defaults?: T) {
    return config().get<T>(section, defaults);
}

function to(status: StatusNotification.Status): Status {
    switch (status) {
        case StatusNotification.Status.OK: return Status.OK;
        case StatusNotification.Status.WARN: return Status.WARN;
        case StatusNotification.Status.ERROR: return Status.ERROR;
        default: return Status.ERROR;
    }
}
