const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { neon } = require('@neondatabase/serverless');

// neon() throws synchronously if DATABASE_URL is missing/invalid — guarded so a
// misconfigured or not-yet-provisioned database can't crash the entire app (chat,
// menu, everything) at module load. Order/staff routes fail closed with a clear
// error instead; see requireOrdersDb().
let sql = null;
try {
  if (process.env.DATABASE_URL) sql = neon(process.env.DATABASE_URL);
} catch (error) {
  console.error('Failed to initialize database connection:', error.message);
}

function requireOrdersDb() {
  if (!sql) {
    throw new Error('Order storage is not configured: set DATABASE_URL in the environment.');
  }
  return sql;
}

const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  });
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

const client = new Anthropic();
const SYSTEM_PROMPT = fs.readFileSync(
  path.resolve(__dirname, '..', 'prompts', 'system-prompt.md'),
  'utf8'
);
const MENU_DATA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'data', 'menu.json'), 'utf8')
);
const PROMOTIONS_DATA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'data', 'promotions.json'), 'utf8')
);
const FEES_DATA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'data', 'fees.json'), 'utf8')
);
const SUBSCRIPTIONS_DATA = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'data', 'subscriptions.json'), 'utf8')
);
const FULL_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

## Hours

${JSON.stringify(MENU_DATA.hours)}

Allergen disclaimer: ${MENU_DATA.allergenDisclaimer}

Use the getMenu tool to look up menu items, prices, sizes, and options. Never invent menu items, prices, or hours not returned by the tool or listed above.

## Delivery fees by city

${JSON.stringify(FEES_DATA.deliveryFeesByCity)} (${FEES_DATA.currency}, fixed per order — not distance-based). Only these two cities are currently supported for delivery. If the customer's city isn't one of these two, or hasn't been given yet, ask them to confirm which one applies before calling setDeliveryDetails — never guess a city or apply a different fee. The actual delivery fee and total for an order always come from getOrderTotal, never calculated here.`;

const CACHED_SYSTEM_PROMPT = [
  { type: 'text', text: FULL_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
];

const TOOLS = [
  {
    name: 'getMenu',
    description:
      "Get The Trim Spoon's current menu, grouped by category, limited to active (available) items with their prices, sizes, options, and allergens.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'addItemToCart',
    description:
      'Add a valid, active menu item to the current order. Validates the item id against the menu and that any required options are provided. If required options are missing, it returns which ones instead of adding the item — ask the customer for them rather than guessing.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The id of the menu item, from getMenu.' },
        quantity: { type: 'integer', minimum: 1, description: 'How many to add. Defaults to 1.' },
        options: {
          type: 'object',
          description: 'Map of option group name to the choice the customer picked, for any options the item has.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'modifyItem',
    description:
      "Adjust the quantity, size, and/or options of an item already in the order. Validates changes against the menu — an unknown size is rejected, and if the resulting options leave a required option group unset, it returns which ones instead of applying the change. Ask the customer for missing options rather than guessing.",
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The id of the order item to modify (matches the id used when it was added).' },
        quantity: { type: 'integer', minimum: 1, description: 'New quantity for the item, if changing.' },
        size: { type: 'string', description: "New size for the item, if changing. Must match the item's valid size." },
        options: {
          type: 'object',
          description: 'Map of option group name to the new choice, merged into the item\'s existing options.',
        },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'removeItem',
    description:
      'Remove an item from the order, or reduce its quantity. If quantity is given and less than the current quantity, that many are removed and the rest stay; otherwise the item is removed entirely.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The id of the order item to remove (matches the id used when it was added).' },
        quantity: { type: 'integer', minimum: 1, description: 'How many to remove. Omit to remove the item entirely.' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'viewCart',
    description:
      'Get a concise, itemized summary of the current order — each item, its quantity, and any customizations. Does not include totals or pricing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'getRecommendations',
    description:
      'Get up to 2 real menu add-ons relevant to the current order, to optionally suggest to the customer. Only ever returns actual menu items — never invent a suggestion yourself. Excludes items already in the order and items the customer already declined this session. May return an empty list if there is nothing left to suggest.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'declineRecommendation',
    description:
      "Record that the customer turned down a suggested item, so getRecommendations won't suggest it again this session. Call this when the customer says no to a recommendation.",
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'The id of the declined menu item, from the recommendation.' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'applyPromotion',
    description:
      "Check and/or apply an active promotion from data/promotions.json against the current order. Call with no promotionId to see which active promotions the order currently qualifies for — only ever mention promotions this tool returns as eligible, never a discount or code the customer names that isn't recognized here. Call with a promotionId to apply that specific promotion; it is rejected if it isn't an active, recognized promotion or if eligibility isn't met. Some promotions require confirming something with the customer first (e.g. that this is their first order) — pass isNewCustomer only after asking, never assume it. This tool's own result does not include tax or delivery fee and is never the final total — after applying a promotion, call getOrderTotal or getOrderSummary for the authoritative total before presenting one to the customer.",
    input_schema: {
      type: 'object',
      properties: {
        promotionId: {
          type: 'string',
          description: 'The id of a specific promotion to apply, from a prior eligibility check. Omit to just check eligibility.',
        },
        isNewCustomer: {
          type: 'boolean',
          description: "Whether the customer has confirmed this is their first order. Required for promotions that need it — ask, don't guess.",
        },
      },
    },
  },
  {
    name: 'getOrderStatus',
    description:
      "Check pickup/delivery checkout details already on file for this order — order type, customer name, and whichever fields apply to that order type (pickup time, or phone/address/apartment/delivery instructions). Call this before asking the customer for anything so you only ask for what's actually missing.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'setPickupDetails',
    description:
      "Record pickup selection details: the customer's name and, optionally, a pickup time. Sets the order type to pickup. Only pass fields the customer actually gave you — omit a field rather than guessing it.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The customer's name for the pickup order." },
        pickupTime: { type: 'string', description: 'Requested pickup time, if the customer gave one. Optional.' },
      },
    },
  },
  {
    name: 'setDeliveryDetails',
    description:
      "Record delivery order details: the customer's name, phone number, full delivery address, city, apartment/unit if applicable, and delivery instructions. Sets the order type to delivery. Only pass fields the customer actually gave you — never guess or fill in a field they didn't provide.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The customer's name for the delivery order." },
        phone: { type: 'string', description: "The customer's phone number." },
        address: { type: 'string', description: 'Full delivery address (street, etc) — not including city.' },
        city: { type: 'string', description: 'Delivery city, exactly as confirmed by the customer — must be "Rawalpindi" or "Islamabad", the only two currently supported.' },
        apartmentUnit: { type: 'string', description: 'Apartment or unit number, if applicable to the address.' },
        deliveryInstructions: { type: 'string', description: 'Delivery instructions, if the customer gave any (e.g. gate code, leave at door).' },
      },
    },
  },
  {
    name: 'getOrderTotal',
    description:
      "Get the deterministic order total: subtotal (from real, current menu prices — never a stored or remembered price), any still-valid applied promotion discount, tax, delivery fee (pickup orders have none), and the final total. Always call this for the total instead of calculating or stating one yourself.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'getOrderSummary',
    description:
      "Get the complete structured order summary for checkout in one call: items with quantities and customizations, fulfillment details (pickup or delivery), any still-valid applied promotion, and the deterministic total. Call this before checkout and restate exactly what it returns for the customer's confirmation — don't assemble the summary yourself from memory.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'finalizeOrder',
    description:
      "The only way to finalize/save the order. Rejects unless the customer already saw the current getOrderSummary (nothing changed since) and customerConfirmed is true. Only pass customerConfirmed: true when the customer's reply is an explicit, unambiguous confirmation after reviewing that summary — never for a vague or unclear reply, and never guess it. On success it saves the order (with a new order ID, timestamp, and status NEW) and returns that order ID.",
    input_schema: {
      type: 'object',
      properties: {
        customerConfirmed: {
          type: 'boolean',
          description: "True only if the customer explicitly and unambiguously confirmed the order after seeing its final summary. Anything vague or unclear is not confirmation — do not pass true for it.",
        },
      },
      required: ['customerConfirmed'],
    },
  },
  {
    name: 'getSubscriptionPlans',
    description:
      'Get the available weekly and monthly meal plan options: valid durations, per-day price, and the deterministic total for each duration. Use this to answer any question about subscription/meal plan pricing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'calculateSubscriptionPrice',
    description:
      'Get the deterministic price for a specific weekly/monthly plan selection. Always use this instead of calculating a plan total yourself.',
    input_schema: {
      type: 'object',
      properties: {
        planType: { type: 'string', enum: ['weekly', 'monthly'], description: 'Which plan type.' },
        duration: { type: 'integer', description: 'Number of days, from getSubscriptionPlans durationOptions for that planType.' },
        dailyItemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'One Power Platter item id per day of the plan (length must equal duration) — the customer\'s daily rotation, from getMenu or getSubscriptionPlans.',
        },
      },
      required: ['planType', 'duration', 'dailyItemIds'],
    },
  },
  {
    name: 'getSubscriptionWhatsAppLink',
    description:
      "Build a pre-filled WhatsApp link to sign up for a weekly/monthly plan, with the deterministic price and chosen platters already in the message. Always use this for a plan checkout/inquiry instead of writing the message yourself. Share the returned url with the customer.",
    input_schema: {
      type: 'object',
      properties: {
        planType: { type: 'string', enum: ['weekly', 'monthly'], description: 'Which plan type.' },
        duration: { type: 'integer', description: 'Number of days, from getSubscriptionPlans durationOptions for that planType.' },
        dailyItemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'One Power Platter item id per day of the plan (length must equal duration).',
        },
        customerName: { type: 'string', description: "The customer's name, if they gave one. Optional." },
      },
      required: ['planType', 'duration', 'dailyItemIds'],
    },
  },
  {
    name: 'getGoalMealPlan',
    description:
      "Get a deterministic 3-day Power Platter combination for a fitness goal, with each day's real item name, calories, protein, and price plus 3-day totals. Use this whenever a customer states or picks a fitness goal (weight loss/cut, muscle gain/bulk, or maintenance/balanced) — never invent a meal plan or its macros/prices yourself.",
    input_schema: {
      type: 'object',
      properties: {
        goal: { type: 'string', enum: ['cut', 'bulk', 'balanced'], description: "'cut' for weight loss/fat loss, 'bulk' for muscle gain, 'balanced' for maintenance/clean eating." },
      },
      required: ['goal'],
    },
  },
  {
    name: 'getWhatsAppOrderLink',
    description:
      "Build a pre-filled WhatsApp link listing the items currently in the order (from addItemToCart), for a customer who wants to complete checkout on WhatsApp instead of in this chat. Rejects if the cart is empty. The subtotal it returns does not include tax or delivery — mention it as a subtotal, not the final total.",
    input_schema: { type: 'object', properties: {} },
    cache_control: { type: 'ephemeral' },
  },
];

const MAX_TOOL_TURNS = 6;

// Nutrition facts are for the on-page flip cards only — stripped here so they
// never cost tokens in the agent's context (never asked about, never invented).
function getMenu() {
  const categories = MENU_DATA.categories
    .map((category) => ({
      ...category,
      items: category.items
        .filter((item) => item.available)
        .map(({ nutrition, ...item }) => item),
    }))
    .filter((category) => category.items.length > 0);

  return { categories };
}

function findMenuItem(itemId) {
  for (const category of MENU_DATA.categories) {
    const item = category.items.find((candidate) => candidate.id === itemId);
    if (item) return item;
  }
  return null;
}

const MAX_CART_LINE_ITEMS = 50;

function addItemToCart(orderState, input) {
  const { itemId, quantity, options } = input || {};
  const item = findMenuItem(itemId);

  if (!item || !item.available) {
    return { success: false, error: `No active menu item with id "${itemId}".` };
  }

  if (orderState.items.length >= MAX_CART_LINE_ITEMS) {
    return { success: false, error: `This order already has the maximum of ${MAX_CART_LINE_ITEMS} line items. Remove something before adding more.` };
  }

  const qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const providedOptions = options && typeof options === 'object' ? options : {};

  const requiredGroups = (item.options || []).filter((group) => group.required);
  const missingGroups = requiredGroups
    .filter((group) => !(group.name in providedOptions))
    .map((group) => group.name);

  if (missingGroups.length > 0) {
    return {
      success: false,
      needsOptions: missingGroups,
      message: `Missing required options for ${item.name}: ${missingGroups.join(', ')}. Ask the customer to choose — do not guess.`,
    };
  }

  const lineItem = {
    itemId: item.id,
    name: item.name,
    quantity: qty,
    options: providedOptions,
    price: item.price,
  };

  orderState.items.push(lineItem);
  orderState.total = orderState.items.reduce((sum, li) => sum + li.price * li.quantity, 0);

  return { success: true, addedItem: lineItem, order: orderState };
}

function modifyItem(orderState, input) {
  const { itemId, quantity, size, options } = input || {};

  const lineItem = orderState.items.find((li) => li.itemId === itemId);
  if (!lineItem) {
    return { success: false, error: `No item with id "${itemId}" in the order.` };
  }

  const menuItem = findMenuItem(itemId);
  if (!menuItem || !menuItem.available) {
    return { success: false, error: `"${itemId}" is no longer an active menu item.` };
  }

  if (quantity !== undefined) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { success: false, error: 'quantity must be a positive integer.' };
    }
  }

  if (size !== undefined && size !== menuItem.size) {
    return {
      success: false,
      error: `"${size}" isn't a valid size for ${menuItem.name}. Valid size: ${menuItem.size}.`,
    };
  }

  if (options !== undefined) {
    const mergedOptions = { ...lineItem.options, ...(options && typeof options === 'object' ? options : {}) };
    const requiredGroups = (menuItem.options || []).filter((group) => group.required);
    const missingGroups = requiredGroups
      .filter((group) => !(group.name in mergedOptions))
      .map((group) => group.name);

    if (missingGroups.length > 0) {
      return {
        success: false,
        needsOptions: missingGroups,
        message: `Missing required options for ${menuItem.name}: ${missingGroups.join(', ')}. Ask the customer to choose — do not guess.`,
      };
    }

    lineItem.options = mergedOptions;
  }

  if (quantity !== undefined) lineItem.quantity = quantity;
  if (size !== undefined) lineItem.size = size;
  lineItem.price = menuItem.price;

  orderState.total = orderState.items.reduce((sum, li) => sum + li.price * li.quantity, 0);

  return { success: true, updatedItem: lineItem, order: orderState };
}

function removeItem(orderState, input) {
  const { itemId, quantity } = input || {};

  const index = orderState.items.findIndex((li) => li.itemId === itemId);
  if (index === -1) {
    return { success: false, error: `No item with id "${itemId}" in the order.` };
  }

  const lineItem = orderState.items[index];

  if (quantity !== undefined) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      return { success: false, error: 'quantity must be a positive integer.' };
    }

    if (quantity < lineItem.quantity) {
      lineItem.quantity -= quantity;
      orderState.total = orderState.items.reduce((sum, li) => sum + li.price * li.quantity, 0);
      return { success: true, removedQuantity: quantity, updatedItem: lineItem, order: orderState };
    }
  }

  orderState.items.splice(index, 1);
  orderState.total = orderState.items.reduce((sum, li) => sum + li.price * li.quantity, 0);

  return { success: true, removedItem: lineItem, order: orderState };
}

function viewCart(orderState) {
  const items = orderState.items.map((li) => ({
    name: li.name,
    quantity: li.quantity,
    options: li.options,
  }));

  return { items };
}

function getRecommendations(orderState) {
  if (orderState.items.length === 0) {
    return { recommendations: [] };
  }

  const inCartIds = new Set(orderState.items.map((li) => li.itemId));
  const declinedIds = new Set(orderState.declinedRecommendations);

  const addOnCategory = MENU_DATA.categories.find((category) => category.id === 'protein-side-add-ons');
  const candidates = addOnCategory
    ? addOnCategory.items.filter(
        (item) => item.available && !inCartIds.has(item.id) && !declinedIds.has(item.id)
      )
    : [];

  const recommendations = candidates.slice(0, 2).map((item) => ({
    itemId: item.id,
    name: item.name,
    price: item.price,
    description: item.description,
  }));

  return { recommendations };
}

function declineRecommendation(orderState, input) {
  const { itemId } = input || {};
  if (!itemId || typeof itemId !== 'string') {
    return { success: false, error: 'itemId is required.' };
  }

  if (!orderState.declinedRecommendations.includes(itemId)) {
    orderState.declinedRecommendations.push(itemId);
  }

  return { success: true, declinedItemId: itemId };
}

function parseClockTime(timeStr) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((timeStr || '').trim());
  if (!match) return null;
  let hour = parseInt(match[1], 10) % 12;
  if (/pm/i.test(match[3])) hour += 12;
  return hour * 60 + parseInt(match[2], 10);
}

// Promotions are defined in store-local time (Asia/Karachi), independent of server timezone.
function getStoreNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi',
    weekday: 'long',
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: get('weekday'),
    minutesSinceMidnight: parseClockTime(`${get('hour')}:${get('minute')} ${get('dayPeriod')}`),
  };
}

function checkPromotionEligibility(promo, orderState, input) {
  const reasons = [];
  const elig = promo.eligibility || {};

  if (typeof elig.minOrderAmount === 'number' && orderState.total < elig.minOrderAmount) {
    reasons.push(`Order total (PKR ${orderState.total}) is below the minimum of PKR ${elig.minOrderAmount}.`);
  }

  if (Array.isArray(elig.days) && elig.days.length > 0) {
    const { weekday } = getStoreNow();
    if (!elig.days.includes(weekday)) {
      reasons.push(`Only valid ${elig.days.join(', ')} — today is ${weekday}.`);
    }
  }

  if (elig.timeWindow) {
    const { minutesSinceMidnight } = getStoreNow();
    const start = parseClockTime(elig.timeWindow.start);
    const end = parseClockTime(elig.timeWindow.end);
    if (start === null || end === null || minutesSinceMidnight < start || minutesSinceMidnight > end) {
      reasons.push(`Only valid between ${elig.timeWindow.start} and ${elig.timeWindow.end}.`);
    }
  }

  if (elig.newCustomerOnly && input.isNewCustomer !== true) {
    reasons.push("Requires confirming this is the customer's first order.");
  }

  if (elig.seasonalWindow) {
    reasons.push('This promotion\'s seasonal availability is not configured for automatic verification.');
  }

  return { eligible: reasons.length === 0, reasons };
}

function applyPromotion(orderState, input) {
  const { promotionId, isNewCustomer } = input || {};
  const activePromotions = (PROMOTIONS_DATA.promotions || []).filter((promo) => promo.active);

  if (!promotionId) {
    const eligible = [];
    const ineligible = [];
    for (const promo of activePromotions) {
      const result = checkPromotionEligibility(promo, orderState, { isNewCustomer });
      const summary = { promotionId: promo.id, name: promo.name, rule: promo.rule };
      if (result.eligible) {
        eligible.push(summary);
      } else {
        ineligible.push({ ...summary, reasons: result.reasons });
      }
    }
    return { eligible, ineligible };
  }

  const promo = activePromotions.find((candidate) => candidate.id === promotionId);
  if (!promo) {
    return {
      success: false,
      error: `"${promotionId}" is not a recognized active promotion. Never apply or mention a discount that isn't one of the active promotions returned by this tool.`,
    };
  }

  const result = checkPromotionEligibility(promo, orderState, { isNewCustomer });
  if (!result.eligible) {
    return { success: false, promotionId: promo.id, reasons: result.reasons };
  }

  const discountAmount =
    promo.discountType === 'percentage'
      ? Math.round(orderState.total * (promo.discountValue / 100))
      : promo.discountValue;

  orderState.discount = {
    promotionId: promo.id,
    name: promo.name,
    discountType: promo.discountType,
    discountValue: promo.discountValue,
    isNewCustomer: isNewCustomer === true,
  };

  return {
    success: true,
    appliedPromotion: { promotionId: promo.id, name: promo.name },
    subtotal: orderState.total,
    discountAmount,
    note: 'This does not include tax or delivery fee. Call getOrderTotal or getOrderSummary for the authoritative final total before presenting it to the customer.',
  };
}

// The only place the final order total is computed. Always re-derives prices from
// MENU_DATA (never trusts a stale stored price) and re-validates any applied
// discount against the current order before using it — the model never calculates
// or invents any part of this.
function getOrderTotal(orderState) {
  const unavailableItems = [];
  let subtotal = 0;

  for (const lineItem of orderState.items) {
    const menuItem = findMenuItem(lineItem.itemId);
    if (!menuItem || !menuItem.available) {
      unavailableItems.push(lineItem.itemId);
      continue;
    }
    subtotal += menuItem.price * lineItem.quantity;
  }

  let discountAmount = 0;
  let appliedPromotion = null;
  let discountRemoved = null;

  if (orderState.discount) {
    const promo = (PROMOTIONS_DATA.promotions || []).find(
      (candidate) => candidate.id === orderState.discount.promotionId && candidate.active
    );

    if (!promo) {
      discountRemoved = 'This promotion is no longer active.';
      orderState.discount = null;
    } else {
      const result = checkPromotionEligibility(promo, { total: subtotal }, { isNewCustomer: orderState.discount.isNewCustomer });
      if (!result.eligible) {
        discountRemoved = `No longer eligible: ${result.reasons.join(' ')}`;
        orderState.discount = null;
      } else {
        discountAmount =
          promo.discountType === 'percentage' ? Math.round(subtotal * (promo.discountValue / 100)) : promo.discountValue;
        appliedPromotion = { promotionId: promo.id, name: promo.name };
      }
    }
  }

  const amountAfterDiscount = subtotal - discountAmount;
  const taxRate = FEES_DATA.taxRate;
  const tax = Math.round(amountAfterDiscount * taxRate);

  let deliveryFee = 0;
  let deliveryFeeNote = null;

  if (orderState.orderType === 'delivery') {
    const city = orderState.customerDetails.city;
    const cityFee = city ? FEES_DATA.deliveryFeesByCity[city] : undefined;
    if (cityFee === undefined) {
      deliveryFee = null;
      deliveryFeeNote = `Delivery fee not yet determined — confirm with the customer whether they're in ${Object.keys(FEES_DATA.deliveryFeesByCity).join(' or ')} before stating a total.`;
    } else {
      deliveryFee = cityFee;
    }
  }

  const total = deliveryFee === null ? null : amountAfterDiscount + tax + deliveryFee;

  return {
    currency: FEES_DATA.currency,
    subtotal,
    appliedPromotion,
    discountAmount,
    discountRemoved,
    taxRate,
    tax,
    deliveryFee,
    deliveryFeeNote,
    total,
    unavailableItems,
  };
}

function getOrderStatus(orderState) {
  const details = orderState.customerDetails;

  if (orderState.orderType === 'delivery') {
    const missingRequiredFields = ['name', 'phone', 'address', 'city'].filter((field) => !details[field]);
    return {
      orderType: 'delivery',
      customerName: details.name || null,
      phone: details.phone || null,
      address: details.address || null,
      city: details.city || null,
      apartmentUnit: details.apartmentUnit || null,
      deliveryInstructions: details.deliveryInstructions || null,
      missingRequiredFields,
    };
  }

  const missingRequiredFields = details.name ? [] : ['name'];
  return {
    orderType: orderState.orderType,
    customerName: details.name || null,
    pickupTime: details.pickupTime || null,
    missingRequiredFields,
  };
}

function setPickupDetails(orderState, input) {
  const { name, pickupTime } = input || {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return { success: false, error: 'name must be a non-empty string.' };
    }
    orderState.customerDetails.name = name.trim();
  }

  if (pickupTime !== undefined) {
    if (typeof pickupTime !== 'string' || !pickupTime.trim()) {
      return { success: false, error: 'pickupTime must be a non-empty string.' };
    }
    orderState.customerDetails.pickupTime = pickupTime.trim();
  }

  orderState.orderType = 'pickup';

  return {
    success: true,
    orderType: orderState.orderType,
    customerName: orderState.customerDetails.name || null,
    pickupTime: orderState.customerDetails.pickupTime || null,
  };
}

function setDeliveryDetails(orderState, input) {
  const { name, phone, address, city, apartmentUnit, deliveryInstructions } = input || {};
  const fields = { name, phone, address, apartmentUnit, deliveryInstructions };

  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      return { success: false, error: `${field} must be a non-empty string.` };
    }
    orderState.customerDetails[field] = value.trim();
  }

  if (city !== undefined) {
    const supportedCities = Object.keys(FEES_DATA.deliveryFeesByCity);
    const matchedCity = supportedCities.find((candidate) => candidate.toLowerCase() === String(city).trim().toLowerCase());
    if (!matchedCity) {
      return { success: false, error: `city must be one of: ${supportedCities.join(', ')}.` };
    }
    orderState.customerDetails.city = matchedCity;
  }

  orderState.orderType = 'delivery';

  const details = orderState.customerDetails;
  return {
    success: true,
    orderType: orderState.orderType,
    customerName: details.name || null,
    phone: details.phone || null,
    address: details.address || null,
    city: details.city || null,
    apartmentUnit: details.apartmentUnit || null,
    deliveryInstructions: details.deliveryInstructions || null,
  };
}

// Composes the existing tools' own logic — never recomputes items, fulfillment,
// or pricing itself — so it can't drift from what viewCart/getOrderStatus/
// getOrderTotal individually report.
function getOrderSummary(orderState) {
  const summary = {
    items: viewCart(orderState).items,
    fulfillment: getOrderStatus(orderState),
    pricing: getOrderTotal(orderState),
  };
  orderState.lastSummarySnapshot = JSON.stringify(summary);
  return summary;
}

// The only path that can mark an order confirmed. Whether the customer's reply was
// actually an explicit confirmation is a judgment call made by the model when it sets
// customerConfirmed — this function can't read the conversation — but it deterministically
// refuses to finalize unless that flag is strictly true AND the order is exactly what was
// last shown via getOrderSummary (nothing changed since, and nothing was ever skipped).
async function finalizeOrder(orderState, input) {
  const { customerConfirmed } = input || {};

  if (orderState.confirmed) {
    return { success: false, error: 'This order has already been finalized.' };
  }

  if (orderState.items.length === 0) {
    return { success: false, error: 'Cannot finalize an empty order.' };
  }

  if (customerConfirmed !== true) {
    return {
      success: false,
      error:
        'Not finalized: customerConfirmed must be explicitly true. A vague or ambiguous reply does not count — ask the customer to clearly confirm or correct the order.',
    };
  }

  const previouslyShownSnapshot = orderState.lastSummarySnapshot;
  const currentSummary = getOrderSummary(orderState); // refreshes orderState.lastSummarySnapshot as a side effect
  const freshSnapshot = JSON.stringify(currentSummary);

  if (!previouslyShownSnapshot || previouslyShownSnapshot !== freshSnapshot) {
    return {
      success: false,
      error:
        'Not finalized: the order summary the customer confirmed is out of date or was never shown. Call getOrderSummary again, have the customer review the current version, and get fresh confirmation.',
    };
  }

  if (currentSummary.fulfillment.missingRequiredFields.length > 0) {
    return {
      success: false,
      error: `Not finalized: missing required fulfillment details: ${currentSummary.fulfillment.missingRequiredFields.join(', ')}.`,
    };
  }

  if (currentSummary.pricing.unavailableItems.length > 0) {
    return {
      success: false,
      error: `Not finalized: some items are no longer available: ${currentSummary.pricing.unavailableItems.join(', ')}. Update the order and get fresh confirmation.`,
    };
  }

  // Only reachable once every gate above has passed, so a draft/unconfirmed order can
  // never be saved. Persist before marking confirmed in memory, so a write failure
  // leaves the order retriable rather than falsely marked done.
  const savedOrder = await saveConfirmedOrder(currentSummary);

  orderState.confirmed = true;
  orderState.status = 'confirmed';

  // Built server-side from the just-saved, already-validated summary — never from
  // model-authored text — same safe-URL pattern as getWhatsAppOrderLink.
  const itemsText = currentSummary.items.map((lineItem) => `${lineItem.quantity}x ${lineItem.name}`).join(', ');
  const pricing = currentSummary.pricing;
  const cityText = currentSummary.fulfillment.orderType === 'delivery' ? ` | City: ${currentSummary.fulfillment.city}` : '';
  const confirmationMessage =
    `Order Confirmation: ${itemsText} | Order ID: ${savedOrder.orderId}${cityText} | ` +
    `Delivery: ${pricing.deliveryFee != null ? `${pricing.currency} ${pricing.deliveryFee}` : 'N/A'} | ` +
    `Total: ${pricing.currency} ${pricing.total}`;

  return {
    success: true,
    order: currentSummary,
    orderId: savedOrder.orderId,
    timestamp: savedOrder.timestamp,
    whatsappConfirmation: {
      message: confirmationMessage,
      url: `https://wa.me/${SUBSCRIPTIONS_DATA.whatsappNumber}?text=${encodeURIComponent(confirmationMessage)}`,
    },
  };
}

// Orders are persisted in Postgres (Vercel Postgres / Neon) — real orders must survive
// redeploys and be visible from any serverless instance, which a local file can't do
// (Vercel's filesystem is read-only outside /tmp, and /tmp is ephemeral and per-instance).
// customerName/phone/orderType/total/currency are denormalized onto real columns purely
// so search/filter/sort can be plain indexed SQL; items/fulfillment/pricing stay as JSONB
// so the exact existing order shape round-trips unchanged for the dashboard to render.
// Lazily created once per serverless instance (cold start) and reused — CREATE TABLE
// IF NOT EXISTS is cheap/idempotent, but every order-touching call still awaits this
// so the very first request on a fresh instance can't race the table's existence.
let ordersTableReady = null;
function getOrdersTableReady() {
  if (!ordersTableReady) ordersTableReady = ensureOrdersTable();
  return ordersTableReady;
}

async function ensureOrdersTable() {
  requireOrdersDb();
  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      order_id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL,
      order_type TEXT,
      customer_name TEXT,
      phone TEXT,
      currency TEXT,
      total NUMERIC,
      items JSONB NOT NULL,
      fulfillment JSONB NOT NULL,
      pricing JSONB NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)`;
  await sql`CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC)`;
}

function rowToOrder(row) {
  return {
    orderId: row.order_id,
    timestamp: row.created_at.toISOString(),
    status: row.status,
    items: row.items,
    fulfillment: row.fulfillment,
    pricing: row.pricing,
  };
}

async function saveConfirmedOrder(summary) {
  await getOrdersTableReady();
  const orderId = crypto.randomUUID();
  const result = await sql`
    INSERT INTO orders (order_id, status, order_type, customer_name, phone, currency, total, items, fulfillment, pricing)
    VALUES (
      ${orderId}, 'NEW', ${summary.fulfillment.orderType || null}, ${summary.fulfillment.customerName || null},
      ${summary.fulfillment.phone || null}, ${summary.pricing.currency || null}, ${summary.pricing.total},
      ${JSON.stringify(summary.items)}, ${JSON.stringify(summary.fulfillment)}, ${JSON.stringify(summary.pricing)}
    )
    RETURNING order_id, created_at
  `;
  return { orderId: result[0].order_id, timestamp: result[0].created_at.toISOString() };
}

const ACTIVE_STATUSES = ['NEW', 'PREPARING', 'READY'];
const HISTORY_STATUSES = ['COMPLETED'];

// Dynamic WHERE clause built with $N placeholders only — every user-supplied value
// (search text, status list) travels in the separate `values` array, never concatenated
// into the query string, so this can't be SQL-injected regardless of what staff types in.
async function queryOrders({ statusGroup, search, page, pageSize }) {
  await getOrdersTableReady();
  const conditions = [];
  const values = [];

  if (statusGroup === 'active') {
    values.push(ACTIVE_STATUSES);
    conditions.push(`status = ANY($${values.length})`);
  } else if (statusGroup === 'history') {
    values.push(HISTORY_STATUSES);
    conditions.push(`status = ANY($${values.length})`);
  }

  if (search) {
    values.push(`%${search}%`);
    const idx = values.length;
    conditions.push(`(order_id::text ILIKE $${idx} OR customer_name ILIKE $${idx} OR phone ILIKE $${idx})`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await sql.query(`SELECT COUNT(*)::int AS count FROM orders ${whereClause}`, values);
  const total = countResult[0].count;

  const pageValues = [...values, pageSize, (page - 1) * pageSize];
  const rows = await sql.query(
    `SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
    pageValues
  );

  return { orders: rows.map(rowToOrder), total };
}

async function advanceOrderStatus(orderId) {
  await getOrdersTableReady();
  const existing = await sql`SELECT status FROM orders WHERE order_id = ${orderId}`;
  if (existing.length === 0) {
    return { error: 'Order not found.', status: 404 };
  }

  const currentIndex = ORDER_STATUS_SEQUENCE.indexOf(existing[0].status);
  if (currentIndex === -1 || currentIndex === ORDER_STATUS_SEQUENCE.length - 1) {
    return { error: `Order is already ${existing[0].status} and cannot be advanced further.`, status: 400 };
  }

  const nextStatus = ORDER_STATUS_SEQUENCE[currentIndex + 1];
  const updated = await sql`UPDATE orders SET status = ${nextStatus} WHERE order_id = ${orderId} RETURNING *`;
  return { order: rowToOrder(updated[0]) };
}

function getSubscriptionCategory() {
  return MENU_DATA.categories.find((category) => category.id === SUBSCRIPTIONS_DATA.eligibleCategory);
}

function getSubscriptionEligibleItems() {
  const category = getSubscriptionCategory();
  return category ? category.items.filter((item) => item.available) : [];
}

// The only place plan pricing is computed. Always derives from the real
// category/menu price and the configured discount rate — never invented.
function getSubscriptionPlans() {
  const category = getSubscriptionCategory();
  const perDayPrice = category ? category.price : 0;
  const eligibleItems = getSubscriptionEligibleItems();

  const plans = Object.entries(SUBSCRIPTIONS_DATA.plans).map(([planType, plan]) => ({
    planType,
    label: plan.label,
    discountRate: plan.discountRate,
    durationOptions: plan.durationOptions.map((duration) => {
      const subtotal = perDayPrice * duration;
      const discountAmount = Math.round(subtotal * plan.discountRate);
      return { duration, subtotal, discountAmount, total: subtotal - discountAmount };
    }),
  }));

  return {
    currency: SUBSCRIPTIONS_DATA.currency,
    perDayPrice,
    eligibleItems: eligibleItems.map((item) => ({
      itemId: item.id,
      name: item.name,
      calories: item.nutrition ? item.nutrition.calories : null,
      protein: item.nutrition ? item.nutrition.protein : null,
    })),
    plans,
  };
}

function calculateSubscriptionPrice(input) {
  const { planType, duration, dailyItemIds } = input || {};
  const plan = SUBSCRIPTIONS_DATA.plans[planType];

  if (!plan) {
    return { success: false, error: `"${planType}" is not a recognized plan type. Use "weekly" or "monthly".` };
  }

  if (!plan.durationOptions.includes(duration)) {
    return {
      success: false,
      error: `${duration} is not a valid duration for ${planType}. Valid options: ${plan.durationOptions.join(', ')}.`,
    };
  }

  if (!Array.isArray(dailyItemIds) || dailyItemIds.length !== duration) {
    return { success: false, error: `dailyItemIds must list exactly one item id per day (${duration} total).` };
  }

  const eligibleItems = getSubscriptionEligibleItems();
  const invalidIds = dailyItemIds.filter((id) => !eligibleItems.some((item) => item.id === id));
  if (invalidIds.length > 0) {
    return { success: false, error: `Not a valid Power Platter item id: ${invalidIds.join(', ')}.` };
  }

  const subtotal = dailyItemIds.reduce(
    (sum, id) => sum + eligibleItems.find((item) => item.id === id).price,
    0
  );
  const discountAmount = Math.round(subtotal * plan.discountRate);

  return {
    success: true,
    planType,
    duration,
    currency: SUBSCRIPTIONS_DATA.currency,
    subtotal,
    discountRate: plan.discountRate,
    discountAmount,
    total: subtotal - discountAmount,
  };
}

function getSubscriptionWhatsAppLink(input) {
  const priceResult = calculateSubscriptionPrice(input);
  if (!priceResult.success) return priceResult;

  const { planType, duration, dailyItemIds, customerName } = input;
  const plan = SUBSCRIPTIONS_DATA.plans[planType];
  const eligibleItems = getSubscriptionEligibleItems();
  const itemNames = dailyItemIds.map((id) => eligibleItems.find((item) => item.id === id).name);
  const namePart = customerName ? ` My name is ${customerName}.` : '';

  const message = `Hi! I'd like to sign up for The Trim Spoon ${plan.label} (${duration} days) — ${priceResult.currency} ${priceResult.total}. Platters: ${itemNames.join(', ')}.${namePart}`;

  return {
    success: true,
    whatsappNumber: SUBSCRIPTIONS_DATA.whatsappNumber,
    message,
    url: `https://wa.me/${SUBSCRIPTIONS_DATA.whatsappNumber}?text=${encodeURIComponent(message)}`,
    pricing: priceResult,
  };
}

function getPowerPlatters() {
  const category = MENU_DATA.categories.find((candidate) => candidate.id === 'power-platters');
  return category ? category.items.filter((item) => item.available && item.nutrition) : [];
}

// Ranks real Power Platters for a fitness goal from their real nutrition data —
// mirrors the on-page menu goal filter's classification, never invented.
function scoreForGoal(item, goal) {
  const { calories, protein } = item.nutrition;
  const proteinDensity = (protein / calories) * 100; // g protein per 100 kcal
  if (goal === 'cut') return proteinDensity; // leanest, most protein-dense first
  if (goal === 'bulk') return calories + protein * 2; // highest calorie + protein first
  return -Math.abs(calories - 425); // balanced: closest to the category's typical calorie range
}

function getGoalMealPlan(input) {
  const { goal } = input || {};
  if (!['cut', 'bulk', 'balanced'].includes(goal)) {
    return { success: false, error: `"${goal}" is not a recognized goal. Use "cut", "bulk", or "balanced".` };
  }

  const platters = getPowerPlatters();
  const chosen = [...platters].sort((a, b) => scoreForGoal(b, goal) - scoreForGoal(a, goal)).slice(0, 3);

  const days = chosen.map((item, index) => ({
    day: index + 1,
    itemId: item.id,
    name: item.name,
    calories: item.nutrition.calories,
    protein: item.nutrition.protein,
    price: item.price,
  }));

  const totals = days.reduce(
    (sum, day) => ({
      calories: sum.calories + day.calories,
      protein: sum.protein + day.protein,
      price: sum.price + day.price,
    }),
    { calories: 0, protein: 0, price: 0 }
  );

  return { success: true, goal, currency: FEES_DATA.currency, days, totals };
}

// Reads the real, current cart (added via addItemToCart) — never a plan the model
// invents. Subtotal only: matches getOrderTotal's own tax/delivery disclaimer.
function getWhatsAppOrderLink(orderState) {
  if (!orderState.items || orderState.items.length === 0) {
    return { success: false, error: 'The cart is empty — add items with addItemToCart first.' };
  }

  const totals = getOrderTotal(orderState);
  const itemsText = orderState.items.map((lineItem) => `${lineItem.quantity}x ${lineItem.name}`).join(', ');
  const message = `Hi The Trim Spoon, I'd like to order: ${itemsText}`;

  return {
    success: true,
    whatsappNumber: SUBSCRIPTIONS_DATA.whatsappNumber,
    message,
    url: `https://wa.me/${SUBSCRIPTIONS_DATA.whatsappNumber}?text=${encodeURIComponent(message)}`,
    subtotal: totals.subtotal,
    currency: totals.currency,
    note: 'subtotal only — does not include tax or delivery fee',
  };
}

async function runTool(name, input, orderState) {
  if (name === 'getMenu') return getMenu();
  if (name === 'addItemToCart') return addItemToCart(orderState, input);
  if (name === 'modifyItem') return modifyItem(orderState, input);
  if (name === 'removeItem') return removeItem(orderState, input);
  if (name === 'viewCart') return viewCart(orderState);
  if (name === 'getRecommendations') return getRecommendations(orderState);
  if (name === 'declineRecommendation') return declineRecommendation(orderState, input);
  if (name === 'applyPromotion') return applyPromotion(orderState, input);
  if (name === 'getOrderStatus') return getOrderStatus(orderState);
  if (name === 'setPickupDetails') return setPickupDetails(orderState, input);
  if (name === 'setDeliveryDetails') return setDeliveryDetails(orderState, input);
  if (name === 'getOrderTotal') return getOrderTotal(orderState);
  if (name === 'getOrderSummary') return getOrderSummary(orderState);
  if (name === 'finalizeOrder') return finalizeOrder(orderState, input);
  if (name === 'getSubscriptionPlans') return getSubscriptionPlans();
  if (name === 'calculateSubscriptionPrice') return calculateSubscriptionPrice(input);
  if (name === 'getSubscriptionWhatsAppLink') return getSubscriptionWhatsAppLink(input);
  if (name === 'getGoalMealPlan') return getGoalMealPlan(input);
  if (name === 'getWhatsAppOrderLink') return getWhatsAppOrderLink(orderState);
  throw new Error(`Unknown tool: ${name}`);
}

// In-memory order state per session. No database — state is lost on restart.
const SESSION_COOKIE = 'sessionId';
const sessions = new Map();

function createOrderState() {
  return {
    items: [], // { name, quantity, options: [] }
    orderType: null,
    customerDetails: {},
    discount: null,
    total: 0,
    confirmed: false,
    status: 'open',
    declinedRecommendations: [],
    lastSummarySnapshot: null,
  };
}

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages. Please wait a moment and try again.' },
});

const ordersLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

// Constant-time comparison via fixed-length hash digests, so timingSafeEqual never
// throws on mismatched input length and login attempts can't be timed to guess chars.
function safeEqual(a, b) {
  const bufA = crypto.createHash('sha256').update(String(a)).digest();
  const bufB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

// Gates the staff dashboard (order list + customer names/phones/addresses) behind
// HTTP Basic Auth. Fails closed if STAFF_USERNAME/STAFF_PASSWORD aren't configured,
// rather than silently leaving the dashboard open.
function requireStaffAuth(req, res, next) {
  const expectedUser = process.env.STAFF_USERNAME;
  const expectedPass = process.env.STAFF_PASSWORD;

  if (!expectedUser || !expectedPass) {
    console.error('Staff auth is not configured: set STAFF_USERNAME and STAFF_PASSWORD in .env.');
    return res.status(503).json({ error: 'Staff dashboard is not configured.' });
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const user = separatorIndex === -1 ? decoded : decoded.slice(0, separatorIndex);
    const pass = separatorIndex === -1 ? '' : decoded.slice(separatorIndex + 1);

    if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) {
      return next();
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Staff Dashboard"');
  return res.status(401).json({ error: 'Authentication required.' });
}

function attachSession(req, res, next) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)sessionId=([^;]+)/);
  let sessionId = match ? match[1] : null;

  if (!sessionId || !sessions.has(sessionId)) {
    sessionId = crypto.randomUUID();
    sessions.set(sessionId, createOrderState());
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`);
  }

  req.sessionId = sessionId;
  req.orderState = sessions.get(sessionId);
  next();
}

app.use(express.json({ limit: '256kb' }));
app.use(attachSession);
app.use(['/staff.html', '/staff.js', '/staff.css', '/api/orders'], ordersLimiter, requireStaffAuth);
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_BYTES = 200_000;

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, conversationHistory } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` });
  }

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];

  if (history.length > MAX_HISTORY_MESSAGES) {
    return res.status(400).json({ error: 'conversationHistory is too long.' });
  }

  if (Buffer.byteLength(JSON.stringify(history), 'utf8') > MAX_HISTORY_BYTES) {
    return res.status(400).json({ error: 'conversationHistory payload is too large.' });
  }

  if (history.some((entry) => !entry || (entry.role !== 'user' && entry.role !== 'assistant'))) {
    return res.status(400).json({ error: 'conversationHistory contains an invalid entry.' });
  }

  const messages = [...history, { role: 'user', content: message }];

  // Structured UI actions (chips/CTA buttons) are derived only from real tool
  // results below, never from the model's text — it never controls markup.
  let lastGoalMealPlan = null;
  let lastWhatsAppOrderLink = null;
  let lastFinalizedOrder = null;

  try {
    let response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 600,
      system: CACHED_SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    let toolTurns = 0;
    while (response.stop_reason === 'tool_use') {
      toolTurns += 1;
      if (toolTurns > MAX_TOOL_TURNS) {
        throw new Error(`Exceeded max tool turns (${MAX_TOOL_TURNS}) in a single request.`);
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        response.content
          .filter((block) => block.type === 'tool_use')
          .map(async (block) => {
            const result = await runTool(block.name, block.input, req.orderState);
            if (block.name === 'getGoalMealPlan' && result.success) lastGoalMealPlan = result;
            if (block.name === 'getWhatsAppOrderLink' && result.success) lastWhatsAppOrderLink = result;
            if (block.name === 'finalizeOrder' && result.success) lastFinalizedOrder = result;
            return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
          })
      );

      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 600,
        system: CACHED_SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    }

    const textBlock = response.content.find((block) => block.type === 'text');
    const actions = [];

    if (lastGoalMealPlan) {
      actions.push({
        type: 'add_plan_cta',
        label: 'Add 3-Day Plan to Order',
        itemIds: lastGoalMealPlan.days.map((day) => day.itemId),
      });
    }

    if (lastWhatsAppOrderLink) {
      actions.push({
        type: 'whatsapp_cta',
        label: '📱 Complete Order on WhatsApp',
        url: lastWhatsAppOrderLink.url,
      });
    }

    if (lastFinalizedOrder) {
      actions.push({
        type: 'whatsapp_cta',
        label: '📱 Send Order Confirmation on WhatsApp',
        url: lastFinalizedOrder.whatsappConfirmation.url,
      });
    }

    res.json({
      reply: textBlock ? textBlock.text : '',
      conversationHistory: [...messages, { role: 'assistant', content: response.content }],
      actions,
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('Claude API authentication error:', error.message);
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error('Claude API rate limited:', error.message);
    } else if (error instanceof Anthropic.APIError) {
      console.error(`Claude API error ${error.status}:`, error.message);
    } else {
      console.error('Unexpected error calling Claude API:', error);
    }

    res.status(502).json({
      reply: "Sorry, the AI Nutritionist is temporarily offline. Please try again in a moment, or order directly via the WhatsApp button below.",
      conversationHistory: history,
    });
  }
});

// Plain static-data endpoint — the site's meal-plan calculator reads this
// directly and computes on the client, without spending any LLM tokens.
app.get('/api/subscriptions', (req, res) => {
  res.json({ ...getSubscriptionPlans(), whatsappNumber: SUBSCRIPTIONS_DATA.whatsappNumber });
});

const MAX_PLAN_ITEMS = 10;

// Deterministic cart mutation for the chat's "Add 3-Day Plan to Order" CTA — reuses
// addItemToCart (same validation/pricing) so clicking it never costs an LLM call.
app.post('/api/cart/add-plan', chatLimiter, (req, res) => {
  const { itemIds } = req.body || {};

  if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > MAX_PLAN_ITEMS) {
    return res.status(400).json({ error: `itemIds must be a non-empty array of at most ${MAX_PLAN_ITEMS} item ids.` });
  }

  if (itemIds.some((id) => typeof id !== 'string' || !id.trim())) {
    return res.status(400).json({ error: 'itemIds must all be non-empty strings.' });
  }

  const added = [];
  for (const itemId of itemIds) {
    const result = addItemToCart(req.orderState, { itemId });
    if (!result.success) {
      return res.status(400).json({ error: result.error || result.message || `Could not add "${itemId}".` });
    }
    added.push(result.addedItem);
  }

  res.json({ success: true, added, order: getOrderTotal(req.orderState) });
});

const ORDER_STATUS_SEQUENCE = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

app.get('/api/orders', async (req, res) => {
  const statusGroup = ['active', 'history', 'all'].includes(req.query.status) ? req.query.status : 'all';
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_SEARCH_LENGTH) : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE));

  try {
    const { orders, total } = await queryOrders({ statusGroup, search, page, pageSize });
    res.json({ orders, total, page, pageSize });
  } catch (error) {
    console.error('Failed to query orders:', error);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

app.post('/api/orders/:orderId/advance', async (req, res) => {
  try {
    const result = await advanceOrderStatus(req.params.orderId);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ order: result.order });
  } catch (error) {
    console.error('Failed to advance order status:', error);
    res.status(500).json({ error: 'Could not update order status.' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
