"""
Webhook Demo Server (Python + FastAPI + Socket.IO)

This single file contains ALL three parts of a webhook system:
  1. Webhook SENDER   — signs payloads & POSTs them to subscriber URLs
  2. Webhook RECEIVER — verifies signatures & accepts/rejects deliveries
  3. Business Logic   — simulated order/payment system that triggers webhooks

A React frontend connects via Socket.IO to see events in real-time.


HOW TO RUN:
    pip install -r requirements.txt
    python server.py
"""

import hashlib
import hmac
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

import httpx
import socketio
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


# ══════════════════════════════════════════════════════════════
# STEP 1 — App Setup
# ══════════════════════════════════════════════════════════════
# FastAPI handles HTTP routes.  python-socketio adds WebSocket
# support so we can push events to the React UI in real-time.
#
# We create a Socket.IO server and mount it as an ASGI app
# alongside FastAPI using socketio.ASGIApp.

# Socket.IO server (async mode for FastAPI)
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")

# FastAPI app
api = FastAPI(title="Webhook Demo")
api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Combine FastAPI + Socket.IO into one ASGI application
# Socket.IO handles /socket.io/*, FastAPI handles everything else
app = socketio.ASGIApp(sio, other_asgi_app=api)


# ══════════════════════════════════════════════════════════════
# STEP 2 — Shared Secret & In-Memory Storage
# ══════════════════════════════════════════════════════════════
# In production the secret would be per-subscriber and stored
# in a database.  Here we use one shared key for simplicity.

WEBHOOK_SECRET = "my-webhook-secret-key"

# These lists act as our "database"
subscriptions: list[dict] = []   # registered webhook endpoints
delivery_log: list[dict] = []    # history of every delivery attempt
orders: list[dict] = []          # business data (orders)


# ══════════════════════════════════════════════════════════════
# STEP 3 — Webhook Signing & Verification
# ══════════════════════════════════════════════════════════════
# HMAC-SHA256 ensures the receiver can trust that the payload
# really came from us and wasn't tampered with in transit.
#
# HMAC = Hash-based Message Authentication Code
# It combines a SECRET KEY + the MESSAGE to produce a signature.
# Only someone who knows the secret can produce a valid signature.

def sign_payload(payload: dict) -> str:
    """Create an HMAC-SHA256 signature of a JSON payload.

    How it works:
      1. Serialize the payload to a JSON string (sorted keys for consistency)
      2. Feed the string + secret key into HMAC-SHA256
      3. Return the hex digest — this is the signature
    """
    message = json.dumps(payload, sort_keys=True).encode("utf-8")
    return hmac.new(
        key=WEBHOOK_SECRET.encode("utf-8"),
        msg=message,
        digestmod=hashlib.sha256,
    ).hexdigest()


def verify_signature(payload: dict, signature: str) -> bool:
    """Verify that a received signature matches the payload.

    Uses hmac.compare_digest() which is timing-safe — it takes
    constant time regardless of how many characters match.  This
    prevents attackers from guessing the signature one byte at a
    time by measuring response times.
    """
    expected = sign_payload(payload)
    return hmac.compare_digest(expected, signature)


# ══════════════════════════════════════════════════════════════
# STEP 4 — Webhook Delivery (the "Sender" side)
# ══════════════════════════════════════════════════════════════
# When a business event occurs, the sender:
#   a) Builds a payload with event type + data + timestamp
#   b) Signs it with HMAC-SHA256
#   c) POSTs it to every subscriber that registered for this event
#   d) Logs the delivery result (success / failure)

async def deliver_webhook(subscription: dict, event: str, data: dict) -> dict:
    """Send a single webhook delivery to one subscriber."""

    # (a) Build the webhook payload
    body = {
        "id": str(uuid.uuid4()),
        "event": event,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }

    # (b) Sign the payload
    signature = sign_payload(body)

    # Prepare delivery record for logging
    delivery = {
        "id": body["id"],
        "subscriptionId": subscription["id"],
        "url": subscription["url"],
        "event": event,
        "payload": body,
        "signature": signature,
        "status": "pending",
        "attemptedAt": datetime.now(timezone.utc).isoformat(),
    }

    # (c) POST to the subscriber's URL with signature in a custom header
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                subscription["url"],
                json=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Webhook-Signature": signature,
                    "X-Webhook-Event": event,
                },
                timeout=5.0,
            )
        delivery["status"] = "delivered" if resp.is_success else f"failed ({resp.status_code})"
    except Exception as exc:
        delivery["status"] = f"failed ({exc})"

    # (d) Log it and push to the React UI via Socket.IO
    delivery_log.append(delivery)
    await sio.emit("delivery", delivery)
    return delivery


async def dispatch_webhook(event: str, data: dict):
    """Find all subscribers listening for this event and deliver to each."""
    targets = [
        s for s in subscriptions
        if s["active"] and event in s["events"]
    ]
    for sub in targets:
        await deliver_webhook(sub, event, data)


# ══════════════════════════════════════════════════════════════
# STEP 5 — Webhook Receiver Endpoint
# ══════════════════════════════════════════════════════════════
# In the real world this would be on a DIFFERENT server entirely.
# The receiver:
#   a) Extracts the signature from the X-Webhook-Signature header
#   b) Recomputes HMAC-SHA256 of the payload using the shared secret
#   c) Compares the two signatures (timing-safe)
#   d) Accepts (200) or rejects (401) the webhook

@api.post("/webhook/receive")
async def webhook_receive(request: Request):
    signature = request.headers.get("X-Webhook-Signature", "")
    event = request.headers.get("X-Webhook-Event", "")
    payload = await request.json()

    # Verify: recompute the HMAC and compare
    verified = verify_signature(payload, signature) if signature else False

    received = {
        "id": payload.get("id"),
        "event": event,
        "data": payload.get("data"),
        "signature": signature,
        "verified": verified,
        "receivedAt": datetime.now(timezone.utc).isoformat(),
    }

    # Push to React UI via WebSocket so it appears instantly
    await sio.emit("webhook_received", received)

    if not verified:
        return {"error": "Invalid signature"}

    return {"status": "accepted", "id": payload.get("id")}


# ══════════════════════════════════════════════════════════════
# STEP 6 — Subscription Management APIs
# ══════════════════════════════════════════════════════════════
# Before webhooks can be sent, receivers must SUBSCRIBE by
# registering their URL and which events they want to hear about.
# This is like signing up for email notifications — you pick
# what you want to be notified about.

class SubscriptionCreate(BaseModel):
    url: str
    events: list[str]


@api.post("/api/subscriptions", status_code=201)
async def create_subscription(data: SubscriptionCreate):
    sub = {
        "id": str(uuid.uuid4()),
        "url": data.url,
        "events": data.events,
        "active": True,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    subscriptions.append(sub)
    await sio.emit("subscription_added", sub)
    return sub


@api.get("/api/subscriptions")
async def list_subscriptions():
    return subscriptions


@api.delete("/api/subscriptions/{sub_id}")
async def delete_subscription(sub_id: str):
    for i, s in enumerate(subscriptions):
        if s["id"] == sub_id:
            removed = subscriptions.pop(i)
            await sio.emit("subscription_removed", removed)
            return {"deleted": True}
    return {"error": "not found"}


@api.get("/api/deliveries")
async def list_deliveries():
    return delivery_log


# ══════════════════════════════════════════════════════════════
# STEP 7 — Business Logic (Order & Payment System)
# ══════════════════════════════════════════════════════════════
# This is your "application."  Each action checks a CONDITION,
# and if that condition is met, it fires a webhook.  This is
# exactly how Stripe, GitHub, Shopify etc. work internally.
#
# Think of it as: "IF something happens → THEN notify subscribers"

class OrderCreate(BaseModel):
    customer: str = "Anonymous"
    item: str = "Widget"
    amount: float = 9.99


class StatusUpdate(BaseModel):
    status: str


class PaymentCreate(BaseModel):
    orderId: Optional[str] = None
    amount: float = 9.99
    method: str = "credit_card"


@api.post("/api/orders", status_code=201)
async def create_order(data: OrderCreate):
    order = {
        "id": str(uuid.uuid4()),
        "customer": data.customer,
        "item": data.item,
        "amount": data.amount,
        "status": "created",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    orders.append(order)
    await sio.emit("order_update", order)

    # ── CONDITION MET: a new order exists → fire webhook ──
    await dispatch_webhook("order.created", order)

    return order


@api.patch("/api/orders/{order_id}/status")
async def update_order_status(order_id: str, data: StatusUpdate):
    order = next((o for o in orders if o["id"] == order_id), None)
    if not order:
        return {"error": "order not found"}

    old_status = order["status"]
    order["status"] = data.status
    order["updatedAt"] = datetime.now(timezone.utc).isoformat()
    await sio.emit("order_update", order)

    payload = {**order, "previousStatus": old_status}

    if order["status"] == "completed":
        # ── CONDITION MET: order completed → fire webhook ──
        await dispatch_webhook("order.completed", payload)
    else:
        # ── CONDITION MET: order status changed → fire webhook ──
        await dispatch_webhook("order.updated", payload)

    return order


@api.post("/api/payments")
async def process_payment(data: PaymentCreate):
    payment = {
        "id": str(uuid.uuid4()),
        "orderId": data.orderId,
        "amount": data.amount,
        "method": data.method,
        "status": "succeeded",
        "processedAt": datetime.now(timezone.utc).isoformat(),
    }
    await sio.emit("payment", payment)

    # ── CONDITION MET: payment processed → fire webhook ──
    await dispatch_webhook("payment.received", payment)

    return payment


@api.get("/api/orders")
async def list_orders():
    return orders


# ══════════════════════════════════════════════════════════════
# STEP 8 — WebSocket Connection (Socket.IO)
# ══════════════════════════════════════════════════════════════
# When the React UI connects via Socket.IO, we send it the
# current state (subscriptions, deliveries, orders) so the
# dashboard is populated immediately on page load.

@sio.event
async def connect(sid, environ):
    print(f"Client connected: {sid}")
    await sio.emit("init", {
        "subscriptions": subscriptions,
        "deliveries": delivery_log,
        "orders": orders,
    }, to=sid)


@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")


# ══════════════════════════════════════════════════════════════
# STEP 9 — Start the Server & Register Default Subscription
# ══════════════════════════════════════════════════════════════

PORT = 4000

if __name__ == "__main__":
    # Auto-register a default subscription so webhooks work
    # out of the box — the receiver is our own /webhook/receive endpoint
    default_sub = {
        "id": str(uuid.uuid4()),
        "url": f"http://localhost:{PORT}/webhook/receive",
        "events": [
            "order.created",
            "order.updated",
            "order.completed",
            "payment.received",
        ],
        "active": True,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    subscriptions.append(default_sub)

    print(f"\n  Webhook Demo Server running on http://localhost:{PORT}")
    print(f"\n  Endpoints:")
    print(f"    POST   /api/subscriptions      - Register a webhook subscriber")
    print(f"    GET    /api/subscriptions      - List subscriptions")
    print(f"    POST   /api/orders             - Create order (triggers webhook)")
    print(f"    PATCH  /api/orders/:id/status  - Update order status (triggers webhook)")
    print(f"    POST   /api/payments           - Process payment (triggers webhook)")
    print(f"    POST   /webhook/receive        - Webhook receiver endpoint")
    print(f"    GET    /api/deliveries         - View delivery log\n")

    uvicorn.run(app, host="0.0.0.0", port=PORT)
