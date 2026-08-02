import { ExtensionContext, Range, TextDocument, ViewColumn, window } from 'vscode';
import * as Constants from '../common/constants';
import Logger from '../logger';
import { IRestClientSettings, RequestSettings, RestClientSettings } from '../models/configurationSettings';
import { HistoricalHttpRequest, HttpRequest } from '../models/httpRequest';
import { RequestMetadata } from '../models/requestMetadata';
import { RequestParserFactory } from '../models/requestParserFactory';
import { trace } from "../utils/decorator";
import { HttpClient } from '../utils/httpClient';
import { RequestState, RequestStatusEntry } from '../utils/requestStatusBarEntry';
import { RequestVariableCache } from "../utils/requestVariableCache";
import { Selector } from '../utils/selector';
import { TestRunner } from '../utils/testRunner';
import { TestRunnerResult } from '../utils/testRunnerResult';
import { UserDataManager } from '../utils/userDataManager';
import { getCurrentTextDocument } from '../utils/workspaceUtility';
import { HttpResponseTextDocumentView } from '../views/httpResponseTextDocumentView';
import { HttpResponseWebview } from '../views/httpResponseWebview';

export class RequestController {
    private _requestStatusEntry: RequestStatusEntry;
    private _httpClient: HttpClient;
    private _webview: HttpResponseWebview;
    private _textDocumentView: HttpResponseTextDocumentView;
    private _lastRequestSettingTuple?: [HttpRequest, IRestClientSettings];
    private _lastPendingRequest?: HttpRequest;

    public constructor(context: ExtensionContext) {
        this._requestStatusEntry = new RequestStatusEntry();
        this._httpClient = new HttpClient();
        this._webview = new HttpResponseWebview(context);
        this._webview.onDidCloseAllWebviewPanels(() => this._requestStatusEntry.update({ state: RequestState.Closed }));
        this._textDocumentView = new HttpResponseTextDocumentView();
    }

    @trace('Request')
    public async run(range: Range) {
        const editor = window.activeTextEditor;
        const document = getCurrentTextDocument();
        if (!editor || !document) {
            return;
        }

        const selectedRequest = await Selector.getRequest(editor, range);
        if (!selectedRequest) {
            return;
        }

        const { text, metadatas } = selectedRequest;
        const name = metadatas.get(RequestMetadata.Name);

        if (metadatas.has(RequestMetadata.Note)) {
            const note = name ? `Are you sure you want to send the request "${name}"?` : 'Are you sure you want to send this request?';
            const userConfirmed = await window.showWarningMessage(note, 'Yes', 'No');
            if (userConfirmed !== 'Yes') {
                return;
            }
        }

        const requestSettings = new RequestSettings(metadatas);
        const settings: IRestClientSettings = new RestClientSettings(requestSettings);

        // parse http request
        const httpRequest = await RequestParserFactory.createRequestParser(text, settings).parseHttpRequest(name);

        await this.runCore(httpRequest, settings, document);
    }

    @trace('Send Till Request')
    public async runTill(range: Range) {
        const editor = window.activeTextEditor;
        const document = getCurrentTextDocument();
        if (!editor || !document) {
            return;
        }

        // Collect all request ranges up to and including the target range
        const lines = document.getText().split(Constants.LineSplitterRegex);
        const allRequestRanges = Selector.getRequestRanges(lines);

        // Filter to only include ranges whose block start is at or before the target range's start line
        const rangesToRun = allRequestRanges.filter(([blockStart]) => blockStart <= range.start.line);

        const collectedResults: Array<{ label: string; line: number; result: TestRunnerResult }> = [];

        // Show a single "Waiting..." status for the entire run-till operation
        const runTillStartMs = Date.now();
        this._requestStatusEntry.update({ state: RequestState.Pending });

        for (const [blockStart, blockEnd] of rangesToRun) {
            const blockRange = new Range(blockStart, 0, blockEnd, 0);
            const selectedRequest = await Selector.getRequest(editor, blockRange);
            if (!selectedRequest) {
                continue;
            }

            const { text, metadatas } = selectedRequest;
            const name = metadatas.get(RequestMetadata.Name);
            const requestSettings = new RequestSettings(metadatas);
            const settings: IRestClientSettings = new RestClientSettings(requestSettings);

            const httpRequest = await RequestParserFactory.createRequestParser(text, settings).parseHttpRequest(name);
            const result = await this.runCore(httpRequest, settings, document, true, true);

            // Stop if the request was cancelled
            if (httpRequest.isCancelled) {
                this._requestStatusEntry.update({ state: RequestState.Cancelled });
                return;
            }

            if (result) {
                // Derive a label: prefer @name metadata, then the text after ### on the
                // nearest delimiter line above the block, then fall back to line number.
                let label = name;
                if (!label) {
                    for (let i = blockStart - 1; i >= 0; i--) {
                        const delimMatch = lines[i].match(/^#{3,}\s*(.*)/);
                        if (delimMatch) {
                            const delimName = delimMatch[1].trim();
                            if (delimName) {
                                label = delimName;
                            }
                            break;
                        }
                    }
                }
                collectedResults.push({ label: label ?? '', line: blockStart + 1, result });
            }
        }

        // Replace "Waiting..." with total elapsed time for the whole run-till operation
        this._requestStatusEntry.update({ state: RequestState.Elapsed, totalMs: Date.now() - runTillStartMs });

        // Render all collected test results in the webview
        if (collectedResults.length > 0) {
            try {
                const activeColumn = window.activeTextEditor!.viewColumn;
                const lastSettings = this._lastRequestSettingTuple?.[1];
                const previewColumn = lastSettings && lastSettings.previewColumn === ViewColumn.Active
                    ? activeColumn
                    : ((activeColumn as number) + 1) as ViewColumn;
                if (previewColumn) {
                    this._webview.renderAllTestResults(collectedResults, previewColumn);
                }
            } catch (reason) {
                Logger.error('Unable to preview test results:', reason);
                window.showErrorMessage(reason instanceof Error ? reason.message : String(reason));
            }
        }
    }

    @trace('Rerun Request')
    public async rerun() {
        if (!this._lastRequestSettingTuple) {
            return;
        }

        const [request, settings] = this._lastRequestSettingTuple;

        // TODO: recover from last request settings
        await this.runCore(request, settings);
    }

    @trace('Cancel Request')
    public async cancel() {
        this._lastPendingRequest?.cancel();

        this._requestStatusEntry.update({ state: RequestState.Cancelled });
    }
    public async clearCookies() {
        try {
            await this._httpClient.clearCookies();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            window.showErrorMessage(`Error clearing cookies:${message}`);
        }
    }

    private async runCore(httpRequest: HttpRequest, settings: IRestClientSettings, document?: TextDocument, suppressDisplay?: boolean, suppressStatusUpdate?: boolean): Promise<TestRunnerResult | undefined> {
        // clear status bar
        if (!suppressStatusUpdate) {
            this._requestStatusEntry.update({ state: RequestState.Pending });
        }

        // set last request and last pending request
        this._lastPendingRequest = httpRequest;
        this._lastRequestSettingTuple = [httpRequest, settings];

        // set http request
        try {
            const response = await this._httpClient.send(httpRequest, settings);

            // check cancel
            if (httpRequest.isCancelled) {
                return undefined;
            }

            this._requestStatusEntry.update({ state: RequestState.Received, response });

            if (httpRequest.name && document) {
                RequestVariableCache.add(document, httpRequest.name, response);
            }

            // Execute tests
            const testRunner = new TestRunner(response);
            const testRunnerResult = testRunner.execute(httpRequest.tests);

            if (!suppressDisplay) {
                try {
                    const activeColumn = window.activeTextEditor!.viewColumn;
                    const previewColumn = settings.previewColumn === ViewColumn.Active
                        ? activeColumn
                        : ((activeColumn as number) + 1) as ViewColumn;
                    if (settings.previewResponseInUntitledDocument) {
                        this._textDocumentView.render(response, previewColumn);
                    } else if (previewColumn) {
                        this._webview.render(response, testRunnerResult, previewColumn);
                    }
                } catch (reason) {
                    Logger.error('Unable to preview response:', reason);
                    window.showErrorMessage(reason instanceof Error ? reason.message : String(reason));
                }
            }

            // persist to history json file
            await UserDataManager.addToRequestHistory(HistoricalHttpRequest.convertFromHttpRequest(httpRequest));

            return testRunnerResult;
        } catch (error) {
            // check cancel
            if (httpRequest.isCancelled) {
                return;
            }

            const err = error instanceof Error ? error : new Error(String(error));
            const errWithCode = err as NodeJS.ErrnoException;
            if (errWithCode.code === 'ETIMEDOUT') {
                err.message = `Request timed out. Double-check your network connection and/or raise the timeout duration (currently set to ${settings.timeoutInMilliseconds}ms) as needed: 'rest-client.timeoutinmilliseconds'. Details: ${err}.`;
            } else if (errWithCode.code === 'ECONNREFUSED') {
                err.message = `The connection was rejected. Either the requested service isn't running on the requested server/port, the proxy settings in vscode are misconfigured, or a firewall is blocking requests. Details: ${err}.`;
            } else if (errWithCode.code === 'ENETUNREACH') {
                err.message = `You don't seem to be connected to a network. Details: ${err}`;
            }
            this._requestStatusEntry.update({ state: RequestState.Error });
            Logger.error('Failed to send request:', err);
            window.showErrorMessage(err.message);
            return undefined;
        } finally {
            if (this._lastPendingRequest === httpRequest) {
                this._lastPendingRequest = undefined;
            }
        }
    }

    public dispose() {
        this._requestStatusEntry.dispose();
        this._webview.dispose();
    }
}