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
│                        Express Server (:4000)                   │
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

## Key Concepts Demonstrated

| Concept | Where in Code |
|---------|--------------|
| **Webhook Registration** | `POST /api/subscriptions` — subscriber provides a URL and events |
| **Event Dispatching** | `dispatchWebhook()` — finds matching subscriptions and delivers |
| **Payload Signing** | `signPayload()` — HMAC-SHA256 signature in `X-Webhook-Signature` header |
| **Signature Verification** | `verifySignature()` — receiver recomputes and compares (timing-safe) |
| **Delivery Tracking** | `deliveryLog[]` — records status of each delivery attempt |
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
- Node.js 18+
- npm

### Run the server (Terminal 1)
```bash
cd server
npm install
npm start
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
4. `crypto.timingSafeEqual()` prevents timing attacks during comparison

## Real-World Webhook Examples

- **Stripe** → sends `payment_intent.succeeded` when a payment completes
- **GitHub** → sends `push` events when code is pushed to a repo
- **Twilio** → sends `message.received` when an SMS arrives
- **Shopify** → sends `orders/create` when a customer places an order
