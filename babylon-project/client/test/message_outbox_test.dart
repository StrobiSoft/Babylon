import 'package:babylon_client/src/message_outbox.dart';
import 'package:flutter_test/flutter_test.dart';

class MemoryOutboxStore implements MessageOutboxStore {
  final Map<String, OutboxMessage> _messages = {};

  @override
  Future<void> put(OutboxMessage message) async {
    _messages[message.requestId] = message;
  }

  @override
  Future<OutboxMessage?> get(String requestId) async => _messages[requestId];

  @override
  Future<List<OutboxMessage>> pendingMessages() async => _messages.values
      .where((message) => message.status != OutboxMessageStatus.delivered)
      .toList(growable: false);

  @override
  Future<void> delete(String requestId) async {
    _messages.remove(requestId);
  }
}

OutboxMessage message() => OutboxMessage(
      requestId: '00000000-0000-4000-8000-000000000031',
      recipientId: 'recipient-1',
      sourceText: 'Hello!',
      targetLanguage: 'hu',
      style: 'everyday',
      createdAt: DateTime.utc(2026, 8, 19, 18),
    );

void main() {
  group('MessageOutbox', () {
    test('keeps the client copy through sending and pending states', () async {
      final store = MemoryOutboxStore();
      final outbox = MessageOutbox(store);
      final original = message();

      await outbox.queue(original);
      await outbox.markSending(original.requestId);
      await outbox.markPending(original.requestId, 'model_unavailable');

      final retained = await store.get(original.requestId);
      expect(retained, isNotNull);
      expect(retained!.sourceText, 'Hello!');
      expect(retained.status, OutboxMessageStatus.pending);
      expect(retained.pendingReason, 'model_unavailable');
    });

    test('does not allow deletion before delivery acknowledgement', () async {
      final store = MemoryOutboxStore();
      final outbox = MessageOutbox(store);
      final original = message();

      await outbox.queue(original);
      await outbox.markSending(original.requestId);
      await outbox.markPending(original.requestId, 'processing_timeout');

      await expectLater(
        outbox.removeAcknowledged(original.requestId),
        throwsStateError,
      );
      expect(await store.get(original.requestId), isNotNull);
    });

    test('allows removal only after explicit delivery acknowledgement', () async {
      final store = MemoryOutboxStore();
      final outbox = MessageOutbox(store);
      final original = message();
      final deliveredAt = DateTime.utc(2026, 8, 19, 18, 5);

      await outbox.queue(original);
      await outbox.markSending(original.requestId);
      await outbox.acknowledgeDelivery(original.requestId, deliveredAt);

      final delivered = await store.get(original.requestId);
      expect(delivered!.status, OutboxMessageStatus.delivered);
      expect(delivered.deliveredAt, deliveredAt);

      await outbox.removeAcknowledged(original.requestId);
      expect(await store.get(original.requestId), isNull);
    });

    test('restores uncertain network sends without discarding the text', () async {
      final store = MemoryOutboxStore();
      final outbox = MessageOutbox(store);
      final original = message();

      await outbox.queue(original);
      await outbox.markSending(original.requestId);
      await outbox.restoreAfterUncertainSend(original.requestId);

      final restored = await store.get(original.requestId);
      expect(restored!.status, OutboxMessageStatus.queued);
      expect(restored.sourceText, original.sourceText);
    });

    test('exposes only non-delivered messages as recoverable', () async {
      final store = MemoryOutboxStore();
      final outbox = MessageOutbox(store);
      final first = message();
      final second = OutboxMessage(
        requestId: '00000000-0000-4000-8000-000000000032',
        recipientId: 'recipient-2',
        sourceText: 'Good morning!',
        targetLanguage: 'be',
        createdAt: DateTime.utc(2026, 8, 19, 18, 1),
      );

      await outbox.queue(first);
      await outbox.queue(second);
      await outbox.markSending(second.requestId);
      await outbox.acknowledgeDelivery(
        second.requestId,
        DateTime.utc(2026, 8, 19, 18, 2),
      );

      final recoverable = await outbox.recoverableMessages();
      expect(recoverable.map((item) => item.requestId), [first.requestId]);
    });
  });
}
