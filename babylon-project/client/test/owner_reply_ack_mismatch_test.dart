import 'package:babylon_client/src/owner_notification.dart';
import 'package:babylon_client/src/owner_notification_controller.dart';
import 'package:babylon_client/src/owner_reply_transport.dart';
import 'package:flutter_test/flutter_test.dart';

const eventId = '10000000-0000-4000-8000-000000000001';
const senderId = 'install_7V3W9X2Y6Z8A4BCD';
const returnRoute = 'route_8R4T2V6W9X3Y7ZAB';

OwnerNotificationDelivery delivery() => OwnerNotificationDelivery.fromJson({
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
    ],
  },
  'expansions': [
    {
      'id': '01JQ7S4C8N2W6K9D3F5H0M1PXT',
      'version': '0.1.0',
      'text': 'Action needed.',
    },
  ],
  'reply_context': {'return_route': returnRoute},
});

void main() {
  DateTime clock() => DateTime.parse('2026-09-03T00:01:00.000Z');

  test(
    'mismatched acknowledgement is ambiguous and blocks until unconsumed reconciliation',
    () async {
      var calls = 0;
      final transport = LocalOwnerReplyTransport(
        onReply: (reply) async {
          calls += 1;
          if (calls == 1) {
            return const OwnerReplyDeliveryResult.accepted(
              acceptedSequence: 7,
            );
          }
          return OwnerReplyDeliveryResult.accepted(
            acceptedSequence: reply.sequence,
          );
        },
        onReconcile: ({
          required eventId,
          required senderId,
          required returnRoute,
        }) async {
          return const OwnerReplyRemoteSnapshot(
            state: OwnerReplyRemoteState.pending,
            lastSequence: null,
            lastReplyMacroId: null,
          );
        },
      );
      final controller = OwnerNotificationController(
        delivery: delivery(),
        transport: transport,
        senderId: senderId,
        clock: clock,
      );

      await expectLater(
        controller.submit(OwnerDecision.wait),
        throwsA(isA<OwnerReplyAmbiguousDeliveryException>()),
      );
      expect(controller.state, OwnerNotificationState.pending);
      expect(controller.needsReconciliation, isTrue);
      await expectLater(
        controller.submit(OwnerDecision.approve),
        throwsStateError,
      );

      await controller.reconcilePendingReply();
      expect(controller.needsReconciliation, isFalse);
      await controller.submit(OwnerDecision.wait);

      expect(transport.attempted.map((reply) => reply.sequence), [0, 0]);
      expect(controller.state, OwnerNotificationState.waiting);
    },
  );

  test(
    'mismatched acknowledgement can reconcile a consumed WAIT before the next sequence',
    () async {
      var calls = 0;
      final transport = LocalOwnerReplyTransport(
        onReply: (reply) async {
          calls += 1;
          if (calls == 1) {
            return const OwnerReplyDeliveryResult.accepted(
              acceptedSequence: 9,
            );
          }
          return OwnerReplyDeliveryResult.accepted(
            acceptedSequence: reply.sequence,
          );
        },
        onReconcile: ({
          required eventId,
          required senderId,
          required returnRoute,
        }) async {
          return const OwnerReplyRemoteSnapshot(
            state: OwnerReplyRemoteState.waiting,
            lastSequence: 0,
            lastReplyMacroId: ownerReplyWaitId,
          );
        },
      );
      final controller = OwnerNotificationController(
        delivery: delivery(),
        transport: transport,
        senderId: senderId,
        clock: clock,
      );

      await expectLater(
        controller.submit(OwnerDecision.wait),
        throwsA(isA<OwnerReplyAmbiguousDeliveryException>()),
      );
      await controller.reconcilePendingReply();
      expect(controller.state, OwnerNotificationState.waiting);
      expect(controller.lastReply?.decision, OwnerDecision.wait);

      await controller.submit(OwnerDecision.approve);
      expect(transport.attempted.map((reply) => reply.sequence), [0, 1]);
      expect(controller.state, OwnerNotificationState.approved);
    },
  );
}
