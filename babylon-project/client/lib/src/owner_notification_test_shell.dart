import 'package:flutter/material.dart';

import 'owner_notification.dart';
import 'owner_notification_controller.dart';
import 'owner_reply_transport.dart';

class OwnerNotificationTestShell extends StatefulWidget {
  const OwnerNotificationTestShell({
    required this.delivery,
    required this.transport,
    required this.senderId,
    this.clock,
    super.key,
  });

  final OwnerNotificationDelivery delivery;
  final OwnerReplyTransport transport;
  final String senderId;
  final DateTime Function()? clock;

  @override
  State<OwnerNotificationTestShell> createState() =>
      _OwnerNotificationTestShellState();
}

class _OwnerNotificationTestShellState extends State<OwnerNotificationTestShell> {
  late final OwnerNotificationController controller;

  @override
  void initState() {
    super.initState();
    controller = OwnerNotificationController(
      delivery: widget.delivery,
      transport: widget.transport,
      senderId: widget.senderId,
      clock: widget.clock,
    )..addListener(_changed);
  }

  void _changed() => setState(() {});

  @override
  void dispose() {
    controller
      ..removeListener(_changed)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    theme: ThemeData(
      colorSchemeSeed: const Color(0xffd77b39),
      useMaterial3: true,
    ),
    home: Scaffold(
      appBar: AppBar(title: const Text('Owner notification reference client')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: OwnerNotificationCard(controller: controller),
          ),
        ),
      ),
    ),
  );
}

class OwnerNotificationCard extends StatelessWidget {
  const OwnerNotificationCard({required this.controller, super.key});

  final OwnerNotificationController controller;

  @override
  Widget build(BuildContext context) {
    final disabled = controller.sending || controller.terminal;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                _stateLabel(controller.state),
                key: const Key('owner-state'),
                style: Theme.of(context).textTheme.labelLarge,
              ),
              const SizedBox(height: 12),
              Text(
                controller.delivery.expandedText,
                key: const Key('owner-notification-text'),
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 8),
              Text('Event: ${controller.delivery.eventId}'),
              const SizedBox(height: 24),
              _decisionButton(
                key: const Key('owner-approve'),
                label: 'OK · MEHET',
                onPressed: disabled
                    ? null
                    : () => controller.submit(OwnerDecision.approve),
              ),
              const SizedBox(height: 12),
              _decisionButton(
                key: const Key('owner-reject'),
                label: 'SEMMIKÉPP',
                onPressed: disabled
                    ? null
                    : () => controller.submit(OwnerDecision.reject),
              ),
              const SizedBox(height: 12),
              _decisionButton(
                key: const Key('owner-wait'),
                label: 'KÉRLEK, VÁRJ',
                onPressed: disabled
                    ? null
                    : () => controller.submit(OwnerDecision.wait),
              ),
              if (controller.lastError != null) ...[
                const SizedBox(height: 12),
                Text(
                  'Reply failed: ${controller.lastError}',
                  key: const Key('owner-reply-error'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  static Widget _decisionButton({
    required Key key,
    required String label,
    required VoidCallback? onPressed,
  }) => FilledButton(
    key: key,
    onPressed: onPressed,
    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(60)),
    child: Text(label, textAlign: TextAlign.center),
  );

  static String _stateLabel(OwnerNotificationState state) => switch (state) {
    OwnerNotificationState.pending => 'DECISION REQUIRED',
    OwnerNotificationState.waiting => 'WAITING · ACKNOWLEDGED / LÁTVA',
    OwnerNotificationState.approved => 'APPROVED · TERMINAL',
    OwnerNotificationState.rejected => 'REJECTED · TERMINAL',
  };
}
