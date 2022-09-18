import * as vscode from 'vscode';

import { ThisExtension } from '../../ThisExtension';
import { ContextLanguage, ExecutionCommand, ExecutionContext } from '../../databricksApi/_types';
import { DatabricksApiService } from '../../databricksApi/databricksApiService';
import { Helper } from '../../helpers/Helper';
import { FSHelper } from '../../helpers/FSHelper';

export type NotebookMagic =
	"sql"
	| "python"
	| "scala"
	| "md"
	| "sh"
	| "fs"
	| "pip"
	| "run"
	;

export type KernelType =
	"jupyter-notebook"
	| "interactive"

// https://code.visualstudio.com/blogs/2021/11/08/custom-notebooks
export class DatabricksKernel implements vscode.NotebookController {
	private static baseId: string = 'databricks-notebook-kernel-';
	private static baseLabel: string = 'Databricks ';
	public id: string;
	public label: string;
	readonly notebookType: KernelType;
	readonly description: string = 'Execute code on a remote Databricks cluster';
	readonly detail: string = 'Some more detils ...';
	readonly supportedLanguages = []; // ["python", "sql", "r", "markdown", "scala"];
	readonly supportsExecutionOrder: boolean = true;

	private _controller: vscode.NotebookController;
	private _executionOrder: number;
	private _clusterId: string;
	private _language: ContextLanguage;
	private _executionContexts: Map<string, ExecutionContext>;

	constructor(clusterId: string, clusterName: string, notebookType: KernelType = 'jupyter-notebook', language: ContextLanguage = "python") {
		this.notebookType = notebookType;
		this._clusterId = clusterId;
		this._language = language;
		this.id = DatabricksKernel.getId(clusterId, notebookType);
		this.label = DatabricksKernel.getLabel(clusterName);

		this._executionOrder = 0;
		this._executionContexts = new Map<string, ExecutionContext>;

		ThisExtension.log("Creating new " + this.notebookType + " kernel '" + this.id + "'");
		this._controller = vscode.notebooks.createNotebookController(this.id,
			this.notebookType,
			this.label);

		this._controller.supportedLanguages = this.supportedLanguages;
		this._controller.description = "Databricks Cluster " + this.ClusterID;
		//this._controller.detail = this.detail;
		this._controller.supportsExecutionOrder = this.supportsExecutionOrder;
		this._controller.executeHandler = this.executeHandler.bind(this);
		this._controller.dispose = this.disposeController.bind(this);

		ThisExtension.PushDisposable(this);
	}

	static getId(clusterId: string, kernelType: KernelType) {
		return this.baseId + clusterId + "-" + kernelType;
	}

	static getLabel(clusterName: string) {
		return this.baseLabel + clusterName;
	}

	get Controller(): vscode.NotebookController {
		return this._controller;
	}

	get ClusterID(): string {
		return this._clusterId;
	}

	get Language(): ContextLanguage {
		return this._language;
	}



	async disposeController(): Promise<void> {
		for (let context of this._executionContexts.entries()) {
			try {
				await DatabricksApiService.removeExecutionContext(context[1]);
			}
			catch (e) { };
		}

		this._executionContexts.clear();
	}

	async dispose(): Promise<void> {
		this.Controller.dispose(); // bound to disposeController() above
	}

	async restart(notebookUri: vscode.Uri = undefined): Promise<void> {
		if (notebookUri == undefined) {
			ThisExtension.log(`Restarting notebook kernel ${this.Controller.id} ...`)
			// we simply remove the current execution context and close it on the Cluster
			// the next execution will then create a new context
			await this.disposeController();
		}
		else {
			ThisExtension.log(`Restarting notebook kernel ${this.Controller.id} for notebook ${notebookUri.toString()} ...`);
			this._executionContexts.delete(notebookUri.toString());
		}
	}

	private async initializeExecutionContext(): Promise<ExecutionContext> {
		return await DatabricksApiService.getExecutionContext(this.ClusterID, this.Language);
	}

	setNotebookContext(notebookUri: vscode.Uri, context: ExecutionContext): void {
		this._executionContexts.set(notebookUri.toString(), context);
	}

	getNotebookContext(notebookUri: vscode.Uri): ExecutionContext {
		let path = notebookUri.toString();
		if (this._executionContexts.has(path)) {
			return this._executionContexts.get(path);
		}
		return undefined;
	}

	async updateRepoContext(notebookUri: vscode.Uri): Promise<void> {
		let paths: string[] = notebookUri.path.split(FSHelper.SEPARATOR);
		// if we are working with a notebook from the Databricks Repos folder (works with dbws:/ and locally synced notebooks)
		if (paths.includes("Repos")) {
			ThisExtension.log("NotebookKernel: Setting up FilesInRepo support for " + notebookUri);
			let driverPath: string = `/Workspace/${paths.slice(paths.indexOf("Repos"), paths.indexOf("Repos") + 3).join(FSHelper.SEPARATOR)}`
			let context: ExecutionContext = this.getNotebookContext(notebookUri);
			let commandText: string = `import sys \nsys.path.append('${driverPath}')`;
			let command: ExecutionCommand = await DatabricksApiService.runCommand(context, commandText, "python");
			let result = await DatabricksApiService.getCommandResult(command, true, true);
			ThisExtension.log(`NotebookKernel: Successfully set up FilesInRepo by running sys.path.append('${driverPath}')`)
		}
	}

	createNotebookCellExecution(cell: vscode.NotebookCell): vscode.NotebookCellExecution {
		//throw new Error('Method not implemented.');
		return null;
	}
	interruptHandler?: (notebook: vscode.NotebookDocument) => void | Thenable<void>;
	onDidChangeSelectedNotebooks: vscode.Event<{ readonly notebook: vscode.NotebookDocument; readonly selected: boolean; }>;
	updateNotebookAffinity(notebook: vscode.NotebookDocument, affinity: vscode.NotebookControllerAffinity): void {
		//throw new Error('Method not implemented.');
	}



	async executeHandler(cells: vscode.NotebookCell[], _notebook: vscode.NotebookDocument, _controller: vscode.NotebookController): Promise<void> {
		let execContext: ExecutionContext = this.getNotebookContext(_notebook.uri);
		if (!execContext) {
			ThisExtension.setStatusBar("Initializing Kernel ...", true);
			execContext = await this.initializeExecutionContext()
			this.setNotebookContext(_notebook.uri, execContext);
			this.updateRepoContext(_notebook.uri);
			ThisExtension.setStatusBar("Kernel initialized!");
		}
		for (let cell of cells) {
			await this._doExecution(cell, execContext);
			await Helper.wait(10); // Force some delay before executing/queueing the next cell
		}
	}

	private parseCommand(cmd: string): [ContextLanguage, string, NotebookMagic] {
		if (cmd[0] == "%") {
			let lines = cmd.split('\n');
			let magicText = lines[0].split(" ")[0].slice(1).trim();
			let commandText = lines.slice(1).join('\n');
			let language: ContextLanguage = this.Language;
			if (["python", "sql", "scala", "r"].includes(magicText)) {
				language = magicText as ContextLanguage;
			}
			else {
				// we can run %pip commands "as-is" using the Python language
				language = "python";
				commandText = cmd;
			}

			return [language, commandText, magicText as NotebookMagic];
		}
		return [this.Language, cmd, undefined];
	}

	private async _doExecution(cell: vscode.NotebookCell, context: ExecutionContext): Promise<void> {
		const execution = this.Controller.createNotebookCellExecution(cell);
		execution.executionOrder = ++this._executionOrder;
		execution.start(Date.now());
		execution.clearOutput();

		// wrap a try/catch around the whole execution to make sure we never get stuck
		try {
			let commandText: string = cell.document.getText();
			let language: ContextLanguage = null;
			let magic: NotebookMagic = null;

			[language, commandText, magic] = this.parseCommand(commandText);

			ThisExtension.log("Executing " + language + ":\n" + commandText);

			switch (magic) {
				case "md":
					execution.appendOutput(new vscode.NotebookCellOutput([
						vscode.NotebookCellOutputItem.text(commandText, 'text/markdown')
					]));

					execution.end(true, Date.now());
					return;
				case "fs":
				case "sh":
					execution.appendOutput(new vscode.NotebookCellOutput([
						vscode.NotebookCellOutputItem.text("Magic %" + magic + " is not supported in remote executions!", 'text/plain')
					]));

					execution.end(false, Date.now());
					return;
				case "run":
					let runFile: string = Helper.trimChar(commandText.substring(commandText.indexOf(' ') + 1), '"');
					let runUri: vscode.Uri = vscode.Uri.joinPath(FSHelper.parent(cell.notebook.uri), runFile);
					ThisExtension.log("Executing %run for '" + runUri + "' ...");
					switch (runUri.scheme) {
						case "dbws":
							// we cannot use vscode.workspace.fs here as we need the SOURCE file and not the ipynb file 
							commandText = Buffer.from(await DatabricksApiService.downloadWorkspaceItem(runUri.path, "SOURCE")).toString();
							break;
						case "file":
							// %run is not aware of filetypes/extensions/langauges so we need to check which ones actually exist locally
							let allFiles = await vscode.workspace.fs.readDirectory(FSHelper.parent(runUri));
							let relevantFiles = allFiles.filter(x => x[0].startsWith(FSHelper.basename(runUri)));

							if(relevantFiles.length == 1)
							{
								runUri = vscode.Uri.joinPath(FSHelper.parent(runUri), relevantFiles[0][0]);
								commandText = Buffer.from(await vscode.workspace.fs.readFile(runUri)).toString();

								if(FSHelper.extension(runUri) == ".ipynb")
								{
									let notebookJSON = JSON.parse(commandText);
									let cells = notebookJSON["cells"];
									cells = cells.filter(x => x["cell_type"] == "code"); // only take code cells

									let commands: string[] = [];
									for(let cell of cells)
									{
										commands.push(cell["source"].join("\n"));
									}

									commandText = commands.join("\n");
								}
							}
							else{
								throw vscode.FileSystemError.FileNotFound(runUri);
							}
							break;
						default:
							throw new Error("%run is not supported for FileSystem scheme '" + runUri.scheme + "'!");
					}

					ThisExtension.log("Finished getting actual code for %run '" + runUri + "' ...");
					break;
			}
			let command = await DatabricksApiService.runCommand(context, commandText, language);
			execution.token.onCancellationRequested(() => {
				DatabricksApiService.cancelCommand(command);

				execution.appendOutput(new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text("Execution cancelled!", 'text/plain'),
				]));

				execution.end(false, Date.now());
				return;
			});

			let result = await DatabricksApiService.getCommandResult(command, true, true);

			if (result.results.resultType == "table") {
				let data: Array<any> = [];
				let html: string;

				html = '<div style="height:300px;overflow:auto;resize:both;"><table style="width:100%" class="searchable sortable"><thead><tr>';

				let schema = result.results.schema;

				for (let col of schema) {
					html += '<th>' + col.name + '</th>';
				}

				html += '</tr></thead><tbody>';

				for (let row of result.results.data) {
					let newRow = {};

					html += '<tr>';
					for (let i = 0; i < schema.length; i++) {
						html += '<td>' + row[i] + '</td>';
						newRow[schema[i].name] = row[i];
					}
					html += '</tr>';
					data.push(newRow);
				}

				html += '</tbody></table></div>';

				let output: vscode.NotebookCellOutput = new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text(html, 'text/html'),
					vscode.NotebookCellOutputItem.json(data, 'application/json'), // to be used by proper JSON/table renderers
					vscode.NotebookCellOutputItem.json(result.results, 'application/databricks-table') // the original result from databricks including schema and datatypes for more advanced renderers
				])
				output.metadata = { row_count: data.length, truncated: result.results.truncated };
				execution.appendOutput(output);
			}
			else if (result.results.resultType == "text") {
				let cellOutput = new vscode.NotebookCellOutput([]);
				let textData: string = result.results.data as string
				if (textData != '') {
					cellOutput.items.push(vscode.NotebookCellOutputItem.text(result.results.data, 'text/plain'));
				}
				// check text output for most common HTML tags/snippets to optionally also render the output as HTML
				if (textData.includes('<!DOCTYPE html>')
					|| textData.includes('</html>')
					|| textData.includes('</div>')
					|| textData.includes('</table>')
				) {
					cellOutput.items.push(vscode.NotebookCellOutputItem.text((result.results.data as string).trim(), 'text/html'));
				}

				execution.appendOutput(cellOutput);
			}
			else if (result.results.resultType == "images") {
				// add support for multiple images, each rendered as individual output
				for (let fileName of result.results.fileNames) {
					// we derive the mimeType from the actual file provided by Databricks and load the actual content from the base64 string
					let mimeType: string = fileName.split(";")[0].split(":")[1];
					let content: string = fileName.split(";", 2)[1];
					execution.appendOutput(new vscode.NotebookCellOutput([
						new vscode.NotebookCellOutputItem(Buffer.from(content.split(",")[1], (content.split(",")[0] as BufferEncoding)), mimeType),
					]))
				}
			}
			else if (result.results.resultType == "error") {
				execution.appendOutput(new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text(result.results.summary, 'text/html')
				]));

				execution.appendOutput(new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.error(new Error(result.results.cause)),
				]));

				execution.end(false, Date.now());
				return;
			}


			if (["pip"].includes(magic)) {
				await this.updateRepoContext(cell.notebook.uri);
			}

			execution.end(result.status == "Finished", Date.now());

		} catch (error) {
			execution.appendOutput(new vscode.NotebookCellOutput([
				vscode.NotebookCellOutputItem.text(error, 'text/plain')
			]));

			execution.end(false, Date.now());
			return;
		}
	}
}
