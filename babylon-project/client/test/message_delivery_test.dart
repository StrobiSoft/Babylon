import 'package:babylon_client/src/api_client.dart';
import 'package:babylon_client/src/message_delivery.dart';
import 'package:babylon_client/src/message_outbox.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

class OutboxMemoryStore implements MessageOutboxStore {
  final values = <String, OutboxMessage>{};

  @override
  Future<void> delete(String id) async => values.remove(id);

  @override
  Future<OutboxMessage?> get(String id) async => values[id];

  @override
  Future<List<OutboxMessage>> pendingMessages() async => values.values
      .where(
        (message) =>
            message.status != OutboxMessageStatus.delivered &&
            message.status != OutboxMessageStatus.failed &&
            message.status != OutboxMessageStatus.expired,
      )
      .toList();

  @override
  Future<void> put(OutboxMessage message) async => values[message.requestId] = message;
}

OutboxMessage item() => OutboxMessage(
  requestId: '00000000-0000-4000-8000-000000000021',
  recipientId: '00000000-0000-4000-8000-000000000002',
  sourceText: 'private text',
  targetLanguage: 'hu',
  createdAt: DateTime.utc(2026, 8, 20),
  expiresAt: DateTime.utc(2026, 8, 21),
);

void main() {
  test('uncertain send schedules durable retry with stable request ID across restart', () async {
    final store = OutboxMemoryStore();
    final gateway = FakeGateway()
      ..messageFailure = BabylonApiException(0, 'NETWORK_TIMEOUT', 'safe');
    var now = DateTime.utc(2026, 8, 20, 12);
    Duration? scheduledDelay;
    Future<void> Function()? scheduledCallback;
    final coordinator = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      now: () => now,
      scheduleWakeup: (delay, callback) {
        scheduledDelay = delay;
        scheduledCallback = callback;
      },
    );

    await coordinator.send(item());
    expect(store.values[item().requestId]!.sourceText, 'private text');
    expect(
      store.values[item().requestId]!.failureKind,
      DeliveryFailureKind.network,
    );
    expect(gateway.messageSendCalls, 1);
    expect(scheduledDelay, const Duration(seconds: 1));

    gateway.messageFailure = null;
    Future<void> Function()? restartCallback;
    final restarted = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      now: () => now,
      scheduleWakeup: (delay, callback) {
        scheduledDelay = delay;
        restartCallback = callback;
      },
    );
    await restarted.recover();
    expect(gateway.messageSendCalls, 1, reason: 'restart must preserve retry backoff');
    expect(scheduledDelay, const Duration(seconds: 1));
    expect(restartCallback, isNotNull);

    now = now.add(const Duration(seconds: 1));
    await restartCallback!();
    expect(gateway.lastMessageRequestId, item().requestId);
    expect(gateway.messageSendCalls, 2);
    expect(scheduledCallback, isNotNull);
  });

  test('pending accepted send schedules status reconciliation until delivery ACK', () async {
    final store = OutboxMemoryStore();
    final gateway = FakeGateway()
      ..messageState = {
        'state': 'pending',
        'expiresAt': '2026-08-21T12:00:00Z',
      };
    var now = DateTime.utc(2026, 8, 20, 12);
    Duration? scheduledDelay;
    Future<void> Function()? scheduledCallback;
    final coordinator = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      now: () => now,
      scheduleWakeup: (delay, callback) {
        scheduledDelay = delay;
        scheduledCallback = callback;
      },
    );

    await coordinator.send(item());
    expect(store.values[item().requestId]!.pendingReason, 'awaiting_delivery_ack');
    expect(scheduledDelay, const Duration(seconds: 5));
    expect(scheduledCallback, isNotNull);

    gateway.messageState = {
      'state': 'delivered',
      'deliveredAt': '2026-08-20T12:00:05Z',
      'expiresAt': '2026-08-21T12:00:00Z',
    };
    now = now.add(const Duration(seconds: 5));
    await scheduledCallback!();
    expect(store.values.containsKey(item().requestId), isFalse);
  });

  test('explicit delivered state removes only the acknowledged outbox item', () async {
    final store = OutboxMemoryStore();
    final gateway = FakeGateway()
      ..messageState = {
        'state': 'delivered',
        'deliveredAt': '2026-08-20T12:00:00Z',
      };
    final coordinator = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
    );
    await store.put(
      OutboxMessage(
        requestId: '00000000-0000-4000-8000-000000000099',
        recipientId: item().recipientId,
        sourceText: 'other',
        targetLanguage: 'hu',
        createdAt: item().createdAt,
      ),
    );
    await coordinator.send(item());
    expect(store.values.containsKey(item().requestId), isFalse);
    expect(store.values.values.single.sourceText, 'other');
  });

  test('permanent failure reaches terminal state without retry scheduling', () async {
    final store = OutboxMemoryStore();
    final gateway = FakeGateway()
      ..messageFailure = BabylonApiException(400, 'INVALID_REQUEST', 'safe');
    var scheduled = false;
    final coordinator = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      scheduleWakeup: (_, _) => scheduled = true,
    );
    await coordinator.send(item());
    expect(
      store.values[item().requestId]!.status,
      OutboxMessageStatus.failed,
    );
    expect(scheduled, isFalse);
  });
}
