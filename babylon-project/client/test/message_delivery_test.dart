import 'package:babylon_client/src/api_client.dart';
import 'package:babylon_client/src/message_delivery.dart';
import 'package:babylon_client/src/message_outbox.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

class OutboxMemoryStore implements MessageOutboxStore {
  final values = <String, OutboxMessage>{};
  @override Future<void> delete(String id) async => values.remove(id);
  @override Future<OutboxMessage?> get(String id) async => values[id];
  @override Future<List<OutboxMessage>> pendingMessages() async => values.values.where((m) =>
    m.status != OutboxMessageStatus.delivered && m.status != OutboxMessageStatus.failed && m.status != OutboxMessageStatus.expired).toList();
  @override Future<void> put(OutboxMessage message) async => values[message.requestId] = message;
}

OutboxMessage item() => OutboxMessage(requestId: '00000000-0000-4000-8000-000000000021',
  recipientId: '00000000-0000-4000-8000-000000000002', sourceText: 'private text', targetLanguage: 'hu',
  createdAt: DateTime.utc(2026, 8, 20), expiresAt: DateTime.utc(2026, 8, 21));

void main() {
  test('uncertain send keeps content and stable request ID for a bounded retry', () async {
    final store = OutboxMemoryStore(); final gateway = FakeGateway()
      ..messageFailure = BabylonApiException(0, 'NETWORK_TIMEOUT', 'safe');
    final coordinator = MessageDeliveryCoordinator(outbox: MessageOutbox(store), gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder());
    await coordinator.send(item());
    expect(store.values[item().requestId]!.sourceText, 'private text');
    expect(store.values[item().requestId]!.failureKind, DeliveryFailureKind.network);
    gateway.messageFailure = null;
    await coordinator.retry(item().requestId);
    expect(gateway.lastMessageRequestId, item().requestId);
    expect(gateway.messageSendCalls, 2);
  });

  test('explicit delivered state removes only the acknowledged outbox item', () async {
    final store = OutboxMemoryStore(); final gateway = FakeGateway()
      ..messageState = {'state': 'delivered', 'deliveredAt': '2026-08-20T12:00:00Z'};
    final coordinator = MessageDeliveryCoordinator(outbox: MessageOutbox(store), gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder());
    await store.put(OutboxMessage(requestId: '00000000-0000-4000-8000-000000000099', recipientId: item().recipientId,
      sourceText: 'other', targetLanguage: 'hu', createdAt: item().createdAt));
    await coordinator.send(item());
    expect(store.values.containsKey(item().requestId), isFalse);
    expect(store.values.values.single.sourceText, 'other');
  });

  test('permanent failure reaches terminal state without retry scheduling', () async {
    final store = OutboxMemoryStore(); final gateway = FakeGateway()
      ..messageFailure = BabylonApiException(400, 'INVALID_REQUEST', 'safe');
    final coordinator = MessageDeliveryCoordinator(outbox: MessageOutbox(store), gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder());
    await coordinator.send(item());
    expect(store.values[item().requestId]!.status, OutboxMessageStatus.failed);
  });
}
