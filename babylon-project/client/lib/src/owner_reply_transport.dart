import 'owner_notification.dart';

abstract interface class OwnerReplyTransport {
  Future<void> send(OwnerDecisionReply reply);
}

/// Local fixture transport. iOS, Babylon, and future clients implement the same interface.
class LocalOwnerReplyTransport implements OwnerReplyTransport {
  LocalOwnerReplyTransport({this.onReply});

  final Future<void> Function(OwnerDecisionReply reply)? onReply;
  final List<OwnerDecisionReply> sent = [];

  @override
  Future<void> send(OwnerDecisionReply reply) async {
    await onReply?.call(reply);
    sent.add(reply);
  }
}
