const express = require("express");
const http = require("http");
const crypto = require("crypto");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────
// PART 1: Webhook Infrastructure
// ─────────────────────────────────────────────────────────

// Shared secret used to sign webhook payloads so the receiver
// can verify they really came from us (not a spoofed request).
const WEBHOOK_SECRET = "my-webhook-secret-key";

// Registry of webhook subscriptions.
// In production this would be a database table.
// Each entry: { id, url, events: string[], active: boolean }
const subscriptions = [];

// Log of all webhook deliveries (kept in memory for the demo)
const deliveryLog = [];

// Utility: sign a payload with HMAC-SHA256
function signPayload(payload) {
  return crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest("hex");
}

// Utility: verify a signature
function verifySignature(payload, signature) {
  const expected = signPayload(payload);
  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex")
  );
}

// Deliver a webhook: POST the payload to the subscriber's URL
async function deliverWebhook(subscription, event, payload) {
  const body = {
    id: crypto.randomUUID(),
    event,
    timestamp: new Date().toISOString(),
    data: payload,
  };
  const signature = signPayload(body);

  const delivery = {
    id: body.id,
    subscriptionId: subscription.id,
    url: subscription.url,
    event,
    payload: body,
    signature,
    status: "pending",
    attemptedAt: new Date().toISOString(),
  };

  try {
    // In a real system this would be fetch() to an external URL.
    // Here we POST to our own /webhook/receive endpoint to keep
    // everything in one process for learning purposes.
    const res = await fetch(subscription.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Event": event,
      },
      body: JSON.stringify(body),
    });
    delivery.status = res.ok ? "delivered" : `failed (${res.status})`;
  } catch (err) {
    delivery.status = `failed (${err.message})`;
  }

  deliveryLog.push(delivery);
  io.emit("delivery", delivery);
  return delivery;
}

// Dispatch: find all subscriptions listening for this event and deliver
async function dispatchWebhook(event, payload) {
  const targets = subscriptions.filter(
    (s) => s.active && s.events.includes(event)
  );
  return Promise.all(targets.map((s) => deliverWebhook(s, event, payload)));
}

// ─────────────────────────────────────────────────────────
// PART 2: Webhook Sender APIs (manage subscriptions + trigger)
// ─────────────────────────────────────────────────────────

// Register a new webhook subscription
app.post("/api/subscriptions", (req, res) => {
  const { url, events } = req.body;
  if (!url || !events || !events.length) {
    return res.status(400).json({ error: "url and events[] are required" });
  }
  const sub = {
    id: crypto.randomUUID(),
    url,
    events,
    active: true,
    createdAt: new Date().toISOString(),
  };
  subscriptions.push(sub);
  io.emit("subscription_added", sub);
  res.status(201).json(sub);
});

// List all subscriptions
app.get("/api/subscriptions", (_req, res) => {
  res.json(subscriptions);
});

// Delete a subscription
app.delete("/api/subscriptions/:id", (req, res) => {
  const idx = subscriptions.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const [removed] = subscriptions.splice(idx, 1);
  io.emit("subscription_removed", removed);
  res.json({ deleted: true });
});

// List delivery log
app.get("/api/deliveries", (_req, res) => {
  res.json(deliveryLog);
});

// ─────────────────────────────────────────────────────────
// PART 3: Simulated Business Logic (triggers webhooks)
// ─────────────────────────────────────────────────────────

// In-memory "database" of orders
const orders = [];

// Create a new order → triggers "order.created" webhook
app.post("/api/orders", async (req, res) => {
  const order = {
    id: crypto.randomUUID(),
    customer: req.body.customer || "Anonymous",
    item: req.body.item || "Widget",
    amount: req.body.amount || 9.99,
    status: "created",
    createdAt: new Date().toISOString(),
  };
  orders.push(order);
  io.emit("order_update", order);

  // 🔔 WEBHOOK TRIGGER: a new order was created
  await dispatchWebhook("order.created", order);

  res.status(201).json(order);
});

// Update order status → triggers "order.updated" or "order.completed"
app.patch("/api/orders/:id/status", async (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "order not found" });

  const oldStatus = order.status;
  order.status = req.body.status;
  order.updatedAt = new Date().toISOString();
  io.emit("order_update", order);

  if (order.status === "completed") {
    // 🔔 WEBHOOK TRIGGER: order completed
    await dispatchWebhook("order.completed", { ...order, previousStatus: oldStatus });
  } else {
    // 🔔 WEBHOOK TRIGGER: order updated
    await dispatchWebhook("order.updated", { ...order, previousStatus: oldStatus });
  }

  res.json(order);
});

// Simulate a payment → triggers "payment.received"
app.post("/api/payments", async (req, res) => {
  const payment = {
    id: crypto.randomUUID(),
    orderId: req.body.orderId,
    amount: req.body.amount || 9.99,
    method: req.body.method || "credit_card",
    status: "succeeded",
    processedAt: new Date().toISOString(),
  };
  io.emit("payment", payment);

  // 🔔 WEBHOOK TRIGGER: payment received
  await dispatchWebhook("payment.received", payment);

  res.json(payment);
});

// List orders
app.get("/api/orders", (_req, res) => {
  res.json(orders);
});

// ─────────────────────────────────────────────────────────
// PART 4: Webhook Receiver Endpoint
// ─────────────────────────────────────────────────────────

// This simulates a SEPARATE service that receives webhooks.
// In the real world this would be a different server entirely.
app.post("/webhook/receive", (req, res) => {
  const signature = req.headers["x-webhook-signature"];
  const event = req.headers["x-webhook-event"];
  const payload = req.body;

  // Step 1: Verify the signature
  let verified = false;
  try {
    verified = verifySignature(payload, signature);
  } catch {
    verified = false;
  }

  const received = {
    id: payload.id,
    event,
    data: payload.data,
    signature,
    verified,
    receivedAt: new Date().toISOString(),
  };

  // Step 2: Push to the React UI via WebSocket
  io.emit("webhook_received", received);

  if (!verified) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  res.json({ status: "accepted", id: payload.id });
});

// ─────────────────────────────────────────────────────────
// PART 5: Auto-register a default subscription on startup
// ─────────────────────────────────────────────────────────

const PORT = 4000;
server.listen(PORT, () => {
  // Register our own receiver as a default subscriber
  const defaultSub = {
    id: crypto.randomUUID(),
    url: `http://localhost:${PORT}/webhook/receive`,
    events: [
      "order.created",
      "order.updated",
      "order.completed",
      "payment.received",
    ],
    active: true,
    createdAt: new Date().toISOString(),
  };
  subscriptions.push(defaultSub);

  console.log(`\n🚀 Webhook Demo Server running on http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  POST   /api/subscriptions      - Register a webhook subscriber`);
  console.log(`  GET    /api/subscriptions      - List subscriptions`);
  console.log(`  POST   /api/orders             - Create order (triggers webhook)`);
  console.log(`  PATCH  /api/orders/:id/status  - Update order status (triggers webhook)`);
  console.log(`  POST   /api/payments           - Process payment (triggers webhook)`);
  console.log(`  POST   /webhook/receive        - Webhook receiver endpoint`);
  console.log(`  GET    /api/deliveries         - View delivery log`);
  console.log(`\nDefault subscription registered for all events.\n`);
});

// WebSocket connection handling
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.emit("init", { subscriptions, deliveries: deliveryLog, orders });
  socket.on("disconnect", () => console.log("Client disconnected:", socket.id));
});
