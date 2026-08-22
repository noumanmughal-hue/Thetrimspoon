const ORDERS_ENDPOINT = '/api/orders';
const STATUS_SEQUENCE = ['NEW', 'PREPARING', 'READY', 'COMPLETED'];

const ordersBody = document.getElementById('orders-body');
const emptyMessage = document.getElementById('empty-message');
const statusMessage = document.getElementById('status-message');
const refreshBtn = document.getElementById('refresh-btn');

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

async function loadOrders() {
  try {
    const response = await fetch(ORDERS_ENDPOINT);
    const data = await response.json();
    renderOrders(Array.isArray(data.orders) ? data.orders : []);
  } catch (error) {
    renderOrders([]);
    showStatusMessage('Could not load orders.');
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
loadOrders();
