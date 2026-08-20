enum OutboxMessageStatus {
  queued,
  sending,
  pending,
  delivered,
}

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

  OutboxMessage copyWith({
    OutboxMessageStatus? status,
    String? pendingReason,
    bool clearPendingReason = false,
    DateTime? deliveredAt,
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
      ),
    );
  }

  Future<void> markPending(String requestId, String reason) async {
    final message = await _required(requestId);
    if (message.status != OutboxMessageStatus.sending) {
      throw StateError('Only a sending message can become pending.');
    }
    if (reason.trim().isEmpty) {
      throw ArgumentError.value(reason, 'reason', 'Pending reason must not be empty.');
    }
    await _store.put(
      message.copyWith(
        status: OutboxMessageStatus.pending,
        pendingReason: reason,
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
        message.status != OutboxMessageStatus.pending) {
      throw StateError('Delivery acknowledgement is not valid for this outbox state.');
    }
    await _store.put(
      message.copyWith(
        status: OutboxMessageStatus.delivered,
        clearPendingReason: true,
        deliveredAt: deliveredAt.toUtc(),
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

  Future<OutboxMessage> _required(String requestId) async {
    final message = await _store.get(requestId);
    if (message == null) {
      throw StateError('Outbox message not found.');
    }
    return message;
  }
}
