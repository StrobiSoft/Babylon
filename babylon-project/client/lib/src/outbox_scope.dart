import 'package:flutter/widgets.dart';

import 'message_outbox.dart';

class OutboxScope extends InheritedWidget {
  const OutboxScope({
    required this.outbox,
    required super.child,
    super.key,
  });

  final MessageOutbox outbox;

  static MessageOutbox of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<OutboxScope>();
    if (scope == null) {
      throw StateError('OutboxScope is not available in this widget tree.');
    }
    return scope.outbox;
  }

  @override
  bool updateShouldNotify(OutboxScope oldWidget) => !identical(outbox, oldWidget.outbox);
}
