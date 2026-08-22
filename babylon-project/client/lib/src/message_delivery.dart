import 'dart:async';
import 'dart:convert';

import 'api_client.dart';
import 'message_outbox.dart';

/// Converts local content into an opaque delivery envelope. A future audited
/// E2EE/session implementation replaces this adapter without changing delivery semantics.
abstract interface class MessageEnvelopeEncoder {
  String encode(OutboxMessage message);
}

class Utf8MessageEnvelopeEncoder implements MessageEnvelopeEncoder {
  const Utf8MessageEnvelopeEncoder();

  @override
  String encode(OutboxMessage message) => base64Encode(utf8.encode(message.sourceText));
}

typedef RetryWakeupScheduler = void Function(
  Duration delay,
  Future<void> Function() callback,
);

enum InboundAcceptanceState { registered, completed }

class InboundDeliveryIdentity {
  const InboundDeliveryIdentity({
    required this.senderId,
    required this.requestId,
    required this.expiresAt,
  });

  final String senderId;
  final String requestId;
  /// Authoritative server expiry for the transient payload. This is retention
  /// metadata, not part of the durable deduplication key.
  final DateTime expiresAt;

  String get key => '$senderId\u0000$requestId';
}

/// Durable receipt ledger for the inbound registration/completion state machine.
/// It deliberately stores identity and state only, never the message payload.
abstract interface class InboundAcceptanceStore {
  Future<InboundAcceptanceState> register(InboundDeliveryIdentity identity);
  Future<void> complete(InboundDeliveryIdentity identity);
}

/// The content layer's durable, idempotent acceptance operation.
///
/// Implementations MUST transactionally deduplicate by [identity]. If the process
/// dies after this method commits but before the receipt ledger reaches
/// [InboundAcceptanceState.completed], it will be called again with the same
/// identity. This explicit contract avoids pretending an arbitrary callback can
/// provide exactly-once side effects across that crash boundary.
typedef DurableInboundConsumer = Future<void> Function(
  InboundDeliveryIdentity identity,
  String payload,
  String payloadFormat,
);

class MessageDeliveryCoordinator {
  MessageDeliveryCoordinator({
    required this.outbox,
    required this.gateway,
    required this.encoder,
    required this.inboundAcceptances,
    DateTime Function()? now,
    RetryWakeupScheduler? scheduleWakeup,
    this.statusPollInterval = const Duration(seconds: 5),
  }) : _now = now ?? _utcNow,
       _scheduleWakeup = scheduleWakeup ?? _timerWakeup;

  final MessageOutbox outbox;
  final BabylonGateway gateway;
  final MessageEnvelopeEncoder encoder;
  final InboundAcceptanceStore inboundAcceptances;
  final Duration statusPollInterval;
  final DateTime Function() _now;
  final RetryWakeupScheduler _scheduleWakeup;
  final Set<String> _inFlight = <String>{};
  final Set<String> _inboundInFlight = <String>{};
  int _scheduleGeneration = 0;

  static DateTime _utcNow() => DateTime.now().toUtc();

  static void _timerWakeup(Duration delay, Future<void> Function() callback) {
    Timer(delay, () => unawaited(callback()));
  }

  Future<void> send(OutboxMessage message) async {
    await outbox.queue(message);
    await retry(message.requestId);
  }

  Future<void> retry(String requestId) async {
    if (!_inFlight.add(requestId)) return;
    try {
      final item = await outbox.find(requestId);
      if (item == null || _isTerminal(item)) return;
      final now = _now();
      if (_isExpired(item, now)) {
        await outbox.markTerminal(requestId, OutboxMessageStatus.expired, 'client_expired');
        return;
      }
      if (item.nextAttemptAt case final next? when next.isAfter(now)) return;
      await outbox.markSending(requestId);
      try {
        final state = await gateway.sendMessage(
          requestId: requestId,
          recipientId: item.recipientId,
          payloadFormat: 'transport-v1',
          payload: encoder.encode(item),
        );
        await _applyState(requestId, state);
      } on BabylonApiException catch (error) {
        final kind = _failureKind(error);
        if (_isAccessFailure(kind)) {
          await outbox.pauseForAccessFailure(requestId, kind);
        } else {
          await outbox.recordFailure(requestId, kind, _now());
        }
      }
    } finally {
      _inFlight.remove(requestId);
      await _scheduleNextWakeup();
    }
  }

  Future<void> recover() async {
    final now = _now();
    for (final message in await outbox.recoverableMessages()) {
      if (_isExpired(message, now)) {
        await outbox.markTerminal(
          message.requestId,
          OutboxMessageStatus.expired,
          'client_expired',
        );
        continue;
      }
      if (_isPausedForAccess(message)) continue;
      if (message.nextAttemptAt case final next? when next.isAfter(now)) continue;
      await _resume(message);
    }
    await _scheduleNextWakeup();
  }

  /// Called only after the authentication layer has established a valid new
  /// session. It is also the explicit retry gate for a retained 403 failure.
  Future<void> resumeAfterAuthentication() async {
    for (final message in await outbox.recoverableMessages()) {
      if (!_isPausedForAccess(message)) continue;
      await outbox.resumeAfterAccessRestored(message.requestId);
      final resumed = await outbox.find(message.requestId);
      if (resumed != null) await _resume(resumed);
    }
  }

  Future<void> receiveAndAcknowledge(DurableInboundConsumer consume) async {
    for (final message in await gateway.pendingMessages()) {
      final identity = InboundDeliveryIdentity(
        requestId: message['requestId'] as String,
        senderId: message['senderId'] as String,
        expiresAt: DateTime.parse(message['expiresAt'] as String).toUtc(),
      );
      // This guard only avoids concurrent duplicate work. Restart correctness and
      // user-visible deduplication come from the durable state/consumer contracts.
      if (!_inboundInFlight.add(identity.key)) continue;
      try {
        final state = await inboundAcceptances.register(identity);
        if (state != InboundAcceptanceState.completed) {
          await consume(
            identity,
            message['payload'] as String,
            message['payloadFormat'] as String,
          );
          await inboundAcceptances.complete(identity);
        }
        // A registered receipt is never ACKable. Completion is persisted first.
        await gateway.acknowledgeMessage(identity.requestId, identity.senderId);
      } finally {
        _inboundInFlight.remove(identity.key);
      }
    }
  }

  Future<void> reconcile(String requestId) async {
    if (!_inFlight.add(requestId)) return;
    try {
      final item = await outbox.find(requestId);
      if (item == null || _isTerminal(item)) return;
      final now = _now();
      if (_isExpired(item, now)) {
        await outbox.markTerminal(requestId, OutboxMessageStatus.expired, 'client_expired');
        return;
      }
      if (item.nextAttemptAt case final next? when next.isAfter(now)) return;
      try {
        await _applyState(requestId, await gateway.messageStatus(requestId));
      } on BabylonApiException catch (error) {
        final kind = _failureKind(error);
        if (_isAccessFailure(kind)) {
          await outbox.pauseForAccessFailure(requestId, kind);
        } else {
          await outbox.recordReconcileFailure(requestId, kind, _now());
        }
      }
    } finally {
      _inFlight.remove(requestId);
      await _scheduleNextWakeup();
    }
  }

  Future<void> _runScheduled() async {
    final now = _now();
    final messages = await outbox.recoverableMessages();
    for (final message in messages) {
      if (_isExpired(message, now)) {
        await outbox.markTerminal(
          message.requestId,
          OutboxMessageStatus.expired,
          'client_expired',
        );
        continue;
      }
      if (_isPausedForAccess(message)) continue;
      if (message.nextAttemptAt case final next? when next.isAfter(now)) continue;
      await _resume(message);
    }
    await _scheduleNextWakeup();
  }

  Future<void> _resume(OutboxMessage message) async {
    switch (message.recoveryAction) {
      case OutboxRecoveryAction.send:
        await retry(message.requestId);
      case OutboxRecoveryAction.reconcile:
        await reconcile(message.requestId);
    }
  }

  Future<void> _scheduleNextWakeup() async {
    final generation = ++_scheduleGeneration;
    DateTime? earliest;
    for (final message in await outbox.recoverableMessages()) {
      final next = message.nextAttemptAt;
      if (next == null) continue;
      if (earliest == null || next.isBefore(earliest)) earliest = next;
    }
    if (earliest == null) return;
    final delay = earliest.difference(_now());
    _scheduleWakeup(delay.isNegative ? Duration.zero : delay, () async {
      if (generation != _scheduleGeneration) return;
      await _runScheduled();
    });
  }

  Future<void> _applyState(String requestId, Map<String, dynamic> state) async {
    switch (state['state']) {
      case 'delivered':
        if (await outbox.find(requestId) == null) return;
        await outbox.acknowledgeDelivery(
          requestId,
          DateTime.parse(state['deliveredAt'] as String),
        );
      case 'expired':
        await outbox.markTerminal(
          requestId,
          OutboxMessageStatus.expired,
          'server_expired',
        );
      case 'failed':
        await outbox.markTerminal(
          requestId,
          OutboxMessageStatus.failed,
          'server_failed',
        );
      default:
        final expiresAt = state['expiresAt'] is String
            ? DateTime.parse(state['expiresAt'] as String).toUtc()
            : null;
        await outbox.markPending(
          requestId,
          'awaiting_delivery_ack',
          nextAttemptAt: _now().add(statusPollInterval),
          expiresAt: expiresAt,
          recoveryAction: OutboxRecoveryAction.reconcile,
          resetReconcileAttempts: true,
        );
    }
  }

  DeliveryFailureKind _failureKind(BabylonApiException error) => error.statusCode == 0
      ? DeliveryFailureKind.network
      : error.statusCode == 401
      ? DeliveryFailureKind.authenticationRequired
      : error.statusCode == 403
      ? DeliveryFailureKind.authorizationDenied
      : error.statusCode >= 500
      ? DeliveryFailureKind.backend
      : error.code.startsWith('MODEL_')
      ? DeliveryFailureKind.model
      : DeliveryFailureKind.permanent;

  bool _isAccessFailure(DeliveryFailureKind kind) =>
      kind == DeliveryFailureKind.authenticationRequired ||
      kind == DeliveryFailureKind.authorizationDenied;

  bool _isPausedForAccess(OutboxMessage message) =>
      message.failureKind == DeliveryFailureKind.authenticationRequired ||
      message.failureKind == DeliveryFailureKind.authorizationDenied;

  bool _isExpired(OutboxMessage message, DateTime now) =>
      message.expiresAt != null && !message.expiresAt!.isAfter(now);

  bool _isTerminal(OutboxMessage message) =>
      message.status == OutboxMessageStatus.delivered ||
      message.status == OutboxMessageStatus.expired ||
      message.status == OutboxMessageStatus.failed;
}
