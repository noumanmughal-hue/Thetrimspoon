const chatToggle = document.getElementById('chat-toggle');
const chatWindow = document.getElementById('chat-window');
const chatClose = document.getElementById('chat-close');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const navToggle = document.getElementById('nav-toggle');
const navLinks = document.querySelectorAll('.main-nav a');

const MOCK_REPLY = "Hi! I'm The Trim Spoon Assistant. My AI brain isn't connected yet.";

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
}

chatToggle.addEventListener('click', toggleChat);
chatClose.addEventListener('click', closeChat);

navLinks.forEach(function (link) {
  link.addEventListener('click', function () {
    navToggle.checked = false;
  });
});

chatForm.addEventListener('submit', function (event) {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  addMessage(text, 'user');
  chatInput.value = '';

  setTimeout(function () {
    addMessage(MOCK_REPLY, 'bot');
  }, 400);
});
