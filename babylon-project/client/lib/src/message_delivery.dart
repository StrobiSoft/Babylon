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

class MessageDeliveryCoordinator {
  MessageDeliveryCoordinator({
    required this.outbox,
    required this.gateway,
    required this.encoder,
    DateTime Function()? now,
    RetryWakeupScheduler? scheduleWakeup,
    this.statusPollInterval = const Duration(seconds: 5),
  }) : _now = now ?? _utcNow,
       _scheduleWakeup = scheduleWakeup ?? _timerWakeup;

  final MessageOutbox outbox;
  final BabylonGateway gateway;
  final MessageEnvelopeEncoder encoder;
  final Duration statusPollInterval;
  final DateTime Function() _now;
  final RetryWakeupScheduler _scheduleWakeup;
  final Set<String> _inFlight = <String>{};
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
        await outbox.recordFailure(requestId, _failureKind(error), _now());
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
      if (message.nextAttemptAt case final next? when next.isAfter(now)) continue;
      await _resume(message);
    }
    await _scheduleNextWakeup();
  }

  Future<void> receiveAndAcknowledge(
    Future<void> Function(String payload, String payloadFormat) consume,
  ) async {
    for (final message in await gateway.pendingMessages()) {
      await consume(message['payload'] as String, message['payloadFormat'] as String);
      await gateway.acknowledgeMessage(
        message['requestId'] as String,
        message['senderId'] as String,
      );
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
        await outbox.recordReconcileFailure(requestId, _failureKind(error), _now());
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
        await outbox.removeAcknowledged(requestId);
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
      : error.statusCode >= 500 || error.statusCode == 401 || error.statusCode == 403
      ? DeliveryFailureKind.backend
      : error.code.startsWith('MODEL_')
      ? DeliveryFailureKind.model
      : DeliveryFailureKind.permanent;

  bool _isExpired(OutboxMessage message, DateTime now) =>
      message.expiresAt != null && !message.expiresAt!.isAfter(now);

  bool _isTerminal(OutboxMessage message) =>
      message.status == OutboxMessageStatus.delivered ||
      message.status == OutboxMessageStatus.expired ||
      message.status == OutboxMessageStatus.failed;
}
