enum OutboxMessageStatus {
  queued,
  sending,
  pending,
  delivered,
  expired,
  failed,
}

enum DeliveryFailureKind { network, backend, model, permanent }

class OutboxMessage {
  const OutboxMessage({
    required this.requestId,
    required this.recipientId,
    required this.sourceText,
    required this.targetLanguage,
    required this.createdAt,
    this.style,
    this.status = OutboxMessageStatus.queued,
    this.pendingReason,
    this.deliveredAt,
    this.attemptCount = 0,
    this.nextAttemptAt,
    this.expiresAt,
    this.failureKind,
  });

  final String requestId;
  final String recipientId;
  final String sourceText;
  final String targetLanguage;
  final String? style;
  final DateTime createdAt;
  final OutboxMessageStatus status;
  final String? pendingReason;
  final DateTime? deliveredAt;
  final int attemptCount;
  final DateTime? nextAttemptAt;
  final DateTime? expiresAt;
  final DeliveryFailureKind? failureKind;

  OutboxMessage copyWith({
    OutboxMessageStatus? status,
    String? pendingReason,
    bool clearPendingReason = false,
    DateTime? deliveredAt,
    int? attemptCount,
    DateTime? nextAttemptAt,
    bool clearNextAttemptAt = false,
    DateTime? expiresAt,
    DeliveryFailureKind? failureKind,
    bool clearFailureKind = false,
  }) {
    return OutboxMessage(
      requestId: requestId,
      recipientId: recipientId,
      sourceText: sourceText,
      targetLanguage: targetLanguage,
      style: style,
      createdAt: createdAt,
      status: status ?? this.status,
      pendingReason: clearPendingReason ? null : pendingReason ?? this.pendingReason,
      deliveredAt: deliveredAt ?? this.deliveredAt,
      attemptCount: attemptCount ?? this.attemptCount,
      nextAttemptAt: clearNextAttemptAt ? null : nextAttemptAt ?? this.nextAttemptAt,
      expiresAt: expiresAt ?? this.expiresAt,
      failureKind: clearFailureKind ? null : failureKind ?? this.failureKind,
    );
  }
}

abstract interface class MessageOutboxStore {
  Future<void> put(OutboxMessage message);
  Future<OutboxMessage?> get(String requestId);
  Future<List<OutboxMessage>> pendingMessages();
  Future<void> delete(String requestId);
}

class MessageOutbox {
  MessageOutbox(this._store);

  final MessageOutboxStore _store;

  Future<void> queue(OutboxMessage message) async {
    final existing = await _store.get(message.requestId);
    if (existing != null) {
      throw StateError('An outbox message with this requestId already exists.');
    }
    if (message.status != OutboxMessageStatus.queued) {
      throw StateError('A new outbox message must start in queued state.');
    }
    await _store.put(message);
  }

  Future<void> markSending(String requestId) async {
    final message = await _required(requestId);
    if (message.status != OutboxMessageStatus.queued &&
        message.status != OutboxMessageStatus.pending) {
      throw StateError('Only queued or pending messages can be sent.');
    }
    await _store.put(
      message.copyWith(
        status: OutboxMessageStatus.sending,
        clearPendingReason: true,
        clearNextAttemptAt: true,
      ),
    );
  }

  Future<void> markPending(
    String requestId,
    String reason, {
    DateTime? nextAttemptAt,
    DateTime? expiresAt,
  }) async {
    final message = await _required(requestId);
    if (message.status != OutboxMessageStatus.sending &&
        message.status != OutboxMessageStatus.pending) {
      throw StateError('Only a sending or pending message can become pending.');
    }
    if (reason.trim().isEmpty) {
      throw ArgumentError.value(reason, 'reason', 'Pending reason must not be empty.');
    }
    await _store.put(
      message.copyWith(
        status: OutboxMessageStatus.pending,
        pendingReason: reason,
        nextAttemptAt: nextAttemptAt,
        expiresAt: expiresAt,
        clearFailureKind: true,
      ),
    );
  }

  Future<void> restoreAfterUncertainSend(String requestId) async {
    final message = await _required(requestId);
    if (message.status != OutboxMessageStatus.sending) {
      throw StateError('Only a sending message can be restored after an uncertain send.');
    }
    await _store.put(
      message.copyWith(
        status: OutboxMessageStatus.queued,
        clearPendingReason: true,
        clearNextAttemptAt: true,
      ),
    );
  }

  Future<void> acknowledgeDelivery(String requestId, DateTime deliveredAt) async {
    final message = await _required(requestId);
    if (message.status == OutboxMessageStatus.delivered) {
      return;
    }
    if (message.status != OutboxMessageStatus.queued &&
        message.status != OutboxMessageStatus.sending &&
        message.status != OutboxMessageStatus.pending &&
        message.status != OutboxMessageStatus.expired &&
        message.status != OutboxMessageStatus.failed) {
      throw StateError('Delivery acknowledgement is not valid for this outbox state.');
    }
    await _store.put(
      message.copyWith(
        status: OutboxMessageStatus.delivered,
        clearPendingReason: true,
        clearNextAttemptAt: true,
        deliveredAt: deliveredAt.toUtc(),
        clearFailureKind: true,
      ),
    );
  }

  Future<void> removeAcknowledged(String requestId) async {
    final message = await _required(requestId);
    if (message.status != OutboxMessageStatus.delivered || message.deliveredAt == null) {
      throw StateError('A client copy cannot be removed before delivery acknowledgement.');
    }
    await _store.delete(requestId);
  }

  Future<List<OutboxMessage>> recoverableMessages() => _store.pendingMessages();
  Future<OutboxMessage?> find(String requestId) => _store.get(requestId);

  Future<void> markTerminal(String requestId, OutboxMessageStatus status, String reason) async {
    if (status != OutboxMessageStatus.expired && status != OutboxMessageStatus.failed) {
      throw ArgumentError.value(status, 'status', 'Terminal status required.');
    }
    final message = await _required(requestId);
    await _store.put(
      message.copyWith(
        status: status,
        failureKind: DeliveryFailureKind.permanent,
        pendingReason: reason,
        clearNextAttemptAt: true,
      ),
    );
  }

  Future<void> recordFailure(
    String requestId,
    DeliveryFailureKind kind,
    DateTime now, {
    int maxAttempts = 5,
  }) async {
    final message = await _required(requestId);
    final attempts = message.attemptCount + 1;
    final expired = message.expiresAt != null && !message.expiresAt!.isAfter(now);
    final terminal = kind == DeliveryFailureKind.permanent || attempts >= maxAttempts || expired;
    await _store.put(
      message.copyWith(
        status: expired
            ? OutboxMessageStatus.expired
            : terminal
            ? OutboxMessageStatus.failed
            : OutboxMessageStatus.pending,
        failureKind: kind,
        attemptCount: attempts,
        nextAttemptAt: terminal
            ? null
            : now.add(Duration(seconds: 1 << (attempts - 1).clamp(0, 6))),
        clearNextAttemptAt: terminal,
        pendingReason: kind.name,
      ),
    );
  }

  Future<OutboxMessage> _required(String requestId) async {
    final message = await _store.get(requestId);
    if (message == null) {
      throw StateError('Outbox message not found.');
    }
    return message;
  }
}
