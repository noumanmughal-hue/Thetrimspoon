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

// ---------- Meal plan calculator ----------
// Reads static plan config from the backend and computes totals client-side —
// no LLM call involved in browsing or pricing a plan.
const PLANS_ENDPOINT = '/api/subscriptions';
const planTabs = document.querySelectorAll('.plan-tab');
const planDurationOptionsEl = document.getElementById('plan-duration-options');
const planItemsOptionsEl = document.getElementById('plan-items-options');
const planPerDayEl = document.getElementById('plan-per-day');
const planDurationDisplayEl = document.getElementById('plan-duration-display');
const planTotalEl = document.getElementById('plan-total');
const planWhatsappBtn = document.getElementById('plan-whatsapp-btn');
const planStatusEl = document.getElementById('plan-status');

let subscriptionData = null;
let selectedPlanType = 'weekly';
let selectedDuration = null;
let selectedItemIds = new Set();

function findPlan(planType) {
  return subscriptionData.plans.find(function (plan) { return plan.planType === planType; });
}

function renderPlanDurations() {
  const plan = findPlan(selectedPlanType);
  planDurationOptionsEl.innerHTML = '';

  plan.durationOptions.forEach(function (option) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plan-duration-btn' + (option.duration === selectedDuration ? ' active' : '');
    btn.textContent = option.duration + ' Days';
    btn.addEventListener('click', function () {
      selectedDuration = option.duration;
      renderPlanDurations();
      updatePlanSummary();
    });
    planDurationOptionsEl.appendChild(btn);
  });
}

function renderPlanItems() {
  planItemsOptionsEl.innerHTML = '';

  subscriptionData.eligibleItems.forEach(function (item) {
    const label = document.createElement('label');
    label.className = 'plan-item-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedItemIds.has(item.itemId);
    checkbox.addEventListener('change', function () {
      if (checkbox.checked) {
        selectedItemIds.add(item.itemId);
      } else {
        selectedItemIds.delete(item.itemId);
      }
      updatePlanSummary();
    });

    label.appendChild(checkbox);
    label.append(' ' + item.name);
    planItemsOptionsEl.appendChild(label);
  });
}

function updatePlanSummary() {
  const plan = findPlan(selectedPlanType);
  const durationOption = plan.durationOptions.find(function (option) { return option.duration === selectedDuration; });
  const currency = subscriptionData.currency;

  planPerDayEl.textContent = currency + ' ' + subscriptionData.perDayPrice.toLocaleString();
  planDurationDisplayEl.textContent = selectedDuration + ' days';
  planTotalEl.textContent = currency + ' ' + durationOption.total.toLocaleString();

  const chosenNames = subscriptionData.eligibleItems
    .filter(function (item) { return selectedItemIds.has(item.itemId); })
    .map(function (item) { return item.name; });

  const rotationText = chosenNames.length > 0
    ? ' Preferred platters: ' + chosenNames.join(', ') + '.'
    : '';

  const message = "Hi! I'd like to sign up for The Trim Spoon " + plan.label + ' (' + selectedDuration +
    ' days) — ' + currency + ' ' + durationOption.total + '.' + rotationText;

  planWhatsappBtn.href = 'https://wa.me/' + subscriptionData.whatsappNumber + '?text=' + encodeURIComponent(message);
}

function selectPlanType(planType) {
  selectedPlanType = planType;
  const plan = findPlan(planType);
  selectedDuration = plan.durationOptions[0].duration;

  planTabs.forEach(function (tab) {
    const isActive = tab.dataset.plan === planType;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });

  renderPlanDurations();
  updatePlanSummary();
}

planTabs.forEach(function (tab) {
  tab.addEventListener('click', function () {
    selectPlanType(tab.dataset.plan);
  });
});

async function loadSubscriptionPlans() {
  try {
    const response = await fetch(PLANS_ENDPOINT);
    if (!response.ok) throw new Error('Failed to load plans');

    subscriptionData = await response.json();
    selectedDuration = findPlan(selectedPlanType).durationOptions[0].duration;
    selectedItemIds = new Set(subscriptionData.eligibleItems.map(function (item) { return item.itemId; }));

    renderPlanDurations();
    renderPlanItems();
    updatePlanSummary();
  } catch (error) {
    planStatusEl.textContent = 'Could not load meal plans right now. Please try again later.';
    planStatusEl.hidden = false;
  }
}

if (planTabs.length > 0) {
  loadSubscriptionPlans();
}

// ---------- Menu card 3D flip ----------
// Click/tap toggles flip state; a plain click listener doesn't hijack touch
// scroll gestures the way touchstart/touchmove handling would.
function toggleFlip(card) {
  const isFlipped = card.classList.toggle('flipped');
  card.setAttribute('aria-pressed', String(isFlipped));
}

document.querySelectorAll('.flip-card').forEach(function (card) {
  card.addEventListener('click', function () {
    toggleFlip(card);
  });

  card.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleFlip(card);
    }
  });
});
