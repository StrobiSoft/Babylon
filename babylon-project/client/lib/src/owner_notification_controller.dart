import 'package:flutter/foundation.dart';

import 'owner_notification.dart';
import 'owner_reply_transport.dart';

enum OwnerNotificationState { pending, waiting, approved, rejected }

class OwnerNotificationController extends ChangeNotifier {
  OwnerNotificationController({
    required this.delivery,
    required this.transport,
    required this.senderId,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final OwnerNotificationDelivery delivery;
  final OwnerReplyTransport transport;
  final String senderId;
  final DateTime Function() _clock;
  OwnerNotificationState _state = OwnerNotificationState.pending;
  int _nextSequence = 0;
  bool _sending = false;
  bool _disposed = false;
  Object? _lastError;
  OwnerDecisionReply? _lastReply;
  OwnerDecisionReply? _pendingAmbiguousReply;

  OwnerNotificationState get state => _state;
  bool get sending => _sending;
  bool get terminal =>
      _state == OwnerNotificationState.approved ||
      _state == OwnerNotificationState.rejected;
  bool get needsReconciliation => _pendingAmbiguousReply != null;
  Object? get lastError => _lastError;
  OwnerDecisionReply? get lastReply => _lastReply;
  OwnerDecisionReply? get pendingAmbiguousReply => _pendingAmbiguousReply;

  Future<void> submit(OwnerDecision decision) async {
    if (_sending) throw StateError('A reply is already being sent');
    if (terminal) throw StateError('The event already has a terminal decision');
    if (_pendingAmbiguousReply != null) {
      throw StateError(
        'The previous reply outcome must be reconciled before another reply',
      );
    }
    final reply = OwnerDecisionReply(
      eventId: delivery.eventId,
      decision: decision,
      timestamp: _clock(),
      sequence: _nextSequence,
      senderId: senderId,
      returnRoute: delivery.returnRoute,
    );
    _sending = true;
    _lastError = null;
    _notifyListeners();
    try {
      final result = await transport.send(reply);
      switch (result.disposition) {
        case OwnerReplyDeliveryDisposition.accepted:
          final acceptedSequence = result.acceptedSequence;
          if (acceptedSequence != reply.sequence) {
            final error = OwnerReplyAmbiguousDeliveryException(
              'acknowledgement sequence mismatch: '
              'sent ${reply.sequence}, accepted $acceptedSequence',
            );
            _pendingAmbiguousReply = reply;
            _lastError = error;
            throw error;
          }
          _acceptReply(reply);
        case OwnerReplyDeliveryDisposition.rejected:
          final error = OwnerReplyRejectedException(
            result.code ?? 'REJECTED',
            result.message,
          );
          _lastError = error;
          throw error;
        case OwnerReplyDeliveryDisposition.ambiguous:
          final error = OwnerReplyAmbiguousDeliveryException(result.message);
          _pendingAmbiguousReply = reply;
          _lastError = error;
          throw error;
      }
    } catch (error) {
      _lastError ??= error;
      rethrow;
    } finally {
      _sending = false;
      _notifyListeners();
    }
  }

  /// Resolves a timeout/connection-loss ambiguity against the authoritative
  /// N Agent route state before any higher reply sequence can be allocated.
  ///
  /// A native runtime should call this automatically after connectivity is
  /// restored. It is deliberately a controller operation, not a user-facing
  /// decision or retry button.
  Future<void> reconcilePendingReply() async {
    final pending = _pendingAmbiguousReply;
    if (pending == null) return;
    if (_sending) throw StateError('A reply operation is already in progress');

    _sending = true;
    _lastError = null;
    _notifyListeners();
    try {
      final snapshot = await transport.reconcile(
        eventId: pending.eventId,
        senderId: pending.senderId,
        returnRoute: pending.returnRoute,
      );
      final remoteLastSequence = snapshot.lastSequence;
      _state = _stateFromRemote(snapshot.state);
      _nextSequence = (remoteLastSequence ?? -1) + 1;

      final pendingWasAccepted =
          remoteLastSequence != null &&
          remoteLastSequence >= pending.sequence &&
          snapshot.lastReplyMacroId == pending.decision.replyMacroId;
      if (pendingWasAccepted) _lastReply = pending;

      // Whether the peer accepted the pending reply or proves that it did not,
      // the ambiguity is now resolved. If it was not consumed, _nextSequence
      // remains the original value and a retry reuses the same sequence.
      _pendingAmbiguousReply = null;
    } catch (error) {
      _lastError = error;
      rethrow;
    } finally {
      _sending = false;
      _notifyListeners();
    }
  }

  void _acceptReply(OwnerDecisionReply reply) {
    _nextSequence = reply.sequence + 1;
    _lastReply = reply;
    _state = switch (reply.decision) {
      OwnerDecision.approve => OwnerNotificationState.approved,
      OwnerDecision.reject => OwnerNotificationState.rejected,
      OwnerDecision.wait => OwnerNotificationState.waiting,
    };
  }

  static OwnerNotificationState _stateFromRemote(
    OwnerReplyRemoteState state,
  ) => switch (state) {
    OwnerReplyRemoteState.pending => OwnerNotificationState.pending,
    OwnerReplyRemoteState.waiting => OwnerNotificationState.waiting,
    OwnerReplyRemoteState.approved => OwnerNotificationState.approved,
    OwnerReplyRemoteState.rejected => OwnerNotificationState.rejected,
  };

  void _notifyListeners() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
