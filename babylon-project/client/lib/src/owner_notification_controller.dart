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

  OwnerNotificationState get state => _state;
  bool get sending => _sending;
  bool get terminal =>
      _state == OwnerNotificationState.approved ||
      _state == OwnerNotificationState.rejected;
  Object? get lastError => _lastError;
  OwnerDecisionReply? get lastReply => _lastReply;

  Future<void> submit(OwnerDecision decision) async {
    if (_sending) throw StateError('A reply is already being sent');
    if (terminal) throw StateError('The event already has a terminal decision');
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
      await transport.send(reply);
      _nextSequence += 1;
      _lastReply = reply;
      _state = switch (decision) {
        OwnerDecision.approve => OwnerNotificationState.approved,
        OwnerDecision.reject => OwnerNotificationState.rejected,
        OwnerDecision.wait => OwnerNotificationState.waiting,
      };
    } catch (error) {
      _lastError = error;
      rethrow;
    } finally {
      _sending = false;
      _notifyListeners();
    }
  }

  void _notifyListeners() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
