import 'owner_notification.dart';

enum OwnerReplyDeliveryDisposition { accepted, rejected, ambiguous }

class OwnerReplyDeliveryResult {
  const OwnerReplyDeliveryResult._({
    required this.disposition,
    this.acceptedSequence,
    this.code,
    this.message,
  });

  const OwnerReplyDeliveryResult.accepted({required int acceptedSequence})
      : this._(
          disposition: OwnerReplyDeliveryDisposition.accepted,
          acceptedSequence: acceptedSequence,
        );

  const OwnerReplyDeliveryResult.rejected({
    required String code,
    String? message,
  }) : this._(
          disposition: OwnerReplyDeliveryDisposition.rejected,
          code: code,
          message: message,
        );

  const OwnerReplyDeliveryResult.ambiguous({String? message})
      : this._(
          disposition: OwnerReplyDeliveryDisposition.ambiguous,
          message: message,
        );

  final OwnerReplyDeliveryDisposition disposition;
  final int? acceptedSequence;
  final String? code;
  final String? message;
}

enum OwnerReplyRemoteState { pending, waiting, approved, rejected }

class OwnerReplyRemoteSnapshot {
  const OwnerReplyRemoteSnapshot({
    required this.state,
    required this.lastSequence,
    required this.lastReplyMacroId,
  });

  final OwnerReplyRemoteState state;
  final int? lastSequence;
  final String? lastReplyMacroId;
}

class OwnerReplyRejectedException implements Exception {
  const OwnerReplyRejectedException(this.code, [this.message]);

  final String code;
  final String? message;

  @override
  String toString() => message == null
      ? 'Owner reply rejected: $code'
      : 'Owner reply rejected: $code ($message)';
}

class OwnerReplyAmbiguousDeliveryException implements Exception {
  const OwnerReplyAmbiguousDeliveryException([this.message]);

  final String? message;

  @override
  String toString() => message == null
      ? 'Owner reply delivery outcome is ambiguous'
      : 'Owner reply delivery outcome is ambiguous: $message';
}

abstract interface class OwnerReplyTransport {
  Future<OwnerReplyDeliveryResult> send(OwnerDecisionReply reply);

  /// Returns the authoritative remote state for one event/sender/route binding.
  ///
  /// Native/private transports use this after a timeout or connection loss so
  /// the client never allocates a higher sequence until it knows whether the
  /// previous reply was consumed.
  Future<OwnerReplyRemoteSnapshot> reconcile({
    required String eventId,
    required String senderId,
    required String returnRoute,
  });
}

typedef LocalOwnerReplyCallback =
    Future<OwnerReplyDeliveryResult> Function(OwnerDecisionReply reply);
typedef LocalOwnerReplyReconcileCallback =
    Future<OwnerReplyRemoteSnapshot> Function({
      required String eventId,
      required String senderId,
      required String returnRoute,
    });

/// Local fixture transport. iOS, Babylon, and future clients implement the
/// same outcome-aware interface.
class LocalOwnerReplyTransport implements OwnerReplyTransport {
  LocalOwnerReplyTransport({this.onReply, this.onReconcile});

  final LocalOwnerReplyCallback? onReply;
  final LocalOwnerReplyReconcileCallback? onReconcile;
  final List<OwnerDecisionReply> attempted = [];
  final List<OwnerDecisionReply> sent = [];

  OwnerReplyRemoteSnapshot _snapshot = const OwnerReplyRemoteSnapshot(
    state: OwnerReplyRemoteState.pending,
    lastSequence: null,
    lastReplyMacroId: null,
  );

  @override
  Future<OwnerReplyDeliveryResult> send(OwnerDecisionReply reply) async {
    attempted.add(reply);
    final result = await onReply?.call(reply) ??
        OwnerReplyDeliveryResult.accepted(
          acceptedSequence: reply.sequence,
        );
    if (result.disposition == OwnerReplyDeliveryDisposition.accepted) {
      final acceptedSequence = result.acceptedSequence;
      if (acceptedSequence == null) {
        throw StateError('Accepted reply result must include acceptedSequence');
      }
      sent.add(reply);
      _snapshot = OwnerReplyRemoteSnapshot(
        state: switch (reply.decision) {
          OwnerDecision.approve => OwnerReplyRemoteState.approved,
          OwnerDecision.reject => OwnerReplyRemoteState.rejected,
          OwnerDecision.wait => OwnerReplyRemoteState.waiting,
        },
        lastSequence: acceptedSequence,
        lastReplyMacroId: reply.decision.replyMacroId,
      );
    }
    return result;
  }

  @override
  Future<OwnerReplyRemoteSnapshot> reconcile({
    required String eventId,
    required String senderId,
    required String returnRoute,
  }) async {
    return await onReconcile?.call(
          eventId: eventId,
          senderId: senderId,
          returnRoute: returnRoute,
        ) ??
        _snapshot;
  }
}
