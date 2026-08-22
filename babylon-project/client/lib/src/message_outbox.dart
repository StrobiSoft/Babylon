enum OutboxMessageStatus {
  queued,
  sending,
  pending,
  delivered,
  expired,
  failed,
}

enum DeliveryFailureKind {
  network,
  backend,
  authenticationRequired,
  authorizationDenied,
  model,
  permanent,
}

enum OutboxRecoveryAction { send, reconcile }

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
    this.reconcileAttemptCount = 0,
    this.recoveryAction = OutboxRecoveryAction.send,
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
  final int reconcileAttemptCount;
  final OutboxRecoveryAction recoveryAction;
  final DateTime? nextAttemptAt;
  final DateTime? expiresAt;
  final DeliveryFailureKind? failureKind;

  OutboxMessage copyWith({
    OutboxMessageStatus? status,
    String? pendingReason,
    bool clearPendingReason = false,
    DateTime? deliveredAt,
    int? attemptCount,
    int? reconcileAttemptCount,
    OutboxRecoveryAction? recoveryAction,
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
      reconcileAttemptCount: reconcileAttemptCount ?? this.reconcileAttemptCount,
      recoveryAction: recoveryAction ?? this.recoveryAction,
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
  Future<List<OutboxMessage>> allMessages();
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
        recoveryAction: OutboxRecoveryAction.send,
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
    OutboxRecoveryAction recoveryAction = OutboxRecoveryAction.send,
    bool resetReconcileAttempts = false,
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
        recoveryAction: recoveryAction,
        reconcileAttemptCount: resetReconcileAttempts ? 0 : null,
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
        recoveryAction: OutboxRecoveryAction.send,
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
  Future<List<OutboxMessage>> allMessages() => _store.allMessages();
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
        recoveryAction: OutboxRecoveryAction.send,
        nextAttemptAt: terminal
            ? null
            : now.add(Duration(seconds: 1 << (attempts - 1).clamp(0, 6))),
        clearNextAttemptAt: terminal,
        pendingReason: kind.name,
      ),
    );
  }

  /// Persists a non-timed recovery state without spending the transient retry
  /// budget. Only an explicit authenticated-session signal may resume it.
  Future<void> pauseForAccessFailure(
    String requestId,
    DeliveryFailureKind kind,
  ) async {
    if (kind != DeliveryFailureKind.authenticationRequired &&
        kind != DeliveryFailureKind.authorizationDenied) {
      throw ArgumentError.value(kind, 'kind', 'An access failure is required.');
    }
    final message = await _required(requestId);
    await _store.put(
      message.copyWith(
        status: OutboxMessageStatus.pending,
        failureKind: kind,
        pendingReason: kind.name,
        clearNextAttemptAt: true,
      ),
    );
  }

  Future<void> resumeAfterAccessRestored(String requestId) async {
    final message = await _required(requestId);
    if (message.failureKind != DeliveryFailureKind.authenticationRequired &&
        message.failureKind != DeliveryFailureKind.authorizationDenied) {
      return;
    }
    await _store.put(
      message.copyWith(
        status: OutboxMessageStatus.queued,
        clearPendingReason: true,
        clearNextAttemptAt: true,
        clearFailureKind: true,
      ),
    );
  }

  Future<void> recordReconcileFailure(
    String requestId,
    DeliveryFailureKind kind,
    DateTime now,
  ) async {
    final message = await _required(requestId);
    final attempts = message.reconcileAttemptCount + 1;
    final expired = message.expiresAt != null && !message.expiresAt!.isAfter(now);
    await _store.put(
      message.copyWith(
        status: expired ? OutboxMessageStatus.expired : OutboxMessageStatus.pending,
        failureKind: kind,
        reconcileAttemptCount: attempts,
        recoveryAction: OutboxRecoveryAction.reconcile,
        nextAttemptAt: expired
            ? null
            : now.add(Duration(seconds: 1 << (attempts - 1).clamp(0, 6))),
        clearNextAttemptAt: expired,
        pendingReason: expired ? 'client_expired' : 'reconcile_${kind.name}',
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
