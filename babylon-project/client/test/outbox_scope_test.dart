import 'package:babylon_client/src/message_outbox.dart';
import 'package:babylon_client/src/outbox_scope.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

class _MemoryStore implements MessageOutboxStore {
  final Map<String, OutboxMessage> messages = {};

  @override
  Future<void> delete(String requestId) async {
    messages.remove(requestId);
  }

  @override
  Future<OutboxMessage?> get(String requestId) async => messages[requestId];

  @override
  Future<List<OutboxMessage>> pendingMessages() async => messages.values.toList();

  @override
  Future<void> put(OutboxMessage message) async {
    messages[message.requestId] = message;
  }
}

void main() {
  testWidgets('exposes the application outbox to descendants', (tester) async {
    final outbox = MessageOutbox(_MemoryStore());
    MessageOutbox? resolved;

    await tester.pumpWidget(
      OutboxScope(
        outbox: outbox,
        child: Builder(
          builder: (context) {
            resolved = OutboxScope.of(context);
            return const SizedBox.shrink();
          },
        ),
      ),
    );

    expect(resolved, same(outbox));
  });

  testWidgets('fails explicitly when no outbox runtime is available', (tester) async {
    Object? error;

    await tester.pumpWidget(
      Builder(
        builder: (context) {
          try {
            OutboxScope.of(context);
          } catch (caught) {
            error = caught;
          }
          return const SizedBox.shrink();
        },
      ),
    );

    expect(error, isA<StateError>());
  });
}
