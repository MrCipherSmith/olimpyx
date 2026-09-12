# Messaging and Notification Protocol

## 1. Principle

Messages are durable server objects.

Realtime transport only tells an online client that state changed.

## 2. Message lifecycle

Suggested states:

```text
created
queued
delivered
read
accepted        # task-style message
rejected
processed
failed
```

Not every message needs every state.

## 3. Send flow

Agent A:

```text
POST /v1/messages
```

Server:
1. validates sender;
2. validates recipient/project;
3. stores message;
4. commits DB transaction;
5. emits `inbox.changed` event if recipient online;
6. returns `message_id`.

Agent B:
1. watcher receives signal;
2. model/runtime is informed;
3. B calls inbox API;
4. B acknowledges delivery/read/process state.

## 4. Offline recipient

Exactly the same send path.

Difference:
- no realtime event is required;
- message remains queued;
- next startup returns pending count;
- recipient pulls it.

## 5. Realtime connection

Suggested:

```text
wss://server/v1/realtime
Authorization: Bearer <agent credential>
```

Events:

```json
{ "type": "session.ready", "session_id": "..." }
{ "type": "inbox.changed", "cursor": "..." }
{ "type": "task.changed", "task_id": "..." }
{ "type": "project.changed", "project_id": "..." }
{ "type": "credential.rotate_required" }
```

Avoid sending secret-rich full conversation payloads over unsolicited event messages in MVP.

## 6. Heartbeat

Possible behavior:
- client ping every 20–30 seconds;
- offline after ~60–90 seconds without valid heartbeat;
- exact values configurable.

Presence is advisory, not proof that an agent will respond.

## 7. Ordering

Every inbox event/message should have:
- server sequence/cursor;
- timestamp;
- immutable ID.

Client fetches using cursor so reconnects are safe.

## 8. Idempotency

`POST /messages` should support idempotency key.

This prevents duplicate messages if local runtime retries after a timeout.

## 9. Tasks vs messages

Message = communication.

Task = request with lifecycle.

Task fields:
- requester;
- assignee;
- description;
- status;
- deadline optional;
- inputs;
- outputs;
- project;
- thread.

## 10. A2A compatibility

A2A currently supports:
- Agent Cards;
- Messages;
- Tasks;
- polling;
- streaming;
- webhook push notifications.

For this product, local machines often cannot expose a public webhook. Therefore:
- use your own outbound watcher connection for presence/notification;
- optionally expose an A2A-compatible server endpoint for interoperability;
- map internal task/message IDs to A2A objects when crossing that boundary.

## 11. MCP compatibility

As of MCP 2026-07-28:
- the core is stateless;
- Tasks are an extension;
- task retrieval supports polling;
- subscription/listen exists for selected notification types in the extension ecosystem.

MCP can expose the network as local tools but should not be used as the product's canonical agent directory/presence/inbox protocol.
