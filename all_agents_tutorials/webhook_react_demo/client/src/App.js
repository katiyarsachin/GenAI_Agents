import React, { useState, useEffect, useCallback } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io("http://localhost:4000");
const API = "http://localhost:4000/api";

function App() {
  const [orders, setOrders] = useState([]);
  const [webhookEvents, setWebhookEvents] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [activeTab, setActiveTab] = useState("trigger");
  const [formData, setFormData] = useState({
    customer: "",
    item: "",
    amount: "",
  });

  // ─── Socket.IO listeners ───
  useEffect(() => {
    socket.on("init", (data) => {
      setSubscriptions(data.subscriptions);
      setDeliveries(data.deliveries);
      setOrders(data.orders);
    });

    socket.on("webhook_received", (event) => {
      setWebhookEvents((prev) => [event, ...prev]);
    });

    socket.on("delivery", (d) => {
      setDeliveries((prev) => [d, ...prev]);
    });

    socket.on("order_update", (order) => {
      setOrders((prev) => {
        const exists = prev.find((o) => o.id === order.id);
        if (exists) return prev.map((o) => (o.id === order.id ? order : o));
        return [order, ...prev];
      });
    });

    socket.on("subscription_added", (sub) => {
      setSubscriptions((prev) => [...prev, sub]);
    });

    socket.on("subscription_removed", (sub) => {
      setSubscriptions((prev) => prev.filter((s) => s.id !== sub.id));
    });

    return () => socket.removeAllListeners();
  }, []);

  // ─── API calls ───
  const createOrder = useCallback(async () => {
    await fetch(`${API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: formData.customer || "John Doe",
        item: formData.item || "Laptop",
        amount: parseFloat(formData.amount) || 999.99,
      }),
    });
    setFormData({ customer: "", item: "", amount: "" });
  }, [formData]);

  const updateOrderStatus = useCallback(async (id, status) => {
    await fetch(`${API}/orders/${id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }, []);

  const processPayment = useCallback(async (orderId, amount) => {
    await fetch(`${API}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, amount, method: "credit_card" }),
    });
  }, []);

  // ─── Render ───
  return (
    <div className="app">
      <header className="header">
        <h1>Webhook Demo</h1>
        <p className="subtitle">
          Learn how webhooks work — trigger events on the left, see webhook
          deliveries arrive in real-time on the right
        </p>
      </header>

      <div className="layout">
        {/* ─── LEFT: Trigger Panel ─── */}
        <div className="panel trigger-panel">
          <div className="panel-header">
            <h2>Trigger Events</h2>
            <span className="badge sender">Webhook Sender</span>
          </div>

          <div className="tabs">
            {["trigger", "orders", "subscriptions"].map((tab) => (
              <button
                key={tab}
                className={`tab ${activeTab === tab ? "active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === "trigger"
                  ? "Create Order"
                  : tab === "orders"
                  ? `Orders (${orders.length})`
                  : `Subscriptions (${subscriptions.length})`}
              </button>
            ))}
          </div>

          {activeTab === "trigger" && (
            <div className="card">
              <h3>New Order</h3>
              <p className="hint">
                Creating an order fires the <code>order.created</code> webhook
              </p>
              <div className="form">
                <input
                  placeholder="Customer name"
                  value={formData.customer}
                  onChange={(e) =>
                    setFormData({ ...formData, customer: e.target.value })
                  }
                />
                <input
                  placeholder="Item"
                  value={formData.item}
                  onChange={(e) =>
                    setFormData({ ...formData, item: e.target.value })
                  }
                />
                <input
                  type="number"
                  placeholder="Amount"
                  value={formData.amount}
                  onChange={(e) =>
                    setFormData({ ...formData, amount: e.target.value })
                  }
                />
                <button className="btn primary" onClick={createOrder}>
                  Create Order
                </button>
              </div>
            </div>
          )}

          {activeTab === "orders" && (
            <div className="card">
              <h3>Manage Orders</h3>
              <p className="hint">
                Change status to trigger <code>order.updated</code> /
                <code>order.completed</code> webhooks, or process payment for{" "}
                <code>payment.received</code>
              </p>
              {orders.length === 0 ? (
                <p className="empty">No orders yet. Create one first!</p>
              ) : (
                <div className="order-list">
                  {orders.map((order) => (
                    <div key={order.id} className="order-item">
                      <div className="order-info">
                        <strong>{order.item}</strong>
                        <span className="order-meta">
                          {order.customer} &middot; ${order.amount}
                        </span>
                        <span className={`status status-${order.status}`}>
                          {order.status}
                        </span>
                      </div>
                      <div className="order-actions">
                        {order.status === "created" && (
                          <>
                            <button
                              className="btn small"
                              onClick={() =>
                                updateOrderStatus(order.id, "processing")
                              }
                            >
                              Process
                            </button>
                            <button
                              className="btn small accent"
                              onClick={() =>
                                processPayment(order.id, order.amount)
                              }
                            >
                              Pay
                            </button>
                          </>
                        )}
                        {order.status === "processing" && (
                          <button
                            className="btn small success"
                            onClick={() =>
                              updateOrderStatus(order.id, "completed")
                            }
                          >
                            Complete
                          </button>
                        )}
                        {order.status === "completed" && (
                          <span className="done-label">Done</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === "subscriptions" && (
            <div className="card">
              <h3>Webhook Subscriptions</h3>
              <p className="hint">
                These URLs receive POST requests when matching events occur
              </p>
              {subscriptions.map((sub) => (
                <div key={sub.id} className="sub-item">
                  <div>
                    <code className="sub-url">{sub.url}</code>
                    <div className="sub-events">
                      {sub.events.map((e) => (
                        <span key={e} className="event-tag">
                          {e}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className={`dot ${sub.active ? "green" : "red"}`} />
                </div>
              ))}
            </div>
          )}

          {/* ─── How it works ─── */}
          <div className="card how-it-works">
            <h3>How Webhooks Work</h3>
            <div className="flow">
              <div className="flow-step">
                <div className="step-num">1</div>
                <div>
                  <strong>Subscribe</strong>
                  <p>A receiver registers a URL and the events it cares about</p>
                </div>
              </div>
              <div className="flow-arrow">&darr;</div>
              <div className="flow-step">
                <div className="step-num">2</div>
                <div>
                  <strong>Event Occurs</strong>
                  <p>Something happens in your app (order created, payment received)</p>
                </div>
              </div>
              <div className="flow-arrow">&darr;</div>
              <div className="flow-step">
                <div className="step-num">3</div>
                <div>
                  <strong>Sender POSTs</strong>
                  <p>
                    The sender makes an HTTP POST to the subscriber's URL with
                    the event payload + HMAC signature
                  </p>
                </div>
              </div>
              <div className="flow-arrow">&darr;</div>
              <div className="flow-step">
                <div className="step-num">4</div>
                <div>
                  <strong>Receiver Verifies &amp; Acts</strong>
                  <p>
                    The receiver verifies the signature, then processes the event
                    (update UI, send email, etc.)
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ─── RIGHT: Webhook Events Panel ─── */}
        <div className="panel events-panel">
          <div className="panel-header">
            <h2>Received Webhooks</h2>
            <span className="badge receiver">Webhook Receiver</span>
          </div>

          {webhookEvents.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">&#x1f514;</div>
              <p>No webhook events yet</p>
              <p className="hint">
                Create an order on the left to see webhooks arrive here in
                real-time
              </p>
            </div>
          ) : (
            <div className="event-list">
              {webhookEvents.map((evt, i) => (
                <div
                  key={evt.id || i}
                  className={`event-card ${evt.verified ? "verified" : "unverified"}`}
                >
                  <div className="event-header">
                    <span className={`event-type event-${evt.event}`}>
                      {evt.event}
                    </span>
                    <span className="event-time">
                      {new Date(evt.receivedAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="event-sig">
                    <span className={`verify-badge ${evt.verified ? "ok" : "fail"}`}>
                      {evt.verified ? "Signature Valid" : "Signature Invalid"}
                    </span>
                    <code className="sig-hash">
                      {evt.signature?.slice(0, 16)}...
                    </code>
                  </div>
                  <pre className="event-payload">
                    {JSON.stringify(evt.data, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}

          {/* Delivery log */}
          {deliveries.length > 0 && (
            <div className="delivery-section">
              <h3>Delivery Log</h3>
              <div className="delivery-list">
                {deliveries.map((d, i) => (
                  <div key={d.id || i} className="delivery-item">
                    <span className={`delivery-status status-${d.status}`}>
                      {d.status}
                    </span>
                    <span className="delivery-event">{d.event}</span>
                    <code className="delivery-url">{d.url}</code>
                    <span className="delivery-time">
                      {new Date(d.attemptedAt).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
