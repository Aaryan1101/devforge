

const vscode = acquireVsCodeApi(); 
const inputElement = document.getElementById('chat-input');
const outputElement = document.getElementById('chat-container');
const logsButton = document.getElementById('logs-btn');

// --- Helper function for the new Logs Button ---
function showCurrentLogs() {
   
    vscode.postMessage({
        command: 'submitText',
        text: 'showCurrentLogs' 
    });
}

// --- Main command posting function ---
function postMessageToExtension() {
    const text = inputElement.value.trim();
    if (!text) return;

    // Display user message 
    outputElement.innerHTML += '<p class="message-user">> ' + text + '</p>';
    
    
    vscode.postMessage({
        command: 'submitText',
        text: text
    });
    
    inputElement.value = '';
    outputElement.scrollTop = outputElement.scrollHeight;
}


logsButton.addEventListener('click', showCurrentLogs);


window.addEventListener('message', event => {
    const message = event.data; 

    switch (message.command) {
        case 'addMessage':
            
            // 1. Convert Markdown text to HTML using the 'marked' library
            const renderedHtml = marked.parse(message.text || '', { 
                gfm: true, 
                breaks: true 
            }); 

            // 2. CREATE A NEW ELEMENT for the agent's output
            const agentOutput = document.createElement('div');
            // Apply a class to the new container for styling (as defined in extension.ts CSS)
            agentOutput.className = 'message-agent-block'; 
            
            // 3. SET THE INNER HTML (THE FIX!)
            // This tells the browser to parse the generated HTML, not treat it as text.
            agentOutput.innerHTML = renderedHtml;

            // 4. Append to the chat container
            outputElement.appendChild(agentOutput);

            outputElement.scrollTop = outputElement.scrollHeight;
            break;
    }
});

// Enable sending message on Enter key press
inputElement.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        postMessageToExtension();
    }
});
