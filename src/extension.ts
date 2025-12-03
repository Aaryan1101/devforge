import * as vscode from 'vscode';
import { exec } from 'child_process'; 
import * as fs from 'fs'; 
import * as path from 'path'; 
import axios from 'axios'; 

// N8N Webhook URL - ALL requests now go to this single endpoint
const N8N_WEBHOOK_URL = 'https://clownsbeta.app.n8n.cloud/webhook/devforge-analysis'; // YOUR URL

// --- FLOW ANALYSIS CONFIGURATION ---
// FIX: Using only simple wildcards and specific extensions to avoid the "unexpected alternate groups" error.
const FLOW_FILE_PATTERNS = [
    '**/package.json', 
    '**/*.html', // Now includes all HTML files
    '**/index.js',      
    '**/index.ts',      
    '**/index.jsx',      
    '**/index.tsx',      
    '**/server.js',     
    '**/server.ts',     
    '**/src/**/*.js',  
    '**/src/**/*.ts',  
    '**/src/**/*.jsx', 
    '**/src/**/*.tsx'  
];
const MAX_CONTEXT_FILES = 8; // Max files to read for project flow analysis


export function activate(context: vscode.ExtensionContext) {

    console.log('DevForge Agent extension is now active!');

    const chatProvider = new DevForgeChatProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'devforgechatview', // Must match the ID in package.json
            chatProvider
        )
    );

    // --- REGISTER COMMANDS ---

    // Command: Environment Manager (/env)
    let envDisposable = vscode.commands.registerCommand('devforge.runEnv', async (envName: string) => {
        vscode.window.showInformationMessage(`[DevForge] Starting environment: ${envName}...`);

        const terminal = vscode.window.createTerminal(`DevForge: ${envName}`);
        terminal.show(true); 
        
        const dockerCommand = `docker-compose -f docker-compose.${envName}.yml up -d --build`;
        terminal.sendText(dockerCommand);

        chatProvider.postMessageToWebview({
            command: 'addMessage',
            text: `Environment setup triggered for **${envName}** in the integrated terminal. Check the TERMINAL tab.`
        });
    });

    // Command: File Analysis/Summary (/summary)
    let summaryDisposable = vscode.commands.registerCommand('devforge.runSummary', async (filePath: string) => {
        
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let targetPath: string | undefined;

        // Path resolution logic
        if (filePath) {
            if (workspaceRoot) {
                targetPath = path.join(workspaceRoot, filePath);
            }
        } else if (vscode.window.activeTextEditor) {
            targetPath = vscode.window.activeTextEditor.document.uri.fsPath;
        }

        if (!targetPath || !fs.existsSync(targetPath)) {
            chatProvider.postMessageToWebview({
                command: 'addMessage',
                text: `[DevForge] ERROR: File not found or invalid path provided: ${filePath || 'No active file'}.`
            });
            return;
        }
        
        try {
            vscode.window.showInformationMessage(`[DevForge] Sending file to n8n agent for analysis: ${path.basename(targetPath)}...`);
            
            const content = fs.readFileSync(targetPath, 'utf-8');
            
            // Send to n8n Agent - Task: summarize
            const response = await axios.post(N8N_WEBHOOK_URL, {
                filename: path.basename(targetPath),
                content: content,
                task: 'summarize' 
            });

            const agentSummary = response.data.summary || 'Analysis failed: Agent returned no specific summary text.';

            chatProvider.postMessageToWebview({
                command: 'addMessage',
                text: `**Agent Analysis for ${path.basename(targetPath)}:**\n\n${agentSummary}`
            });

        } catch (error) {
            chatProvider.postMessageToWebview({
                command: 'addMessage',
                text: `[DevForge] Agent integration failed (Check N8N/API). Error: ${(error as Error).message}`
            });
            console.error('n8n Agent Integration Error:', error);
        }
    });

    // Command: Unit Test Generation & Execution (/test)
    let testDisposable = vscode.commands.registerCommand('devforge.runTests', async (filePath: string) => {
    
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let targetPath: string | undefined;

        targetPath = path.join(workspaceRoot || '', filePath || vscode.window.activeTextEditor?.document.fileName || '');

        if (!targetPath || !fs.existsSync(targetPath)) {
            chatProvider.postMessageToWebview({ command: 'addMessage', text: `[DevForge] ERROR: File not found: ${filePath || 'No active file'}.` });
            return;
        }

        // --- STEP 1: GENERATE TEST CODE (AI AGENT) ---
        vscode.window.showInformationMessage(`[DevForge] Generating test for: ${path.basename(targetPath)}...`);
        const content = fs.readFileSync(targetPath, 'utf-8');
        
        const response = await axios.post(N8N_WEBHOOK_URL, {
            filename: path.basename(targetPath),
            content: content,
            task: 'generate_test' // Task identifier
        });

        const generatedTest = response.data.summary;
        if (!generatedTest || generatedTest.includes('failed')) {
             chatProvider.postMessageToWebview({ command: 'addMessage', text: `**AI Test Generation Failed.** Output:\n\n${generatedTest}` });
             return;
        }

        // --- STEP 2 & 3: SAVE AND EXECUTE TEST (AUTOMATED) ---
        const testFilename = path.basename(targetPath).replace(/(\.js|\.ts|\.jsx|\.tsx)/, '.test$&');
        const testFilePath = path.join(workspaceRoot || '', 'tests', testFilename); 
        
        try {
            if (workspaceRoot && !fs.existsSync(path.join(workspaceRoot, 'tests'))) {
                 fs.mkdirSync(path.join(workspaceRoot, 'tests'));
            }
            fs.writeFileSync(testFilePath, generatedTest, 'utf-8');
        } catch (e) {
            chatProvider.postMessageToWebview({ command: 'addMessage', text: `[ERROR] Could not save test file. Check folder permissions.` });
            return;
        }

        chatProvider.postMessageToWebview({ 
            command: 'addMessage', 
            text: `Test file saved to **tests/${testFilename}**. Now executing tests... (Check Terminal for full log)`
        });

        const testCommand = 'npm test'; 

        exec(testCommand, { cwd: workspaceRoot }, (error, stdout, stderr) => {
            
            const resultOutput = stdout + stderr;
            const isSuccess = resultOutput.toLowerCase().includes('pass') && !error;

            chatProvider.postMessageToWebview({
                command: 'addMessage',
                text: `**Test Execution Results:** ${isSuccess ? '✅ PASSED' : '❌ FAILED'}\n\n\`\`\`\n${resultOutput}\n\`\`\``
            });
            vscode.workspace.openTextDocument(testFilePath).then(doc => vscode.window.showTextDocument(doc));
        });
    });

    // Command: Project Flow Analysis (/flow) - NEW FEATURE
    let flowDisposable = vscode.commands.registerCommand('devforge.runFlow', async () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!workspaceRoot) {
            chatProvider.postMessageToWebview({ command: 'addMessage', text: `[ERROR] Please open a project folder to run flow analysis.` });
            return;
        }

        try {
            vscode.window.showInformationMessage(`[DevForge] Analyzing project flow across multiple files...`);

            // --- STEP 1: ASYNCHRONOUSLY FIND FILES (FIXED GLOBBING) ---
            // FIX: Use the stable, simplified pattern array joined by a comma, 
            // enclosed in a single pair of braces for the findFiles API.
            const globPattern = `{${FLOW_FILE_PATTERNS.join(',')}}`;
            const fileUris = await vscode.workspace.findFiles(globPattern, '**/node_modules/**', MAX_CONTEXT_FILES);
            
            if (fileUris.length === 0) {
                 chatProvider.postMessageToWebview({ command: 'addMessage', text: `[DevForge] Could not find relevant source files in the project.` });
                 return;
            }

            // --- STEP 2: BUILD CONTEXT STRING ---
            let contextString = '';
            for (const uri of fileUris) {
                const relativePath = path.relative(workspaceRoot, uri.fsPath);
                const content = fs.readFileSync(uri.fsPath, 'utf-8'); 
                
                contextString += `\n\n### FILE: ${relativePath} ###\n\n\`\`\`\n${content}\n\`\`\``;
            }

            // --- STEP 3: SEND TO AI AGENT (TASK: flow_analysis) ---
            vscode.window.showInformationMessage(`[DevForge] Sending ${fileUris.length} files to AI for flow mapping...`);
            
            const response = await axios.post(N8N_WEBHOOK_URL, { 
                project_context: contextString, // Send the large concatenated string
                task: 'flow_analysis',         // Identifies the new task for n8n Router
                root_path: path.basename(workspaceRoot)
            });

            const flowSummary = response.data.summary || 'Flow analysis failed. Check N8N workflow for response.';

            // --- STEP 4: REPORT RESULTS ---
            chatProvider.postMessageToWebview({
                command: 'addMessage',
                text: `**Project Flow Analysis for ${path.basename(workspaceRoot)}:**\n\n${flowSummary}`
            });

        } catch (error) {
            chatProvider.postMessageToWebview({
                command: 'addMessage',
                text: `[ERROR] Flow analysis failed during execution: ${(error as Error).message}`
            });
            console.error('Project Flow Analysis Error:', error);
        }
    });


    // Command: Log Debugger/Analyzer (/logs) - FINAL FIX IMPLEMENTED HERE
    let logsDisposable = vscode.commands.registerCommand('devforge.runLogs', async (fileName: string) => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!workspaceRoot) {
            chatProvider.postMessageToWebview({
                command: 'addMessage',
                text: `[ERROR] Please open a project folder to run log analysis.`
            });
            return;
        }
        
        const logFile = fileName; 

        vscode.window.showInformationMessage(`[DevForge] Fetching log snapshot for: ${fileName}`);

        // FIX: Explicitly set the current working directory (cwd: workspaceRoot)
        exec(`tail -n 10 ${logFile}`, { cwd: workspaceRoot }, (error, stdout, stderr) => {
            if (error || stderr) {
                chatProvider.postMessageToWebview({
                    command: 'addMessage',
                    text: `[ERROR] Could not read log file '${fileName}'. Check file existence in project root. Shell Error: ${error?.message || stderr}`
                });
                return;
            }
            chatProvider.postMessageToWebview({
                command: 'addMessage',
                text: `**Log Snapshot for ${fileName} (Last 10 lines):**\n\`\`\`\n${stdout}\n\`\`\``
            });
        });
    });

    context.subscriptions.push(envDisposable, summaryDisposable, logsDisposable, testDisposable, flowDisposable);
}

// --- DevForgeChatProvider Class ---

class DevForgeChatProvider implements vscode.WebviewViewProvider {
    
    public static readonly viewType = 'devforgechatview';
    
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;

    constructor(private readonly extensionUri: vscode.Uri) { 
        this._extensionUri = extensionUri;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(data => {
            this.handleUserCommand(data.text);
        });
    }

    public postMessageToWebview(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    private handleUserCommand(text: string) {
        const parts = text.trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const argument = parts.slice(1).join(' ');

        // --- UPDATED HELP MESSAGE ---
        const helpText = `
**DevForge Agent Commands:**
| Command | Action | Example |
| :--- | :--- | :--- |
| **/flow** | **[NEW]** Analyzes the entire project structure and data flow. | \`/flow\` |
| **/summary [file]** | Runs AI static analysis (flaws, suggestions). | \`/summary index.js\` |
| **/test [file]** | **Generates and executes** a unit test suite. | \`/test component.js\` |
| **/logs [file]** | Fetches the last 10 lines of the log file from the project root. | \`/logs app.log\` |
| **/env [version]** | Executes Docker Compose for the environment version (e.g., \`node-18\`). | \`/env node-18\` |
| **/help** | Displays this command list. | \`/help\` |
`;

        switch (command) {
            case 'showcurrentlogs': 
                vscode.commands.executeCommand('devforge.runLogs', 'server.log');
                break; 
            case '/flow': 
                vscode.commands.executeCommand('devforge.runFlow');
                break;
            case '/test': 
                vscode.commands.executeCommand('devforge.runTests', argument);
                break;
            case '/help': 
                this.postMessageToWebview({
                    command: 'addMessage',
                    text: helpText
                });
                break;
            case '/summary':
            case '/analyze':
                vscode.commands.executeCommand('devforge.runSummary', argument);
                break;
            case '/logs':
                vscode.commands.executeCommand('devforge.runLogs', argument || 'server.log');
                break;
            case '/env':
            case '/environment':
                vscode.commands.executeCommand('devforge.runEnv', argument || 'default');
                break;
            default:
                this.postMessageToWebview({
                    command: 'addMessage',
                    text: `[DevForge] Unrecognized command: ${command}. Type **/help** for a list of commands.`
                });
        }
    }

    // Generates the final HTML content with secure URI mapping and styling
    private _getHtmlForWebview(webview: vscode.Webview) {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));
        // CDN for marked.js to render markdown easily
        const markedCdn = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";

        return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>DevForge Agent</title>
            <script src="${markedCdn}"></script> 
            <style>
                /* BASE STYLES */
                body {
                    margin: 0; padding: 0; height: 100vh; 
                    display: flex; flex-direction: column; 
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                }
                #chat-container { 
                    flex-grow: 1; 
                    overflow-y: auto; 
                    padding: 15px; 
                    box-shadow: inset 0 0 5px rgba(0, 0, 0, 0.2); 
                }
                #input-area { 
                    display: flex; 
                    padding: 10px 15px; 
                    border-top: 1px solid var(--vscode-panel-border); 
                }
                #chat-input { 
                    flex-grow: 1; 
                    padding: 7px 10px; 
                    margin-left: 10px; 
                    margin-right: 10px; 
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 0;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 7px 15px;
                    cursor: pointer;
                    white-space: nowrap;
                    border-radius: 0;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                
                /* MARKDOWN RENDERING STYLES */
                
                .message-agent-block {
                    margin: 10px 0;
                    padding: 0;
                    line-height: 1.4;
                    color: var(--vscode-foreground);
                }
                .message-agent-block h2 {
                    color: var(--vscode-terminal-ansiBrightCyan); 
                    font-size: 1.1em;
                    font-weight: 600;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 5px;
                    margin-top: 15px;
                }
                .message-agent-block ul {
                    list-style-type: none; 
                    padding-left: 10px;
                }
                .message-agent-block li {
                    padding-left: 1.5em; 
                    text-indent: -1.5em; 
                    margin-bottom: 5px;
                }
                .message-agent-block li::before {
                    content: '→'; 
                    color: var(--vscode-terminal-ansiYellow);
                    margin-right: 8px;
                }
                /* FIX: CODE BLOCK WRAPPING */
                .message-agent-block pre {
                    background-color: var(--vscode-textCodeBlock-background);
                    border: 1px solid var(--vscode-panel-border);
                    padding: 10px;
                    overflow-x: hidden; 
                    border-radius: 4px;
                    white-space: pre-wrap; 
                    word-wrap: break-word; 
                }
                /* Inline code */
                .message-agent-block code {
                    background-color: var(--vscode-textCodeBlock-background); 
                    padding: 0 4px;
                    border-radius: 3px;
                    white-space: pre-wrap; 
                }
                /* User input text */
                .message-user { 
                    margin: 5px 0; 
                    color: var(--vscode-terminal-ansiBrightYellow); 
                    font-weight: bold;
                }
                /* TABLE STYLING for /help */
                .message-agent-block table {
                    border-collapse: collapse;
                    width: 100%;
                    margin-top: 10px;
                }
                .message-agent-block th, .message-agent-block td {
                    border: 1px solid var(--vscode-panel-border);
                    padding: 8px;
                    text-align: left;
                }
                .message-agent-block th {
                    background-color: var(--vscode-panel-background);
                    color: var(--vscode-editor-foreground);
                }
                
            </style>
        </head>
        <body>
            <div id="chat-container">
                <div class="message-agent-block">
                    Welcome to DevForge! Type **/** or click **Show Logs** to start. Type **/help** for commands.
                </div>
            </div>
            <div id="input-area">
                <button id="logs-btn" onclick="showCurrentLogs()">Show Logs</button> 
                <input type="text" id="chat-input" placeholder="Enter command (e.g., /summary main.js)">
                <button id="send-btn" onclick="postMessageToExtension()">Send</button>
            </div>
            <script src="${scriptUri}"></script> 
        </body>
        </html>
        `;
    }
}

export function deactivate() {}