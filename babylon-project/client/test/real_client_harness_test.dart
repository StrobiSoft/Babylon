import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:babylon_client/src/api_client.dart';
import 'package:babylon_client/src/file_inbound_acceptance_store.dart';
import 'package:babylon_client/src/file_message_outbox_store.dart';
import 'package:babylon_client/src/file_received_chat_store.dart';
import 'package:babylon_client/src/message_delivery.dart';
import 'package:babylon_client/src/message_outbox.dart';
import 'package:babylon_client/src/outbox_storage_crypto.dart';
import 'package:babylon_client/src/soft_chat.dart';
import 'package:babylon_client/src/token_store.dart';

void main() {
  final enabled = Platform.environment['RUN_REAL_CLIENT_HARNESS'] == '1';
  test(
    'two isolated production clients exchange and persist Soft Chat messages',
    () async {
      final baseUrl = _required('BABYLON_BASE_URL');
      final root = Directory(_required('BABYLON_CLIENT_STORE_ROOT'));
      final tokenA = _MemoryValueStore(
        _required('BABYLON_CLIENT_A_REFRESH_TOKEN'),
      );
      final tokenB = _MemoryValueStore(
        _required('BABYLON_CLIENT_B_REFRESH_TOKEN'),
      );
      var clientA = await _Client.open(
        Uri.parse(baseUrl),
        Directory('${root.path}/client-a'),
        tokenA,
      );
      var clientB = await _Client.open(
        Uri.parse(baseUrl),
        Directory('${root.path}/client-b'),
        tokenB,
      );
      final profileA = await clientA.api.me();
      final profileB = await clientB.api.me();
      expect(profileA['id'], isNot(profileB['id']));

      const payloads = ['ordinary text', '🫡👩🏽‍💻', 'Hello 🌍!'];
      final requestIds = <String>[];
      for (final payload in payloads) {
        await clientA.chat.send(
          ComposerDraft(recipientId: profileB['id'] as String, text: payload),
        );
        final sent = clientA.chat.sent.last;
        expect(sent.status, OutboxMessageStatus.pending);
        expect(sent.sourceText, payload);
        requestIds.add(sent.requestId);
      }
      await clientB.chat.refresh();
      expect(clientB.chat.receiveError, isNull);
      expect(
        clientB.chat.received.map((message) => message.senderId),
        everyElement(profileA['id']),
      );
      expect(clientB.chat.received.map((message) => message.text), payloads);
      await Future<void>.delayed(const Duration(seconds: 5, milliseconds: 100));
      for (final requestId in requestIds) {
        await clientA.delivery.reconcile(requestId);
        expect(
          (await clientA.outbox.find(requestId))?.status,
          OutboxMessageStatus.delivered,
        );
      }

      clientA = await _Client.open(
        Uri.parse(baseUrl),
        Directory('${root.path}/client-a'),
        tokenA,
      );
      clientB = await _Client.open(
        Uri.parse(baseUrl),
        Directory('${root.path}/client-b'),
        tokenB,
      );
      expect(
        (await clientA.outbox.allMessages()).map(
          (message) => message.sourceText,
        ),
        payloads,
      );
      expect(
        (await clientA.outbox.allMessages()).map((message) => message.status),
        everyElement(OutboxMessageStatus.delivered),
      );
      expect(
        (await clientB.received.allMessages()).map((message) => message.text),
        payloads,
      );
      await clientB.chat.refresh();
      expect(clientB.chat.received, hasLength(3));
    },
    skip: enabled
        ? false
        : 'Set RUN_REAL_CLIENT_HARNESS=1 to run the real-client gate.',
  );
}

String _required(String name) {
  final value = Platform.environment[name];
  if (value == null || value.isEmpty) throw StateError('$name is required');
  return value;
}

class _Client {
  const _Client(this.api, this.outbox, this.received, this.delivery, this.chat);
  final BabylonApiClient api;
  final MessageOutbox outbox;
  final FileReceivedChatStore received;
  final MessageDeliveryCoordinator delivery;
  final SoftChatController chat;

  static Future<_Client> open(
    Uri baseUri,
    Directory directory,
    SecureValueStore tokens,
  ) async {
    await directory.create(recursive: true);
    final keys = _FileKeyStore(File('${directory.path}/storage.key'));
    final api = BabylonApiClient(baseUri: baseUri, tokenStore: tokens);
    final outbox = MessageOutbox(
      await FileMessageOutboxStore.open(directory, keyStore: keys),
    );
    final received = await FileReceivedChatStore.open(
      directory,
      keyStore: keys,
    );
    final delivery = MessageDeliveryCoordinator(
      outbox: outbox,
      gateway: api,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: await FileInboundAcceptanceStore.open(directory),
      scheduleWakeup: (_, _) {},
    );
    return _Client(
      api,
      outbox,
      received,
      delivery,
      SoftChatController(
        outbox: outbox,
        delivery: delivery,
        receivedStore: received,
      ),
    );
  }
}

class _MemoryValueStore implements SecureValueStore {
  _MemoryValueStore(String refreshToken)
    : values = {'babylon.refresh_token': refreshToken};
  final Map<String, String> values;
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _FileKeyStore implements OutboxStorageKeyStore {
  _FileKeyStore(this.file);
  final File file;
  @override
  Future<List<int>?> readKey() async =>
      await file.exists() ? base64Decode(await file.readAsString()) : null;
  @override
  Future<void> writeKey(List<int> keyBytes) =>
      file.writeAsString(base64Encode(keyBytes), flush: true);
}
