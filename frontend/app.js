const chatToggle = document.getElementById('chat-toggle');
const chatWindow = document.getElementById('chat-window');
const chatClose = document.getElementById('chat-close');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const navToggle = document.getElementById('nav-toggle');
const navLinks = document.querySelectorAll('.main-nav a');

const CHAT_ENDPOINT = '/api/chat';
const MAX_HISTORY = 20;
const NETWORK_ERROR_REPLY = "Sorry, I couldn't reach the server. Please check your connection and try again.";

let conversationHistory = [];

// A plain slice(-N) can land mid-turn and strip the tool_use message a later
// tool_result refers to, which the API rejects. Only cut at a real turn
// boundary: a user message with plain string content (never a tool_result).
function truncateHistory(history, maxMessages) {
  if (history.length <= maxMessages) return history;
  let start = history.length - maxMessages;
  while (start < history.length && !(history[start].role === 'user' && typeof history[start].content === 'string')) {
    start += 1;
  }
  return history.slice(start);
}

function openChat() {
  chatWindow.classList.add('open');
  chatWindow.setAttribute('aria-hidden', 'false');
  chatToggle.setAttribute('aria-expanded', 'true');
  chatInput.focus();
}

function closeChat() {
  chatWindow.classList.remove('open');
  chatWindow.setAttribute('aria-hidden', 'true');
  chatToggle.setAttribute('aria-expanded', 'false');
}

function toggleChat() {
  if (chatWindow.classList.contains('open')) {
    closeChat();
  } else {
    openChat();
  }
}

function addMessage(text, sender) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble ' + sender;
  bubble.textContent = text;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

function showTypingIndicator() {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble bot typing';
  bubble.setAttribute('aria-label', 'The Trim Spoon Assistant is typing');
  bubble.innerHTML = '<span></span><span></span><span></span>';
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

chatToggle.addEventListener('click', toggleChat);
chatClose.addEventListener('click', closeChat);

navLinks.forEach(function (link) {
  link.addEventListener('click', function () {
    navToggle.checked = false;
  });
});

chatForm.addEventListener('submit', async function (event) {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  addMessage(text, 'user');
  chatInput.value = '';

  const typingBubble = showTypingIndicator();

  try {
    const response = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        conversationHistory: conversationHistory.slice(-MAX_HISTORY),
      }),
    });

    const data = await response.json().catch(function () {
      return null;
    });

    typingBubble.remove();

    if (!data) {
      addMessage(NETWORK_ERROR_REPLY, 'bot');
      return;
    }

    addMessage(data.reply || NETWORK_ERROR_REPLY, 'bot');
    conversationHistory = Array.isArray(data.conversationHistory)
      ? truncateHistory(data.conversationHistory, MAX_HISTORY)
      : conversationHistory;
  } catch (error) {
    typingBubble.remove();
    addMessage(NETWORK_ERROR_REPLY, 'bot');
  }
});
