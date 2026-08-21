import 'package:flutter/widgets.dart';

import 'message_outbox.dart';
import 'message_delivery.dart';

class OutboxScope extends InheritedWidget {
  const OutboxScope({
    required this.outbox,
    this.delivery,
    required super.child,
    super.key,
  });

  final MessageOutbox outbox;
  final MessageDeliveryCoordinator? delivery;

  static MessageOutbox of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<OutboxScope>();
    if (scope == null) {
      throw StateError('OutboxScope is not available in this widget tree.');
    }
    return scope.outbox;
  }

  static MessageDeliveryCoordinator deliveryOf(BuildContext context) {
    final delivery = context.dependOnInheritedWidgetOfExactType<OutboxScope>()?.delivery;
    if (delivery == null) throw StateError('Message delivery runtime is not available.');
    return delivery;
  }

  @override
  bool updateShouldNotify(OutboxScope oldWidget) =>
      !identical(outbox, oldWidget.outbox) || !identical(delivery, oldWidget.delivery);
}
