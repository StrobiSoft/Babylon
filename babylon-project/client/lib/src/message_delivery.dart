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

class MessageDeliveryCoordinator {
  MessageDeliveryCoordinator({required this.outbox, required this.gateway, required this.encoder});
  final MessageOutbox outbox;
  final BabylonGateway gateway;
  final MessageEnvelopeEncoder encoder;
  final Set<String> _inFlight = <String>{};

  Future<void> send(OutboxMessage message) async {
    await outbox.queue(message);
    await retry(message.requestId);
  }

  Future<void> retry(String requestId) async {
    if (!_inFlight.add(requestId)) return;
    try {
    final candidates = (await outbox.recoverableMessages()).where((m) => m.requestId == requestId);
    if (candidates.isEmpty) return;
    final item = candidates.first;
    final now = DateTime.now().toUtc();
    if (item.nextAttemptAt case final next? when next.isAfter(now)) return;
    await outbox.markSending(requestId);
    try {
      final state = await gateway.sendMessage(requestId: requestId, recipientId: item.recipientId,
        payloadFormat: 'transport-v1', payload: encoder.encode(item));
      await _applyState(requestId, state);
    } on BabylonApiException catch (error) {
      final kind = error.statusCode == 0 ? DeliveryFailureKind.network
        : error.statusCode >= 500 ? DeliveryFailureKind.backend
        : error.code.startsWith('MODEL_') ? DeliveryFailureKind.model
        : DeliveryFailureKind.permanent;
      await outbox.recordFailure(requestId, kind, DateTime.now().toUtc());
    }
    } finally {
      _inFlight.remove(requestId);
    }
  }

  Future<void> recover() async {
    for (final message in await outbox.recoverableMessages()) {
      await retry(message.requestId);
    }
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

  Future<void> reconcile(String requestId) async => _applyState(requestId, await gateway.messageStatus(requestId));

  Future<void> _applyState(String requestId, Map<String, dynamic> state) async {
    switch (state['state']) {
      case 'delivered':
        if (await outbox.find(requestId) == null) return;
        await outbox.acknowledgeDelivery(requestId, DateTime.parse(state['deliveredAt'] as String));
        await outbox.removeAcknowledged(requestId);
      case 'expired':
        await outbox.markTerminal(requestId, OutboxMessageStatus.expired, 'server_expired');
      case 'failed':
        await outbox.markTerminal(requestId, OutboxMessageStatus.failed, 'server_failed');
      default:
        await outbox.markPending(requestId, 'awaiting_delivery_ack');
    }
  }
}
