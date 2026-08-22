const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

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
const FULL_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

## Hours

${JSON.stringify(MENU_DATA.hours)}

Allergen disclaimer: ${MENU_DATA.allergenDisclaimer}

Use the getMenu tool to look up menu items, prices, sizes, and options. Never invent menu items, prices, or hours not returned by the tool or listed above.`;

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
      "Record delivery order details: the customer's name, phone number, full delivery address, apartment/unit if applicable, and delivery instructions. Sets the order type to delivery. Only pass fields the customer actually gave you — never guess or fill in a field they didn't provide.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "The customer's name for the delivery order." },
        phone: { type: 'string', description: "The customer's phone number." },
        address: { type: 'string', description: 'Full delivery address (street, city, etc).' },
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
    cache_control: { type: 'ephemeral' },
  },
];

const MAX_TOOL_TURNS = 6;

function getMenu() {
  const categories = MENU_DATA.categories
    .map((category) => ({
      ...category,
      items: category.items.filter((item) => item.available),
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

function addItemToCart(orderState, input) {
  const { itemId, quantity, options } = input || {};
  const item = findMenuItem(itemId);

  if (!item || !item.available) {
    return { success: false, error: `No active menu item with id "${itemId}".` };
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
  const deliveryFee = orderState.orderType === 'delivery' ? FEES_DATA.deliveryFee : 0;
  const total = amountAfterDiscount + tax + deliveryFee;

  return {
    currency: FEES_DATA.currency,
    subtotal,
    appliedPromotion,
    discountAmount,
    discountRemoved,
    taxRate,
    tax,
    deliveryFee,
    total,
    unavailableItems,
  };
}

function getOrderStatus(orderState) {
  const details = orderState.customerDetails;

  if (orderState.orderType === 'delivery') {
    const missingRequiredFields = ['name', 'phone', 'address'].filter((field) => !details[field]);
    return {
      orderType: 'delivery',
      customerName: details.name || null,
      phone: details.phone || null,
      address: details.address || null,
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
  const { name, phone, address, apartmentUnit, deliveryInstructions } = input || {};
  const fields = { name, phone, address, apartmentUnit, deliveryInstructions };

  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      return { success: false, error: `${field} must be a non-empty string.` };
    }
    orderState.customerDetails[field] = value.trim();
  }

  orderState.orderType = 'delivery';

  const details = orderState.customerDetails;
  return {
    success: true,
    orderType: orderState.orderType,
    customerName: details.name || null,
    phone: details.phone || null,
    address: details.address || null,
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
function finalizeOrder(orderState, input) {
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
  const savedOrder = saveConfirmedOrder(currentSummary);

  orderState.confirmed = true;
  orderState.status = 'confirmed';

  return { success: true, order: currentSummary, orderId: savedOrder.orderId, timestamp: savedOrder.timestamp };
}

const ORDERS_FILE_PATH = path.resolve(__dirname, '..', 'data', 'orders.json');

// Synchronous fs calls are used deliberately: they block Node's single event loop for
// their duration, so two requests finalizing around the same time can't interleave a
// read-modify-write and clobber each other's saved order.
function saveConfirmedOrder(summary) {
  const existingOrders = JSON.parse(fs.readFileSync(ORDERS_FILE_PATH, 'utf8'));

  const savedOrder = {
    orderId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    status: 'NEW',
    items: summary.items,
    fulfillment: summary.fulfillment,
    pricing: summary.pricing,
  };

  existingOrders.push(savedOrder);
  fs.writeFileSync(ORDERS_FILE_PATH, `${JSON.stringify(existingOrders, null, 2)}\n`, 'utf8');

  return savedOrder;
}

function runTool(name, input, orderState) {
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

app.use(express.json());
app.use(attachSession);
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.post('/api/chat', async (req, res) => {
  const { message, conversationHistory } = req.body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const messages = [...history, { role: 'user', content: message }];

  try {
    let response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
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

      const toolResults = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(runTool(block.name, block.input, req.orderState)),
        }));

      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: CACHED_SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    }

    const textBlock = response.content.find((block) => block.type === 'text');

    res.json({
      reply: textBlock ? textBlock.text : '',
      conversationHistory: [...messages, { role: 'assistant', content: response.content }],
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
      reply: "Sorry, I'm having trouble responding right now. Please try again in a moment.",
      conversationHistory: history,
    });
  }
});

const ORDER_STATUS_SEQUENCE = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];

app.get('/api/orders', (req, res) => {
  const orders = JSON.parse(fs.readFileSync(ORDERS_FILE_PATH, 'utf8'));
  res.json({ orders });
});

app.post('/api/orders/:orderId/advance', (req, res) => {
  const orders = JSON.parse(fs.readFileSync(ORDERS_FILE_PATH, 'utf8'));
  const order = orders.find((candidate) => candidate.orderId === req.params.orderId);

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const currentIndex = ORDER_STATUS_SEQUENCE.indexOf(order.status);
  if (currentIndex === -1 || currentIndex === ORDER_STATUS_SEQUENCE.length - 1) {
    return res.status(400).json({ error: `Order is already ${order.status} and cannot be advanced further.` });
  }

  order.status = ORDER_STATUS_SEQUENCE[currentIndex + 1];
  fs.writeFileSync(ORDERS_FILE_PATH, `${JSON.stringify(orders, null, 2)}\n`, 'utf8');

  res.json({ order });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
