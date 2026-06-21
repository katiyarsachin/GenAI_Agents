# Webhook Demo with React UI

A hands-on demo to understand how **webhooks** work. This project includes a webhook sender, a webhook receiver, and a React dashboard — all wired together so you can see the full lifecycle in real-time.

## What Are Webhooks?

Webhooks are **HTTP callbacks** — when something happens in one system, it automatically sends an HTTP POST request to a URL registered by another system. Think of it as "don't call us, we'll call you."

### Polling vs. Webhooks

```
Polling (wasteful):             Webhooks (efficient):
Client → Server: "Any updates?"    Server → Client: *silence*
Server → Client: "No"              Server → Client: *silence*
Client → Server: "Any updates?"    Server → Client: *silence*
Server → Client: "No"              [Event occurs]
Client → Server: "Any updates?"    Server → Client: "Here's the update!"
Server → Client: "Yes! Here it is"
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    FastAPI + Uvicorn (:4000)                     │
│                                                                 │
│  ┌──────────────────┐    ┌───────────────────────────────────┐  │
│  │  Business Logic   │    │       Webhook Infrastructure      │  │
│  │                   │    │                                   │  │
│  │  POST /api/orders │──▶│  1. Look up subscriptions         │  │
│  │  PATCH /api/orders│   │  2. Sign payload with HMAC-SHA256 │  │
│  │  POST /api/payments│  │  3. POST to subscriber URLs       │  │
│  └──────────────────┘    └──────────────┬────────────────────┘  │
│                                         │                       │
│                                    HTTP POST                    │
│                                         │                       │
│  ┌──────────────────────────────────────▼────────────────────┐  │
│  │              Webhook Receiver (/webhook/receive)           │  │
│  │                                                            │  │
│  │  1. Extract signature from X-Webhook-Signature header      │  │
│  │  2. Recompute HMAC-SHA256 of the payload                   │  │
│  │  3. Compare signatures (timing-safe)                       │  │
│  │  4. Accept or reject                                       │  │
│  └──────────────────────────┬─────────────────────────────────┘  │
│                              │                                   │
│                         Socket.IO                                │
│                              │                                   │
└──────────────────────────────┼───────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   React UI (:3000)   │
                    │                      │
                    │  • Trigger events     │
                    │  • See webhooks live  │
                    │  • View signatures    │
                    │  • Delivery log       │
                    └──────────────────────┘
```

## Step-by-Step: How This Demo Works

### Step 1 — App Setup (`server.py` top)
FastAPI handles HTTP routes.  `python-socketio` adds WebSocket support so we can push webhook events to the React UI in real-time.  Both are combined into a single ASGI app using `socketio.ASGIApp`.

### Step 2 — Shared Secret & Storage
A shared HMAC secret (`WEBHOOK_SECRET`) is used to sign and verify payloads.  In production this would be per-subscriber and stored in a database.  Three in-memory lists act as our database: `subscriptions`, `delivery_log`, `orders`.

### Step 3 — Signing & Verification
- **`sign_payload()`** — serializes the payload to JSON, then computes `HMAC-SHA256(secret, json_bytes)` and returns the hex digest.
- **`verify_signature()`** — recomputes the HMAC and compares using `hmac.compare_digest()` (timing-safe to prevent side-channel attacks).

### Step 4 — Webhook Delivery (Sender)
When a business event occurs:
1. Build a payload: `{ id, event, timestamp, data }`
2. Sign it → attach signature in `X-Webhook-Signature` header
3. HTTP POST to the subscriber's URL using `httpx` (async)
4. Log the result (success/failure) and push to the UI via Socket.IO

### Step 5 — Webhook Receiver
The `/webhook/receive` endpoint simulates a separate service:
1. Extract `X-Webhook-Signature` header
2. Recompute HMAC of the received payload
3. Compare → if valid, return 200; if not, return 401
4. Push the event to the React dashboard via Socket.IO

### Step 6 — Subscription Management
Receivers register by POSTing their URL + desired events to `/api/subscriptions`.  This is how services like Stripe let you configure webhook endpoints in their dashboard.

### Step 7 — Business Logic (Triggers)
The order/payment system is the "application."  Each action checks a condition:
- Order created → fire `order.created` webhook
- Order status changed → fire `order.updated` or `order.completed`
- Payment processed → fire `payment.received`

### Step 8 — Real-time UI via Socket.IO
When the React frontend connects, the server sends current state (`init` event).  As webhooks fire, each event is pushed instantly to the browser.

### Step 9 — Startup
On launch, a default subscription is auto-registered pointing at our own `/webhook/receive` endpoint, so the demo works out of the box.

## Key Concepts Demonstrated

| Concept | Where in Code |
|---------|--------------|
| **Webhook Registration** | `POST /api/subscriptions` — subscriber provides a URL and events |
| **Event Dispatching** | `dispatch_webhook()` — finds matching subscriptions and delivers |
| **Payload Signing** | `sign_payload()` — HMAC-SHA256 signature in `X-Webhook-Signature` header |
| **Signature Verification** | `verify_signature()` — receiver recomputes and compares (timing-safe) |
| **Delivery Tracking** | `delivery_log[]` — records status of each delivery attempt |
| **Real-time UI Updates** | Socket.IO pushes events to the React frontend instantly |

## Webhook Events

| Event | Trigger |
|-------|---------|
| `order.created` | A new order is placed |
| `order.updated` | An order's status changes |
| `order.completed` | An order is marked as completed |
| `payment.received` | A payment is processed |

## Quick Start

### Prerequisites
- Python 3.10+
- Node.js 18+ (for the React frontend)

### Run the server (Terminal 1)
```bash
cd server
pip install -r requirements.txt
python server.py
```

### Run the React UI (Terminal 2)
```bash
cd client
npm install
npm start
```

Open http://localhost:3000 in your browser.

### Try It Out
1. Click **"Create Order"** — watch the `order.created` webhook appear on the right panel
2. Go to **"Orders"** tab → click **"Process"** — see `order.updated` webhook fire
3. Click **"Complete"** — see `order.completed` webhook
4. Click **"Pay"** — see `payment.received` webhook
5. Check the **"Subscriptions"** tab to see registered webhook endpoints
6. Notice the **signature verification** badge on each received webhook

## Security: Why Signatures Matter

Without signatures, anyone could POST fake events to your webhook URL. The flow:

1. **Sender** computes `HMAC-SHA256(secret_key, payload)` and includes it as a header
2. **Receiver** has the same secret key, recomputes the HMAC, and compares
3. If they match → the payload is authentic and unmodified
4. `hmac.compare_digest()` prevents timing attacks during comparison

## Real-World Webhook Examples

- **Stripe** → sends `payment_intent.succeeded` when a payment completes
- **GitHub** → sends `push` events when code is pushed to a repo
- **Twilio** → sends `message.received` when an SMS arrives
- **Shopify** → sends `orders/create` when a customer places an order
