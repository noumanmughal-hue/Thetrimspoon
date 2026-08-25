const chatToggle = document.getElementById('chat-toggle');
const chatWindow = document.getElementById('chat-window');
const chatClose = document.getElementById('chat-close');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const navToggle = document.getElementById('nav-toggle');
const navLinks = document.querySelectorAll('.main-nav a');

const CHAT_ENDPOINT = '/api/chat';
const MAX_HISTORY = 12;
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

  if (conversationHistory.length === 0) {
    renderGoalChips();
  }
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

// Renders a small, fixed formatting subset (**bold** and "• " bullets) that the
// assistant's system prompt is instructed to use. Built entirely with textContent/
// createElement — never innerHTML — so AI-generated text can never inject markup.
function renderInlineBold(parent, lineText) {
  const parts = lineText.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  parts.forEach(function (part) {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      parent.appendChild(strong);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

function renderFormattedText(bubble, text) {
  const lines = text.split('\n');
  let currentList = null;

  lines.forEach(function (rawLine) {
    const line = rawLine.trim();

    if (!line) {
      currentList = null;
      return;
    }

    const bulletMatch = line.match(/^[•-]\s+(.*)$/);
    if (bulletMatch) {
      if (!currentList) {
        currentList = document.createElement('ul');
        bubble.appendChild(currentList);
      }
      const li = document.createElement('li');
      renderInlineBold(li, bulletMatch[1]);
      currentList.appendChild(li);
      return;
    }

    currentList = null;
    const p = document.createElement('p');
    renderInlineBold(p, line);
    bubble.appendChild(p);
  });
}

function addMessage(text, sender) {
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble ' + sender;
  if (sender === 'bot') {
    renderFormattedText(bubble, text);
  } else {
    bubble.textContent = text;
  }
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

// Answers a small set of static, non-order questions instantly from the same
// real data already shown elsewhere on the page — no API call, no token cost.
// Deliberately narrow (near-exact phrasing only): anything even slightly
// ambiguous should still reach the real assistant rather than risk a wrong
// canned answer.
const STATIC_ANSWERS = [
  {
    pattern: /^(what are |what're )?(your )?(hours|opening hours|business hours|timings)\??$|^are you open( now)?\??$|^when (do|are) you open\??$/i,
    answer: 'We\'re open Monday–Saturday 11:00 AM–11:00 PM, and Sunday 12:00 PM–10:00 PM.',
  },
  {
    pattern: /^where are you( located)?\??$|^what('s| is) your (address|location)\??$|^your (address|location)\??$/i,
    answer: 'We\'re a cloud kitchen at B-Block Satellite Town, near Hydri Chowk, Rawalpindi, Pakistan.',
  },
  {
    pattern: /^(what('s| is) your )?(phone|contact) number\??$|^your number\??$/i,
    answer: 'You can reach us at 0336-5402542.',
  },
];

function getStaticAnswer(text) {
  const trimmed = text.trim();
  const match = STATIC_ANSWERS.find(function (entry) {
    return entry.pattern.test(trimmed);
  });
  return match ? match.answer : null;
}

// Shared by the form submit and the goal chips / inline CTA buttons, so every
// entry point into the chat goes through the same request/render logic.
async function sendChatMessage(text) {
  removeGoalChips();
  addMessage(text, 'user');
  chatInput.value = '';

  const staticAnswer = getStaticAnswer(text);
  if (staticAnswer) {
    addMessage(staticAnswer, 'bot');
    return;
  }

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

    renderActions(Array.isArray(data.actions) ? data.actions : []);
  } catch (error) {
    typingBubble.remove();
    addMessage(NETWORK_ERROR_REPLY, 'bot');
  }
}

chatForm.addEventListener('submit', function (event) {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendChatMessage(text);
});

// ---------- AI Nutritionist welcome: goal chips on first open ----------
let hasShownGoalChips = false;

const GOAL_CHIP_OPTIONS = [
  { emoji: '🎯', label: 'Weight Loss / Fat Loss', message: "I'd like a weight loss / fat loss meal plan." },
  { emoji: '💪', label: 'Muscle Building / Bulk', message: "I'd like a muscle building / bulk meal plan." },
  { emoji: '⚖️', label: 'Maintain Health / Clean Eating', message: "I'd like a maintenance / clean eating meal plan." },
];

function removeGoalChips() {
  const existing = chatMessages.querySelector('.chat-chips');
  if (existing) existing.remove();
}

function renderGoalChips() {
  if (hasShownGoalChips) return;
  hasShownGoalChips = true;

  addMessage("Hi! I'm your AI Nutritionist 🥗 What's your goal today?", 'bot');

  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'chat-chips';
  chipsWrap.setAttribute('role', 'group');
  chipsWrap.setAttribute('aria-label', 'Choose your fitness goal');

  GOAL_CHIP_OPTIONS.forEach(function (option) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-chip';
    chip.textContent = option.emoji + ' ' + option.label;
    chip.addEventListener('click', function () {
      sendChatMessage(option.message);
    });
    chipsWrap.appendChild(chip);
  });

  chatMessages.appendChild(chipsWrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---------- Inline chat CTA buttons (from backend `actions`, never raw model HTML) ----------
function renderActions(actions) {
  actions.forEach(function (action) {
    if (action.type === 'add_plan_cta') {
      renderAddPlanCta(action);
    } else if (action.type === 'whatsapp_cta') {
      renderWhatsappCta(action);
    }
  });
}

function renderAddPlanCta(action) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-cta-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chat-cta chat-cta--primary';
  btn.textContent = action.label;

  btn.addEventListener('click', async function () {
    btn.disabled = true;
    btn.textContent = 'Adding…';

    try {
      const response = await fetch('/api/cart/add-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: action.itemIds }),
      });
      const data = await response.json().catch(function () {
        return null;
      });

      if (!response.ok || !data || !data.success) {
        btn.disabled = false;
        btn.textContent = action.label;
        addMessage((data && data.error) || 'Could not add the plan to your order. Please try again.', 'bot');
        return;
      }

      wrapper.remove();
      addMessage('✅ Added your 3-day plan to the order. Subtotal so far: ' + data.order.currency + ' ' + data.order.subtotal.toLocaleString() + '.', 'bot');
    } catch (error) {
      btn.disabled = false;
      btn.textContent = action.label;
      addMessage(NETWORK_ERROR_REPLY, 'bot');
    }
  });

  wrapper.appendChild(btn);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderWhatsappCta(action) {
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-cta-wrap';

  const link = document.createElement('a');
  link.className = 'chat-cta chat-cta--whatsapp';
  link.href = action.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = action.label;

  wrapper.appendChild(link);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---------- Meal Prep Subscriptions ----------
// Reads static plan config from the backend and computes totals client-side —
// no LLM call involved in browsing or pricing a plan.
const PLANS_ENDPOINT = '/api/subscriptions';
const subscriptionGrid = document.getElementById('subscription-grid');
const planStatusEl = document.getElementById('plan-status');

// The 3 showcase durations, mapped onto the real weekly/monthly plan data
// (6/7-day weekly, 30-day monthly) — every price still comes from the API.
const SHOWCASE_PLANS = [
  { planType: 'weekly', duration: 6, title: '6-Day Weekly Plan', note: 'Delivered 6 days a week — Monday through Saturday.' },
  { planType: 'weekly', duration: 7, title: '7-Day Weekly Plan', note: 'Full 7-day coverage, delivered every day of the week.' },
  { planType: 'monthly', duration: 30, title: '30-Day Monthly Plan', note: 'A full month of daily deliveries — our best value for long-term consistency.' },
];

function average(numbers) {
  return Math.round(numbers.reduce(function (sum, n) { return sum + n; }, 0) / numbers.length);
}

function buildSubscriptionCard(data, config) {
  const plan = data.plans.find(function (p) { return p.planType === config.planType; });
  const durationOption = plan.durationOptions.find(function (option) { return option.duration === config.duration; });
  const currency = data.currency;

  const calories = data.eligibleItems.map(function (item) { return item.calories; }).filter(function (v) { return typeof v === 'number'; });
  const protein = data.eligibleItems.map(function (item) { return item.protein; }).filter(function (v) { return typeof v === 'number'; });

  const message = "Hi! I'd like to sign up for The Trim Spoon " + config.title + ' (' + config.duration +
    ' days) — ' + currency + ' ' + durationOption.total + '.';
  const whatsappUrl = 'https://wa.me/' + data.whatsappNumber + '?text=' + encodeURIComponent(message);

  const card = document.createElement('article');
  card.className = 'subscription-card';

  const title = document.createElement('h3');
  title.className = 'subscription-card-title';
  title.textContent = config.title;

  const note = document.createElement('p');
  note.className = 'subscription-card-note';
  note.textContent = config.note;

  const macros = document.createElement('p');
  macros.className = 'subscription-card-macros';
  macros.textContent = calories.length > 0
    ? 'Platters average ~' + average(calories) + ' kcal & ' + average(protein) + 'g protein each'
    : '';

  const price = document.createElement('div');
  price.className = 'subscription-card-price';

  const total = document.createElement('span');
  total.className = 'subscription-card-total';
  total.textContent = currency + ' ' + durationOption.total.toLocaleString();

  const perDay = document.createElement('span');
  perDay.className = 'subscription-card-per-day';
  perDay.textContent = currency + ' ' + data.perDayPrice.toLocaleString() + ' / day × ' + config.duration + ' days';

  price.appendChild(total);
  price.appendChild(perDay);

  const btn = document.createElement('a');
  btn.className = 'btn btn-primary subscription-card-btn';
  btn.href = whatsappUrl;
  btn.target = '_blank';
  btn.rel = 'noopener noreferrer';
  btn.setAttribute('aria-label', 'Subscribe to the ' + config.title + ' via WhatsApp');
  btn.textContent = 'Subscribe via WhatsApp';

  card.appendChild(title);
  card.appendChild(note);
  if (macros.textContent) card.appendChild(macros);
  card.appendChild(price);
  card.appendChild(btn);

  return card;
}

async function loadSubscriptionPlans() {
  try {
    const response = await fetch(PLANS_ENDPOINT);
    if (!response.ok) throw new Error('Failed to load plans');

    const data = await response.json();
    subscriptionGrid.innerHTML = '';
    SHOWCASE_PLANS.forEach(function (config) {
      subscriptionGrid.appendChild(buildSubscriptionCard(data, config));
    });
  } catch (error) {
    planStatusEl.textContent = 'Could not load meal plans right now. Please try again later.';
    planStatusEl.hidden = false;
  }
}

if (subscriptionGrid) {
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

// ---------- Macro goal filter ----------
const goalPills = document.querySelectorAll('.goal-pill');
// General fitness-guideline daily protein target (grams) for the stated calorie
// goal — informational only, not tied to any individual customer's real intake.
const GOAL_PROTEIN_TARGETS = { cut: 140, balanced: 120, bulk: 160 };

function applyGoalFilter(goal) {
  document.querySelectorAll('#power-platters .menu-card[data-category]').forEach(function (card) {
    const badge = card.querySelector('.goal-match-badge');

    if (goal === 'all') {
      card.classList.remove('goal-dim', 'goal-match');
      if (badge) {
        badge.hidden = true;
        badge.textContent = '';
      }
      return;
    }

    const matches = card.dataset.category === goal;
    card.classList.toggle('goal-match', matches);
    card.classList.toggle('goal-dim', !matches);

    if (!badge) return;

    if (matches) {
      const protein = Number(card.dataset.protein);
      const target = GOAL_PROTEIN_TARGETS[goal];
      const pct = Math.round((protein / target) * 100);
      badge.textContent = 'Provides ' + pct + '% of daily protein target';
      badge.hidden = false;
    } else {
      badge.hidden = true;
      badge.textContent = '';
    }
  });
}

function selectGoalPill(pill) {
  goalPills.forEach(function (p) {
    const isSelected = p === pill;
    p.classList.toggle('active', isSelected);
    p.setAttribute('aria-checked', String(isSelected));
    p.tabIndex = isSelected ? 0 : -1;
  });
  pill.focus();
  applyGoalFilter(pill.dataset.goal);
}

goalPills.forEach(function (pill, index) {
  pill.addEventListener('click', function () {
    selectGoalPill(pill);
  });

  pill.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      selectGoalPill(goalPills[(index + 1) % goalPills.length]);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectGoalPill(goalPills[(index - 1 + goalPills.length) % goalPills.length]);
    }
  });
});

// ---------- Mobile quick-order bar ----------
const mobileNutritionistBtn = document.getElementById('mobile-nutritionist-btn');
if (mobileNutritionistBtn) {
  mobileNutritionistBtn.addEventListener('click', openChat);
}
