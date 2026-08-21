import 'dart:convert';
import 'dart:io';

import 'package:babylon_client/src/file_received_chat_store.dart';
import 'package:babylon_client/src/message_delivery.dart';
import 'package:babylon_client/src/message_outbox.dart';
import 'package:babylon_client/src/outbox_storage_crypto.dart';
import 'package:babylon_client/src/soft_chat.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

class _OutboxStore implements MessageOutboxStore {
  final values = <String, OutboxMessage>{};

  @override
  Future<List<OutboxMessage>> allMessages() async => values.values.toList();
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
  Future<void> put(OutboxMessage message) async =>
      values[message.requestId] = message;
}

class _AcceptanceStore implements InboundAcceptanceStore {
  final states = <String, InboundAcceptanceState>{};

  @override
  Future<void> complete(InboundDeliveryIdentity identity) async =>
      states[identity.key] = InboundAcceptanceState.completed;

  @override
  Future<InboundAcceptanceState> register(
    InboundDeliveryIdentity identity,
  ) async =>
      states.putIfAbsent(identity.key, () => InboundAcceptanceState.registered);
}

class _KeyStore implements OutboxStorageKeyStore {
  List<int>? key;

  @override
  Future<List<int>?> readKey() async => key == null ? null : List.of(key!);
  @override
  Future<void> writeKey(List<int> keyBytes) async => key = List.of(keyBytes);
}

MessageDeliveryCoordinator _delivery(
  MessageOutbox outbox,
  FakeGateway gateway,
  InboundAcceptanceStore acceptances,
) => MessageDeliveryCoordinator(
  outbox: outbox,
  gateway: gateway,
  encoder: const Utf8MessageEnvelopeEncoder(),
  inboundAcceptances: acceptances,
  scheduleWakeup: (_, _) {},
);

String _decodedPayload(FakeGateway gateway) =>
    utf8.decode(base64Decode(gateway.lastMessagePayload!));

void main() {
  group('Soft Chat Unicode content', () {
    test(
      'emoji-only compose/send uses the normal transport path unchanged',
      () async {
        final gateway = FakeGateway();
        final outbox = MessageOutbox(_OutboxStore());
        final controller = SoftChatController(
          outbox: outbox,
          delivery: _delivery(outbox, gateway, _AcceptanceStore()),
          receivedStore: MemoryReceivedChatStore(),
        );

        await controller.send(
          const ComposerDraft(
            recipientId: ' recipient ',
            text: '🫡👩🏽‍💻🏳️‍🌈',
          ),
        );

        expect(gateway.lastMessagePayloadFormat, 'transport-v1');
        expect(_decodedPayload(gateway), '🫡👩🏽‍💻🏳️‍🌈');
        expect(controller.sent.single.sourceText, '🫡👩🏽‍💻🏳️‍🌈');
        expect(controller.sent.single.status, OutboxMessageStatus.pending);
      },
    );

    test('mixed text and emoji is neither trimmed nor altered', () async {
      const content = '  Hello 🌍! e\u0301 🚀  ';
      final gateway = FakeGateway();
      final outbox = MessageOutbox(_OutboxStore());
      final controller = SoftChatController(
        outbox: outbox,
        delivery: _delivery(outbox, gateway, _AcceptanceStore()),
        receivedStore: MemoryReceivedChatStore(),
      );

      await controller.send(
        const ComposerDraft(recipientId: 'recipient', text: content),
      );

      expect(_decodedPayload(gateway), content);
      expect(controller.sent.single.sourceText, content);
    });

    test(
      'received emoji persists and reloads once after delivery and restart',
      () async {
        const content = 'Restart-safe 💾 🫡';
        final directory = await Directory.systemTemp.createTemp(
          'babylon-soft-chat-',
        );
        addTearDown(() => directory.delete(recursive: true));
        final keyStore = _KeyStore();
        final acceptances = _AcceptanceStore();
        final gateway = FakeGateway()
          ..pendingMessageRows = [
            {
              'requestId': '00000000-0000-4000-8000-000000000071',
              'senderId': '00000000-0000-4000-8000-000000000072',
              'payload': base64Encode(utf8.encode(content)),
              'payloadFormat': 'transport-v1',
              'expiresAt': '2026-08-22T00:00:00Z',
            },
          ];
        final outbox = MessageOutbox(_OutboxStore());
        final firstStore = await FileReceivedChatStore.open(
          directory,
          keyStore: keyStore,
        );
        final first = SoftChatController(
          outbox: outbox,
          delivery: _delivery(outbox, gateway, acceptances),
          receivedStore: firstStore,
        );

        await first.refresh();
        expect(first.received.map((message) => message.text), [content]);
        expect(gateway.acknowledgeCalls, 1);

        final reopenedStore = await FileReceivedChatStore.open(
          directory,
          keyStore: keyStore,
        );
        final restarted = SoftChatController(
          outbox: outbox,
          delivery: _delivery(outbox, gateway, acceptances),
          receivedStore: reopenedStore,
        );
        await restarted.refresh();

        expect(restarted.received, hasLength(1));
        expect(restarted.received.single.text, content);
        expect(
          restarted.received.single.requestId,
          '00000000-0000-4000-8000-000000000071',
        );
        expect(
          gateway.acknowledgeCalls,
          2,
          reason: 'duplicate delivery is ACKed safely',
        );
      },
    );
  });
}
