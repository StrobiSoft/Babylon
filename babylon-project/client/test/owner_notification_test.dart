import 'dart:convert';

import 'package:babylon_client/src/owner_notification.dart';
import 'package:babylon_client/src/owner_notification_controller.dart';
import 'package:babylon_client/src/owner_notification_test_shell.dart';
import 'package:babylon_client/src/owner_reply_transport.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

const eventId = '10000000-0000-4000-8000-000000000001';
const senderId = 'install_7V3W9X2Y6Z8A4BCD';
const returnRoute = 'route_8R4T2V6W9X3Y7ZAB';

Map<String, dynamic> fixtureJson() => {
  'notification': {
    'protocolVersion': '0.1',
    'eventId': eventId,
    'messageId': '20000000-0000-4000-8000-000000000002',
    'createdAt': '2026-09-03T00:00:00.000Z',
    'sequence': {'message': 21},
    'replay': {'attempt': 0},
    'fragments': [
      {
        'kind': 'macro',
        'group': 'attention',
        'macroId': '01JQ7S4C8N2W6K9D3F5H0M1PXT',
        'macroVersion': '0.1.0',
      },
      {
        'kind': 'macro',
        'group': 'status',
        'macroId': '01JQ7Y3M8C5N2K9D6F4H0R1BVA',
        'macroVersion': '0.1.0',
      },
      {'kind': 'optional_text', 'text': 'Deploy build 42.'},
    ],
  },
  'expansions': [
    {
      'id': '01JQ7S4C8N2W6K9D3F5H0M1PXT',
      'version': '0.1.0',
      'text': 'Action needed.',
    },
    {
      'id': '01JQ7Y3M8C5N2K9D6F4H0R1BVA',
      'version': '0.1.0',
      'text': 'A decision is required.',
    },
  ],
  'reply_context': {'return_route': returnRoute},
};

void main() {
  final clock = () => DateTime.parse('2026-09-03T00:01:00.000Z');

  test(
    'parses IDs plus separate endpoint expansions and rejects missing data',
    () {
      final delivery = OwnerNotificationDelivery.fromJson(fixtureJson());
      expect(
        delivery.expandedText,
        'Action needed. A decision is required. Deploy build 42.',
      );
      final invalid = fixtureJson()..['expansions'] = <dynamic>[];
      expect(
        () => OwnerNotificationDelivery.fromJson(invalid),
        throwsFormatException,
      );
    },
  );

  test('serializes the compact owner reply deterministically', () {
    final reply = OwnerDecisionReply(
      eventId: eventId,
      decision: OwnerDecision.approve,
      timestamp: clock(),
      sequence: 9,
      senderId: senderId,
      returnRoute: returnRoute,
    );
    expect(
      reply.serialize(),
      '{"protocol_version":"0.1","event_id":"$eventId",'
      '"reply_macro_id":"$ownerReplyOkId","sequence":9,'
      '"timestamp":"2026-09-03T00:01:00.000Z","sender_id":"$senderId",'
      '"return_route":"$returnRoute"}',
    );
    expect(jsonDecode(reply.serialize()), reply.toJson());
  });

  for (final expectation in const [
    (OwnerDecision.approve, OwnerNotificationState.approved, true),
    (OwnerDecision.reject, OwnerNotificationState.rejected, true),
    (OwnerDecision.wait, OwnerNotificationState.waiting, false),
  ]) {
    test(
      '${expectation.$1.name} produces the expected client state',
      () async {
        final transport = LocalOwnerReplyTransport();
        final controller = OwnerNotificationController(
          delivery: OwnerNotificationDelivery.fromJson(fixtureJson()),
          transport: transport,
          senderId: senderId,
          clock: clock,
        );
        await controller.submit(expectation.$1);
        expect(controller.state, expectation.$2);
        expect(controller.terminal, expectation.$3);
        expect(transport.sent.single.decision, expectation.$1);
        expect(transport.sent.single.sequence, 0);
      },
    );
  }

  test(
    'WAIT pauses visibly and a later terminal choice uses the next sequence',
    () async {
      final transport = LocalOwnerReplyTransport();
      final controller = OwnerNotificationController(
        delivery: OwnerNotificationDelivery.fromJson(fixtureJson()),
        transport: transport,
        senderId: senderId,
        clock: clock,
      );
      await controller.submit(OwnerDecision.wait);
      expect(controller.state, OwnerNotificationState.waiting);
      expect(controller.terminal, isFalse);
      await controller.submit(OwnerDecision.reject);
      expect(controller.state, OwnerNotificationState.rejected);
      expect(transport.sent.map((reply) => reply.sequence), [0, 1]);
    },
  );

  testWidgets('local fixture renders and sends all three structured owner decisions', (
    tester,
  ) async {
    for (final choice in const [
      (Key('owner-approve'), OwnerDecision.approve),
      (Key('owner-reject'), OwnerDecision.reject),
      (Key('owner-wait'), OwnerDecision.wait),
    ]) {
      Map<String, dynamic>? receivedWire;
      final transport = LocalOwnerReplyTransport(
        onReply: (reply) async {
          receivedWire = jsonDecode(reply.serialize()) as Map<String, dynamic>;
        },
      );
      await tester.pumpWidget(
        OwnerNotificationTestShell(
          key: ValueKey(choice.$2),
          delivery: OwnerNotificationDelivery.fromJson(fixtureJson()),
          transport: transport,
          senderId: senderId,
          clock: clock,
        ),
      );
      expect(
        find.text('Action needed. A decision is required. Deploy build 42.'),
        findsOneWidget,
      );
      await tester.tap(find.byKey(choice.$1));
      await tester.pumpAndSettle();
      expect(transport.sent.single.decision, choice.$2);
      expect(transport.sent.single.eventId, eventId);
      expect(transport.sent.single.sequence, 0);
      expect(receivedWire, {
        'protocol_version': '0.1',
        'event_id': eventId,
        'reply_macro_id': choice.$2.replyMacroId,
        'sequence': 0,
        'timestamp': '2026-09-03T00:01:00.000Z',
        'sender_id': senderId,
        'return_route': returnRoute,
      });
    }
  });

  testWidgets(
    'WAIT is acknowledged without disabling a later decision',
    (tester) async {
      final transport = LocalOwnerReplyTransport();
      await tester.pumpWidget(
        OwnerNotificationTestShell(
          delivery: OwnerNotificationDelivery.fromJson(fixtureJson()),
          transport: transport,
          senderId: senderId,
          clock: clock,
        ),
      );
      await tester.tap(find.byKey(const Key('owner-wait')));
      await tester.pumpAndSettle();
      expect(find.text('WAITING · ACKNOWLEDGED / LÁTVA'), findsOneWidget);
      await tester.tap(find.byKey(const Key('owner-approve')));
      await tester.pumpAndSettle();
      expect(find.text('APPROVED · TERMINAL'), findsOneWidget);
      expect(transport.sent.map((reply) => reply.sequence), [0, 1]);
    },
  );
}
