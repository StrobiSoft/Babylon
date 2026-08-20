import 'dart:convert';
import 'dart:io';

import 'package:babylon_client/src/file_message_outbox_store.dart';
import 'package:babylon_client/src/message_outbox.dart';
import 'package:babylon_client/src/outbox_storage_crypto.dart';
import 'package:flutter_test/flutter_test.dart';

class MemoryOutboxStorageKeyStore implements OutboxStorageKeyStore {
  MemoryOutboxStorageKeyStore([List<int>? keyBytes])
      : _keyBytes = keyBytes == null ? null : List<int>.from(keyBytes);

  List<int>? _keyBytes;

  @override
  Future<List<int>?> readKey() async =>
      _keyBytes == null ? null : List<int>.from(_keyBytes!);

  @override
  Future<void> writeKey(List<int> keyBytes) async {
    _keyBytes = List<int>.from(keyBytes);
  }
}

OutboxMessage message({
  String requestId = '00000000-0000-4000-8000-000000000041',
  OutboxMessageStatus status = OutboxMessageStatus.queued,
}) => OutboxMessage(
      requestId: requestId,
      recipientId: 'recipient-1',
      sourceText: 'Hello persistent world!',
      targetLanguage: 'hu',
      style: 'everyday',
      createdAt: DateTime.utc(2026, 8, 19, 19),
      status: status,
    );

void main() {
  group('FileMessageOutboxStore', () {
    late Directory directory;
    late MemoryOutboxStorageKeyStore keyStore;

    setUp(() async {
      directory = await Directory.systemTemp.createTemp('babylon-outbox-test-');
      keyStore = MemoryOutboxStorageKeyStore();
    });

    tearDown(() async {
      if (await directory.exists()) {
        await directory.delete(recursive: true);
      }
    });

    Future<FileMessageOutboxStore> openStore() =>
        FileMessageOutboxStore.open(directory, keyStore: keyStore);

    test('persists only encrypted payload data on disk', () async {
      final store = await openStore();
      final original = message();
      await store.put(original);

      final file = File('${directory.path}${Platform.pathSeparator}message-outbox.json');
      final raw = await file.readAsString();
      final envelope = jsonDecode(raw) as Map<String, dynamic>;

      expect(raw, isNot(contains(original.sourceText)));
      expect(raw, isNot(contains(original.recipientId)));
      expect(envelope['schemaVersion'], 2);
      expect(envelope['algorithm'], OutboxStorageCrypto.algorithmName);
      expect(envelope['ciphertext'], isA<String>());
    });

    test('survives a full store reopen without losing message content', () async {
      final first = await openStore();
      final original = message();
      await first.put(original);

      final reopened = await openStore();
      final restored = await reopened.get(original.requestId);

      expect(restored, isNotNull);
      expect(restored!.sourceText, original.sourceText);
      expect(restored.recipientId, original.recipientId);
      expect(restored.targetLanguage, original.targetLanguage);
      expect(restored.style, original.style);
      expect(restored.createdAt, original.createdAt);
      expect(restored.status, OutboxMessageStatus.queued);
    });

    test('recovers interrupted sending state as queued after restart', () async {
      final first = await openStore();
      final original = message(status: OutboxMessageStatus.sending);
      await first.put(original);

      final reopened = await openStore();
      final restored = await reopened.get(original.requestId);

      expect(restored, isNotNull);
      expect(restored!.status, OutboxMessageStatus.queued);
      expect(restored.sourceText, original.sourceText);
    });

    test('keeps pending state and reason across restart', () async {
      final first = await openStore();
      final pending = message().copyWith(
        status: OutboxMessageStatus.pending,
        pendingReason: 'model_unavailable',
      );
      await first.put(pending);

      final reopened = await openStore();
      final restored = await reopened.get(pending.requestId);

      expect(restored!.status, OutboxMessageStatus.pending);
      expect(restored.pendingReason, 'model_unavailable');
    });

    test('persists deletion after delivery acknowledgement cleanup', () async {
      final first = await openStore();
      final original = message();
      await first.put(original);
      await first.delete(original.requestId);

      final reopened = await openStore();
      expect(await reopened.get(original.requestId), isNull);
    });

    test('serializes concurrent mutations and persists the final state', () async {
      final store = await openStore();
      final messages = List.generate(
        12,
        (index) => message(
          requestId: '00000000-0000-4000-8000-${(index + 50).toString().padLeft(12, '0')}',
        ),
      );

      await Future.wait(messages.map(store.put));
      await Future.wait([
        store.delete(messages[2].requestId),
        store.delete(messages[7].requestId),
        store.put(
          messages[5].copyWith(
            status: OutboxMessageStatus.pending,
            pendingReason: 'model_unavailable',
          ),
        ),
      ]);

      final reopened = await openStore();
      expect(await reopened.get(messages[2].requestId), isNull);
      expect(await reopened.get(messages[7].requestId), isNull);
      expect(
        (await reopened.get(messages[5].requestId))!.status,
        OutboxMessageStatus.pending,
      );
      for (final item in messages.where(
        (item) => item.requestId != messages[2].requestId && item.requestId != messages[7].requestId,
      )) {
        expect(await reopened.get(item.requestId), isNotNull);
      }
    });

    test('recovers an encrypted backup when the main file is missing', () async {
      final first = await openStore();
      final original = message();
      await first.put(original);

      final file = File('${directory.path}${Platform.pathSeparator}message-outbox.json');
      final backup = File('${file.path}.bak');
      await file.rename(backup.path);

      final reopened = await openStore();
      expect(await reopened.get(original.requestId), isNotNull);
      expect(await file.exists(), isTrue);
      expect(await backup.exists(), isFalse);
    });

    test('fails closed when encrypted storage is tampered with', () async {
      final store = await openStore();
      await store.put(message());

      final file = File('${directory.path}${Platform.pathSeparator}message-outbox.json');
      final envelope = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
      final ciphertext = envelope['ciphertext'] as String;
      envelope['ciphertext'] = '${ciphertext[0] == 'A' ? 'B' : 'A'}${ciphertext.substring(1)}';
      await file.writeAsString(jsonEncode(envelope), flush: true);

      await expectLater(openStore(), throwsA(isA<FormatException>()));
    });

    test('fails closed when the storage key is missing', () async {
      final store = await openStore();
      await store.put(message());

      final missingKeyStore = MemoryOutboxStorageKeyStore();
      await expectLater(
        FileMessageOutboxStore.open(directory, keyStore: missingKeyStore),
        throwsStateError,
      );
    });

    test('fails closed when the storage key changes', () async {
      final store = await openStore();
      await store.put(message());

      final differentKeyStore = MemoryOutboxStorageKeyStore(List<int>.filled(32, 7));
      await expectLater(
        FileMessageOutboxStore.open(directory, keyStore: differentKeyStore),
        throwsA(isA<FormatException>()),
      );
    });

    test('fails closed instead of silently discarding corrupted storage', () async {
      final store = await openStore();
      await store.put(message());
      final file = File('${directory.path}${Platform.pathSeparator}message-outbox.json');
      await file.writeAsString('{broken-json', flush: true);

      await expectLater(openStore(), throwsA(isA<FormatException>()));
      expect(await file.readAsString(), '{broken-json');
    });
  });
}
