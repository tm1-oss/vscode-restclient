import { CancellationToken, CodeLens, CodeLensProvider, Command, Range, TextDocument } from 'vscode';
import * as Constants from '../common/constants';
import { Selector } from '../utils/selector';

export class HttpCodeLensProvider implements CodeLensProvider {
    public provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        const blocks: CodeLens[] = [];
        const lines: string[] = document.getText().split(Constants.LineSplitterRegex);
        const requestRanges: [number, number][] = Selector.getRequestRanges(lines);

        for (let i = 0; i < requestRanges.length; i++) {
            const [blockStart, blockEnd] = requestRanges[i];
            const range = new Range(blockStart, 0, blockEnd, 0);
            const sendCmd: Command = {
                arguments: [document, range],
                title: 'Send Request',
                command: 'rest-client.request'
            };
            blocks.push(new CodeLens(range, sendCmd));

            const sendTillCmd: Command = {
                arguments: [document, range],
                title: 'Send Till Request',
                command: 'rest-client.request-till'
            };
            blocks.push(new CodeLens(range, sendTillCmd));
        }

        return Promise.resolve(blocks);
    }
}