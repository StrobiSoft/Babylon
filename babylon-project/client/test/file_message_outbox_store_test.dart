import 'dart:convert';
import 'dart:io';

import 'package:babylon_client/src/file_message_outbox_store.dart';
import 'package:babylon_client/src/message_outbox.dart';
import 'package:flutter_test/flutter_test.dart';

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

    setUp(() async {
      directory = await Directory.systemTemp.createTemp('babylon-outbox-test-');
    });

    tearDown(() async {
      if (await directory.exists()) {
        await directory.delete(recursive: true);
      }
    });

    test('survives a full store reopen without losing message content', () async {
      final first = await FileMessageOutboxStore.open(directory);
      final original = message();
      await first.put(original);

      final reopened = await FileMessageOutboxStore.open(directory);
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
      final first = await FileMessageOutboxStore.open(directory);
      final original = message(status: OutboxMessageStatus.sending);
      await first.put(original);

      final reopened = await FileMessageOutboxStore.open(directory);
      final restored = await reopened.get(original.requestId);

      expect(restored, isNotNull);
      expect(restored!.status, OutboxMessageStatus.queued);
      expect(restored.sourceText, original.sourceText);
    });

    test('keeps pending state and reason across restart', () async {
      final first = await FileMessageOutboxStore.open(directory);
      final pending = message().copyWith(
        status: OutboxMessageStatus.pending,
        pendingReason: 'model_unavailable',
      );
      await first.put(pending);

      final reopened = await FileMessageOutboxStore.open(directory);
      final restored = await reopened.get(pending.requestId);

      expect(restored!.status, OutboxMessageStatus.pending);
      expect(restored.pendingReason, 'model_unavailable');
    });

    test('persists deletion after delivery acknowledgement cleanup', () async {
      final first = await FileMessageOutboxStore.open(directory);
      final original = message();
      await first.put(original);
      await first.delete(original.requestId);

      final reopened = await FileMessageOutboxStore.open(directory);
      expect(await reopened.get(original.requestId), isNull);
    });

    test('serializes concurrent mutations and persists the final state', () async {
      final store = await FileMessageOutboxStore.open(directory);
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

      final reopened = await FileMessageOutboxStore.open(directory);
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

    test('recovers the backup when the main file is missing', () async {
      final file = File('${directory.path}${Platform.pathSeparator}message-outbox.json');
      final backup = File('${file.path}.bak');
      final original = message();
      await backup.writeAsString(
        jsonEncode({
          'schemaVersion': 1,
          'messages': [
            {
              'requestId': original.requestId,
              'recipientId': original.recipientId,
              'sourceText': original.sourceText,
              'targetLanguage': original.targetLanguage,
              'style': original.style,
              'createdAt': original.createdAt.toIso8601String(),
              'status': original.status.name,
              'pendingReason': null,
              'deliveredAt': null,
            },
          ],
        }),
        flush: true,
      );

      final store = await FileMessageOutboxStore.open(directory);
      expect(await store.get(original.requestId), isNotNull);
      expect(await file.exists(), isTrue);
      expect(await backup.exists(), isFalse);
    });

    test('fails closed instead of silently discarding corrupted storage', () async {
      final file = File('${directory.path}${Platform.pathSeparator}message-outbox.json');
      await file.writeAsString('{broken-json', flush: true);

      await expectLater(
        FileMessageOutboxStore.open(directory),
        throwsA(isA<FormatException>()),
      );
      expect(await file.readAsString(), '{broken-json');
    });
  });
}
