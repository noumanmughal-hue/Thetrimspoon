const ORDERS_ENDPOINT = '/api/orders';
const STATUS_SEQUENCE = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];
const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

const ordersBody = document.getElementById('orders-body');
const emptyMessage = document.getElementById('empty-message');
const statusMessage = document.getElementById('status-message');
const refreshBtn = document.getElementById('refresh-btn');
const statusTabs = document.querySelectorAll('.status-tab');
const searchInput = document.getElementById('search-input');
const resetFiltersBtn = document.getElementById('reset-filters-btn');
const pagination = document.getElementById('pagination');
const paginationInfo = document.getElementById('pagination-info');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');

// Single source of truth for the current filter/search/page — every control
// (tabs, search, pagination buttons) just updates this and calls loadOrders().
const state = { status: 'active', search: '', page: 1 };

function formatItems(items) {
  return items
    .map(function (item) {
      const optionParts = Object.entries(item.options || {}).map(function (entry) {
        return entry[0] + ': ' + entry[1];
      });
      const optionsText = optionParts.length ? ' (' + optionParts.join(', ') + ')' : '';
      return item.quantity + 'x ' + item.name + optionsText;
    })
    .join(', ');
}

function formatFulfillment(fulfillment) {
  if (fulfillment.orderType === 'delivery') {
    const parts = [fulfillment.address || 'No address on file'];
    if (fulfillment.apartmentUnit) parts.push('Apt ' + fulfillment.apartmentUnit);
    if (fulfillment.deliveryInstructions) parts.push(fulfillment.deliveryInstructions);
    return 'Delivery — ' + parts.join(', ');
  }
  if (fulfillment.orderType === 'pickup') {
    return 'Pickup' + (fulfillment.pickupTime ? ' at ' + fulfillment.pickupTime : '');
  }
  return fulfillment.orderType || 'Unknown';
}

function formatCustomer(fulfillment) {
  const parts = [fulfillment.customerName || 'Unknown'];
  if (fulfillment.phone) parts.push(fulfillment.phone);
  return parts.join(' · ');
}

// Always textContent, never innerHTML, for anything derived from customer-supplied
// fields (name, phone, address, instructions) — those are raw user input from chat.
function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function renderOrders(orders) {
  ordersBody.innerHTML = '';
  emptyMessage.hidden = orders.length > 0;

  orders.forEach(function (order) {
    const row = document.createElement('tr');

    row.appendChild(cell(order.orderId));
    row.appendChild(cell(formatItems(order.items)));
    row.appendChild(cell(formatFulfillment(order.fulfillment)));
    row.appendChild(cell(formatCustomer(order.fulfillment)));
    row.appendChild(cell(order.pricing.currency + ' ' + order.pricing.total));

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'status-badge status-' + order.status.toLowerCase();
    badge.textContent = order.status;
    statusCell.appendChild(badge);
    row.appendChild(statusCell);

    const actionCell = document.createElement('td');
    const nextIndex = STATUS_SEQUENCE.indexOf(order.status) + 1;
    if (nextIndex > 0 && nextIndex < STATUS_SEQUENCE.length) {
      const advanceBtn = document.createElement('button');
      advanceBtn.className = 'btn btn-advance';
      advanceBtn.type = 'button';
      advanceBtn.textContent = 'Move to ' + STATUS_SEQUENCE[nextIndex];
      advanceBtn.addEventListener('click', function () {
        advanceOrder(order.orderId);
      });
      actionCell.appendChild(advanceBtn);
    }
    row.appendChild(actionCell);

    ordersBody.appendChild(row);
  });
}

function showStatusMessage(text) {
  statusMessage.textContent = text;
  statusMessage.hidden = !text;
}

function renderPagination(total) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  pagination.hidden = total === 0;
  paginationInfo.textContent = 'Page ' + state.page + ' of ' + totalPages + ' (' + total + ' order' + (total === 1 ? '' : 's') + ')';
  prevPageBtn.disabled = state.page <= 1;
  nextPageBtn.disabled = state.page >= totalPages;
}

async function loadOrders() {
  const params = new URLSearchParams({
    status: state.status,
    page: String(state.page),
    pageSize: String(PAGE_SIZE),
  });
  if (state.search) params.set('q', state.search);

  try {
    const response = await fetch(ORDERS_ENDPOINT + '?' + params.toString());
    const data = await response.json();
    if (!response.ok) {
      renderOrders([]);
      showStatusMessage(data.error || 'Could not load orders.');
      pagination.hidden = true;
      return;
    }
    showStatusMessage('');
    renderOrders(Array.isArray(data.orders) ? data.orders : []);
    renderPagination(typeof data.total === 'number' ? data.total : 0);
  } catch (error) {
    renderOrders([]);
    showStatusMessage('Could not load orders.');
    pagination.hidden = true;
  }
}

async function advanceOrder(orderId) {
  showStatusMessage('');
  try {
    const response = await fetch(ORDERS_ENDPOINT + '/' + encodeURIComponent(orderId) + '/advance', {
      method: 'POST',
    });
    if (!response.ok) {
      const data = await response.json().catch(function () {
        return {};
      });
      showStatusMessage(data.error || 'Could not update order status.');
    }
  } catch (error) {
    showStatusMessage('Could not reach the server.');
  }
  loadOrders();
}

refreshBtn.addEventListener('click', loadOrders);

statusTabs.forEach(function (tab) {
  tab.addEventListener('click', function () {
    if (tab.dataset.status === state.status) return;
    statusTabs.forEach(function (other) {
      other.setAttribute('aria-selected', String(other === tab));
    });
    state.status = tab.dataset.status;
    state.page = 1;
    loadOrders();
  });
});

let searchDebounceTimer = null;
searchInput.addEventListener('input', function () {
  resetFiltersBtn.hidden = !searchInput.value;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(function () {
    state.search = searchInput.value.trim();
    state.page = 1;
    loadOrders();
  }, SEARCH_DEBOUNCE_MS);
});

resetFiltersBtn.addEventListener('click', function () {
  searchInput.value = '';
  resetFiltersBtn.hidden = true;
  state.search = '';
  state.page = 1;
  loadOrders();
});

prevPageBtn.addEventListener('click', function () {
  if (state.page <= 1) return;
  state.page -= 1;
  loadOrders();
});

nextPageBtn.addEventListener('click', function () {
  state.page += 1;
  loadOrders();
});

loadOrders();
