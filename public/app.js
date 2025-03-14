document.addEventListener('DOMContentLoaded', () => {
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendButton = document.getElementById('send-button');
    
    // Generate a session ID for this conversation
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2);
    
    // Function to add a message to the chat
    function addMessage(message, isUser = false) {
      const messageElement = document.createElement('div');
      messageElement.className = `message ${isUser ? 'user' : 'bot'}`;
      
      const messageContent = document.createElement('div');
      messageContent.className = 'message-content';
      
      // Convert markdown-like formatting to HTML
      let formattedMessage = message
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
        .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
        .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
      
      // Handle line breaks
      formattedMessage = formattedMessage
        .split('\n')
        .map(line => line.trim() === '' ? '<br>' : `<p>${line}</p>`)
        .join('');
      
      messageContent.innerHTML = formattedMessage;
      messageElement.appendChild(messageContent);
      chatMessages.appendChild(messageElement);
      
      // Scroll to the bottom
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    // Function to show typing indicator
    function showTypingIndicator() {
      const indicator = document.createElement('div');
      indicator.className = 'message bot';
      indicator.id = 'typing-indicator';
      
      const indicatorContent = document.createElement('div');
      indicatorContent.className = 'typing-indicator';
      
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement('span');
        indicatorContent.appendChild(dot);
      }
      
      indicator.appendChild(indicatorContent);
      chatMessages.appendChild(indicator);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    // Function to hide typing indicator
    function hideTypingIndicator() {
      const indicator = document.getElementById('typing-indicator');
      if (indicator) {
        indicator.remove();
      }
    }
    
    // Function to send a message to the server
    async function sendMessage(message) {
      try {
        showTypingIndicator();
        
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message,
            sessionId
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to get response');
        }
        
        const data = await response.json();
        hideTypingIndicator();
        addMessage(data.response);
      } catch (error) {
        console.error('Error:', error);
        hideTypingIndicator();
        addMessage('Sorry, I encountered an error processing your request. Please try again later.');
      }
    }
    
    // Event listener for send button
    sendButton.addEventListener('click', () => {
      const message = chatInput.value.trim();
      if (message) {
        addMessage(message, true);
        chatInput.value = '';
        sendMessage(message);
      }
    });
    
    // Event listener for Enter key
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const message = chatInput.value.trim();
        if (message) {
          addMessage(message, true);
          chatInput.value = '';
          sendMessage(message);
        }
      }
    });
    
    // Focus the input field when the page loads
    chatInput.focus();
  });