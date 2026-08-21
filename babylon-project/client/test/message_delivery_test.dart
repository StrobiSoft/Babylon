import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:babylon_client/src/api_client.dart';
import 'package:babylon_client/src/file_inbound_acceptance_store.dart';
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
  Future<List<OutboxMessage>> allMessages() async => values.values.toList();

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

class InboundMemoryStore implements InboundAcceptanceStore {
  final states = <String, InboundAcceptanceState>{};

  @override
  Future<InboundAcceptanceState> register(
    InboundDeliveryIdentity identity,
  ) async {
    return states.putIfAbsent(
      identity.key,
      () => InboundAcceptanceState.registered,
    );
  }

  @override
  Future<void> complete(InboundDeliveryIdentity identity) async {
    if (!states.containsKey(identity.key)) throw StateError('not registered');
    states[identity.key] = InboundAcceptanceState.completed;
  }
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
  test('file receipt ledger recovers registered work without storing payload', () async {
    final directory = await Directory.systemTemp.createTemp(
      'babylon-inbound-test-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final identity = InboundDeliveryIdentity(
      senderId: '00000000-0000-4000-8000-000000000032',
      requestId: '00000000-0000-4000-8000-000000000031',
      expiresAt: DateTime.utc(2026, 8, 21),
    );

    final first = await FileInboundAcceptanceStore.open(directory);
    expect(await first.register(identity), InboundAcceptanceState.registered);

    final restarted = await FileInboundAcceptanceStore.open(directory);
    expect(await restarted.register(identity), InboundAcceptanceState.registered);
    await restarted.complete(identity);

    final completedRestart = await FileInboundAcceptanceStore.open(directory);
    expect(
      await completedRestart.register(identity),
      InboundAcceptanceState.completed,
    );
    final ledger = await File(
      '${directory.path}${Platform.pathSeparator}inbound-acceptances.json',
    ).readAsString();
    expect(jsonDecode(ledger)['version'], 3);
    expect(ledger, isNot(contains('opaque secret payload')));
  });

  test('receipt cleanup keeps the current late duplicate but prunes it on later traffic', () async {
    final directory = await Directory.systemTemp.createTemp('babylon-inbound-cleanup-');
    addTearDown(() => directory.delete(recursive: true));
    var now = DateTime.utc(2026, 8, 20);
    final retained = InboundDeliveryIdentity(
      senderId: '00000000-0000-4000-8000-000000000032',
      requestId: '00000000-0000-4000-8000-000000000031',
      expiresAt: now.add(const Duration(hours: 1)),
    );
    final store = await FileInboundAcceptanceStore.open(directory, now: () => now);
    await store.register(retained);
    await store.complete(retained);

    now = retained.expiresAt.add(const Duration(days: 1));
    expect(
      await store.register(retained),
      InboundAcceptanceState.completed,
      reason: 'the delivery being handled cannot be re-enabled at the cleanup boundary',
    );

    final later = InboundDeliveryIdentity(
      senderId: retained.senderId,
      requestId: '00000000-0000-4000-8000-000000000033',
      expiresAt: now.add(const Duration(days: 1)),
    );
    await store.register(later);
    final ledger = jsonDecode(
      await File(
        '${directory.path}${Platform.pathSeparator}inbound-acceptances.json',
      ).readAsString(),
    ) as Map<String, dynamic>;
    final receipts = ledger['receipts'] as Map<String, dynamic>;
    expect(receipts, hasLength(1));
    expect(receipts, contains(later.key));
  });

  test('legacy receipt migration receives a bounded conservative retention horizon', () async {
    final directory = await Directory.systemTemp.createTemp('babylon-inbound-v2-');
    addTearDown(() => directory.delete(recursive: true));
    final file = File(
      '${directory.path}${Platform.pathSeparator}inbound-acceptances.json',
    );
    await file.writeAsString(
      jsonEncode({
        'version': 2,
        'receipts': {'sender\u0000request': 'completed'},
      }),
    );
    final migratedAt = DateTime.utc(2026, 8, 20);
    final store = await FileInboundAcceptanceStore.open(
      directory,
      now: () => migratedAt,
    );
    final legacy = InboundDeliveryIdentity(
      senderId: 'sender',
      requestId: 'request',
      expiresAt: DateTime.utc(2026, 8, 20),
    );
    expect(await store.register(legacy), InboundAcceptanceState.completed);
    await store.register(
      InboundDeliveryIdentity(
        senderId: 'sender',
        requestId: 'later-request',
        expiresAt: migratedAt.add(const Duration(days: 1)),
      ),
    );
    final rewritten = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    final receipt = (rewritten['receipts'] as Map<String, dynamic>)[legacy.key]
        as Map<String, dynamic>;
    expect(
      DateTime.parse(receipt['retainUntil'] as String),
      migratedAt.add(const Duration(days: 8)),
    );
  });

  test('failed consumption remains registered and retries after restart without an early ACK', (
    ) async {
    final acceptanceStore = InboundMemoryStore();
    final gateway = FakeGateway()
      ..pendingMessageRows = [
        {
          'requestId': '00000000-0000-4000-8000-000000000031',
          'senderId': '00000000-0000-4000-8000-000000000032',
          'payload': 'opaque',
          'payloadFormat': 'transport-v1',
          'expiresAt': '2026-08-21T00:00:00Z',
        },
      ];
    var consumptions = 0;
    MessageDeliveryCoordinator coordinator() => MessageDeliveryCoordinator(
      outbox: MessageOutbox(OutboxMemoryStore()),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: acceptanceStore,
      now: () => DateTime.utc(2026, 8, 20, 12),
      scheduleWakeup: (_, _) {},
    );

    await expectLater(
      coordinator().receiveAndAcknowledge((_, _, _) async {
        consumptions += 1;
        throw StateError('local durable acceptance failed');
      }),
      throwsStateError,
    );
    expect(consumptions, 1);
    expect(gateway.acknowledgeCalls, 0);
    expect(
      acceptanceStore.states.values.single,
      InboundAcceptanceState.registered,
    );

    await coordinator().receiveAndAcknowledge(
      (_, _, _) async => consumptions += 1,
    );
    expect(
      consumptions,
      2,
      reason: 'registered work must be replayed after restart',
    );
    expect(gateway.acknowledgeCalls, 1);
    expect(
      acceptanceStore.states.values.single,
      InboundAcceptanceState.completed,
    );
  });

  test('durable completion prevents duplicate consumption after ACK failure and restart', (
    ) async {
    final acceptanceStore = InboundMemoryStore();
    final gateway = FakeGateway()
      ..pendingMessageRows = [
        {
          'requestId': '00000000-0000-4000-8000-000000000031',
          'senderId': '00000000-0000-4000-8000-000000000032',
          'payload': 'opaque',
          'payloadFormat': 'transport-v1',
          'expiresAt': '2026-08-21T00:00:00Z',
        },
      ]
      ..acknowledgeFailure = BabylonApiException(0, 'NETWORK_TIMEOUT', 'safe');
    var consumptions = 0;
    MessageDeliveryCoordinator coordinator() => MessageDeliveryCoordinator(
      outbox: MessageOutbox(OutboxMemoryStore()),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: acceptanceStore,
      scheduleWakeup: (_, _) {},
    );

    await expectLater(
      coordinator().receiveAndAcknowledge((_, _, _) async => consumptions += 1),
      throwsA(isA<BabylonApiException>()),
    );
    gateway.acknowledgeFailure = null;
    await coordinator().receiveAndAcknowledge((_, _, _) async => consumptions += 1);
    await coordinator().receiveAndAcknowledge((_, _, _) async => consumptions += 1);
    expect(consumptions, 1, reason: 'duplicates after restart must not be user-visible');
    expect(gateway.acknowledgeCalls, 3, reason: 'late and duplicate ACKs remain safe');
  });

  test('concurrent duplicate fetches cannot invoke local consumption twice', () async {
    final acceptanceStore = InboundMemoryStore();
    final gateway = FakeGateway()
      ..pendingMessageRows = [
        {
          'requestId': '00000000-0000-4000-8000-000000000031',
          'senderId': '00000000-0000-4000-8000-000000000032',
          'payload': 'opaque',
          'payloadFormat': 'transport-v1',
          'expiresAt': '2026-08-21T00:00:00Z',
        },
      ];
    final coordinator = MessageDeliveryCoordinator(
      outbox: MessageOutbox(OutboxMemoryStore()),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: acceptanceStore,
      scheduleWakeup: (_, _) {},
    );
    final consumeStarted = Completer<void>();
    final releaseConsume = Completer<void>();
    var consumptions = 0;
    Future<void> consume(InboundDeliveryIdentity _, String _, String _) async {
      consumptions += 1;
      consumeStarted.complete();
      await releaseConsume.future;
    }

    final first = coordinator.receiveAndAcknowledge(consume);
    await consumeStarted.future;
    final duplicate = coordinator.receiveAndAcknowledge(consume);
    await duplicate;
    releaseConsume.complete();
    await first;

    expect(consumptions, 1);
    expect(gateway.acknowledgeCalls, 1);
  });

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
      inboundAcceptances: InboundMemoryStore(),
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
      inboundAcceptances: InboundMemoryStore(),
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
      inboundAcceptances: InboundMemoryStore(),
      now: () => now,
      scheduleWakeup: (delay, callback) {
        scheduledDelay = delay;
        scheduledCallback = callback;
      },
    );

    await coordinator.send(item());
    expect(store.values[item().requestId]!.pendingReason, 'awaiting_delivery_ack');
    expect(
      store.values[item().requestId]!.recoveryAction,
      OutboxRecoveryAction.reconcile,
    );
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

  test('accepted delivery status failures retry status only across restart', () async {
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
      inboundAcceptances: InboundMemoryStore(),
      now: () => now,
      scheduleWakeup: (delay, callback) {
        scheduledDelay = delay;
        scheduledCallback = callback;
      },
    );

    await coordinator.send(item());
    expect(gateway.messageSendCalls, 1);
    gateway.messageStatusFailure = BabylonApiException(0, 'NETWORK_TIMEOUT', 'safe');
    now = now.add(const Duration(seconds: 5));
    await scheduledCallback!();

    final afterFailure = store.values[item().requestId]!;
    expect(gateway.messageSendCalls, 1, reason: 'status failure must not resend payload');
    expect(gateway.messageStatusCalls, 1);
    expect(afterFailure.recoveryAction, OutboxRecoveryAction.reconcile);
    expect(afterFailure.attemptCount, 0, reason: 'status retries must not consume send retry budget');
    expect(afterFailure.reconcileAttemptCount, 1);
    expect(scheduledDelay, const Duration(seconds: 1));

    Future<void> Function()? restartCallback;
    final restarted = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: InboundMemoryStore(),
      now: () => now,
      scheduleWakeup: (_, callback) => restartCallback = callback,
    );
    await restarted.recover();
    expect(gateway.messageSendCalls, 1);
    expect(gateway.messageStatusCalls, 1, reason: 'restart must preserve reconcile backoff');
    expect(restartCallback, isNotNull);

    gateway.messageStatusFailure = null;
    gateway.messageState = {
      'state': 'delivered',
      'deliveredAt': '2026-08-20T12:00:06Z',
      'expiresAt': '2026-08-21T12:00:00Z',
    };
    now = now.add(const Duration(seconds: 1));
    await restartCallback!();
    expect(gateway.messageSendCalls, 1);
    expect(gateway.messageStatusCalls, 2);
    expect(store.values.containsKey(item().requestId), isFalse);
  });

  test('accepted delivery auth pause resumes status-only reconciliation', () async {
    final store = OutboxMemoryStore();
    final gateway = FakeGateway()
      ..messageState = {
        'state': 'pending',
        'expiresAt': '2026-08-21T12:00:00Z',
      };
    var now = DateTime.utc(2026, 8, 20, 12);
    Future<void> Function()? scheduledCallback;
    final coordinator = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: InboundMemoryStore(),
      now: () => now,
      scheduleWakeup: (_, callback) => scheduledCallback = callback,
    );
    await coordinator.send(item());
    gateway.messageStatusFailure = BabylonApiException(401, 'UNAUTHORIZED', 'safe');
    now = now.add(const Duration(seconds: 5));
    await scheduledCallback!();

    final paused = store.values[item().requestId]!;
    expect(paused.failureKind, DeliveryFailureKind.authenticationRequired);
    expect(paused.recoveryAction, OutboxRecoveryAction.reconcile);
    expect(paused.reconcileAttemptCount, 0);
    expect(paused.nextAttemptAt, isNull);
    expect(gateway.messageSendCalls, 1);

    gateway.messageStatusFailure = null;
    gateway.messageState = {
      'state': 'delivered',
      'deliveredAt': '2026-08-20T12:00:05Z',
      'expiresAt': '2026-08-21T12:00:00Z',
    };
    await coordinator.resumeAfterAuthentication();
    expect(gateway.messageSendCalls, 1, reason: 'accepted payload must never be resent');
    expect(gateway.messageStatusCalls, 2);
    expect(store.values.containsKey(item().requestId), isFalse);
  });

  test('final 401 pauses across restart and resumes with the stable request ID', () async {
    final store = OutboxMemoryStore();
    final gateway = FakeGateway()
      ..messageFailure = BabylonApiException(401, 'UNAUTHORIZED', 'safe');
    var scheduled = false;
    final coordinator = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: InboundMemoryStore(),
      now: () => DateTime.utc(2026, 8, 20, 12),
      scheduleWakeup: (_, _) => scheduled = true,
    );

    await coordinator.send(item());

    final retained = store.values[item().requestId]!;
    expect(retained.status, OutboxMessageStatus.pending);
    expect(retained.sourceText, 'private text');
    expect(retained.failureKind, DeliveryFailureKind.authenticationRequired);
    expect(retained.pendingReason, 'authenticationRequired');
    expect(retained.attemptCount, 0);
    expect(retained.nextAttemptAt, isNull);
    expect(scheduled, isFalse);

    final restarted = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: InboundMemoryStore(),
      now: () => DateTime.utc(2026, 8, 20, 12),
      scheduleWakeup: (_, _) => scheduled = true,
    );
    await restarted.recover();
    expect(gateway.messageSendCalls, 1, reason: 'restart must preserve the pause');
    gateway.messageFailure = null;
    gateway.messageState = {
      'state': 'pending',
      'expiresAt': '2026-08-21T12:00:00Z',
    };
    await restarted.resumeAfterAuthentication();
    expect(gateway.messageSendCalls, 2);
    expect(gateway.lastMessageRequestId, item().requestId);
    expect(store.values[item().requestId]!.attemptCount, 0);
    expect(
      store.values[item().requestId]!.recoveryAction,
      OutboxRecoveryAction.reconcile,
    );
  });

  test('403 pauses without an automatic resend loop or transient budget use', () async {
    final store = OutboxMemoryStore();
    final gateway = FakeGateway()
      ..messageFailure = BabylonApiException(403, 'FORBIDDEN', 'safe');
    final now = DateTime.utc(2026, 8, 20, 12);
    var scheduled = false;
    final coordinator = MessageDeliveryCoordinator(
      outbox: MessageOutbox(store),
      gateway: gateway,
      encoder: const Utf8MessageEnvelopeEncoder(),
      inboundAcceptances: InboundMemoryStore(),
      now: () => now,
      scheduleWakeup: (_, _) => scheduled = true,
    );

    await coordinator.send(item());
    await coordinator.recover();

    final retained = store.values[item().requestId]!;
    expect(gateway.messageSendCalls, 1);
    expect(retained.status, OutboxMessageStatus.pending);
    expect(retained.nextAttemptAt, isNull);
    expect(retained.sourceText, 'private text');
    expect(retained.attemptCount, 0);
    expect(retained.failureKind, DeliveryFailureKind.authorizationDenied);
    expect(retained.pendingReason, 'authorizationDenied');
    expect(scheduled, isFalse);
  });

  test('explicit delivered state retains the acknowledged local conversation item', () async {
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
      inboundAcceptances: InboundMemoryStore(),
      now: () => DateTime.utc(2026, 8, 20, 12),
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
    expect(store.values[item().requestId]!.status, OutboxMessageStatus.delivered);
    expect(store.values[item().requestId]!.deliveredAt, DateTime.utc(2026, 8, 20, 12));
    expect(store.values.values.where((message) => message.sourceText == 'other'), hasLength(1));
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
      inboundAcceptances: InboundMemoryStore(),
      now: () => DateTime.utc(2026, 8, 20, 12),
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
