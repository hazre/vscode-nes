import * as vscode from "vscode";

import type { AutocompleteInput } from "~/api/client.ts";
import { ApiClient } from "~/api/client.ts";
import { DEFAULT_MAX_CONTEXT_FILES } from "~/constants";
import type { DocumentTracker } from "~/tracking/document-tracker.ts";

const API_KEY_PROMPT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class InlineEditProvider implements vscode.InlineCompletionItemProvider {
	private tracker: DocumentTracker;
	private api: ApiClient;
	private lastApiKeyPrompt = 0;

	constructor(tracker: DocumentTracker) {
		this.tracker = tracker;
		this.api = new ApiClient();
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionList | undefined> {
		if (!this.isEnabled()) {
			return undefined;
		}

		if (!this.api.apiKey) {
			this.promptForApiKey();
			return undefined;
		}

		const uri = document.uri.toString();
		const currentContent = document.getText();
		const originalContent =
			this.tracker.getOriginalContent(uri) ?? currentContent;

		if (currentContent === originalContent) {
			return undefined;
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		try {
			const input = this.buildInput(document, position, originalContent);
			const result = await this.api.getAutocomplete(input);

			if (token.isCancellationRequested || !result?.completion) {
				return undefined;
			}

			const startPosition = document.positionAt(result.startIndex);
			const endPosition = document.positionAt(result.endIndex);

			const item = {
				insertText: result.completion,
				range: new vscode.Range(startPosition, endPosition),
				isInlineEdit: true,
			} as vscode.InlineCompletionItem;

			return { items: [item] };
		} catch (error) {
			console.error("[Sweep] InlineEditProvider error:", error);
			return undefined;
		}
	}

	private isEnabled(): boolean {
		return vscode.workspace
			.getConfiguration("sweep")
			.get<boolean>("enabled", true);
	}

	private promptForApiKey(): void {
		const now = Date.now();
		if (now - this.lastApiKeyPrompt < API_KEY_PROMPT_INTERVAL_MS) {
			return;
		}
		this.lastApiKeyPrompt = now;
		vscode.commands.executeCommand("sweep.setApiKey");
	}

	private getMaxContextFiles(): number {
		return vscode.workspace
			.getConfiguration("sweep")
			.get<number>("maxContextFiles", DEFAULT_MAX_CONTEXT_FILES);
	}

	private buildInput(
		document: vscode.TextDocument,
		position: vscode.Position,
		originalContent: string,
	): AutocompleteInput {
		const uri = document.uri.toString();
		const maxContextFiles = this.getMaxContextFiles();

		const recentBuffers = this.tracker
			.getRecentContextFiles(uri, maxContextFiles)
			.map((file) => ({
				path: file.filepath,
				content: file.content,
				mtime: file.mtime,
			}));

		const recentChanges = this.tracker.getEditDiffHistory().map((record) => ({
			path: record.filepath,
			diff: record.diff,
		}));

		const userActions = this.tracker.getUserActions(document.fileName);

		return {
			document,
			position,
			originalContent,
			recentChanges,
			recentBuffers,
			diagnostics: vscode.languages.getDiagnostics(document.uri),
			userActions,
		};
	}
}
