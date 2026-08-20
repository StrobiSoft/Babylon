import 'dart:io';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';

import 'src/api_client.dart';
import 'src/app.dart';
import 'src/auth_controller.dart';
import 'src/file_message_outbox_store.dart';
import 'src/message_outbox.dart';
import 'src/message_delivery.dart';
import 'src/native_auth.dart';
import 'src/outbox_scope.dart';
import 'src/token_store.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  const backendUrl = String.fromEnvironment(
    'BACKEND_URL',
    defaultValue: 'http://localhost:3000',
  );
  final supportDirectory = await getApplicationSupportDirectory();
  final outboxDirectory = Directory(
    '${supportDirectory.path}${Platform.pathSeparator}outbox',
  );
  final outboxStore = await FileMessageOutboxStore.open(outboxDirectory);
  final outbox = MessageOutbox(outboxStore);

  final tokenStore = FlutterSecureTokenStore();
  final api = BabylonApiClient(
    baseUri: Uri.parse(backendUrl),
    tokenStore: tokenStore,
  );
  final delivery = MessageDeliveryCoordinator(
    outbox: outbox,
    gateway: api,
    encoder: const Utf8MessageEnvelopeEncoder(),
  );
  unawaited(delivery.recover());
  final controller = AuthController(
    api: api,
    browser: SystemBrowserLauncher(),
    callbackFactory: () => LoopbackCallbackServer(),
    secureValues: tokenStore,
  );
  runApp(
    OutboxScope(
      outbox: outbox,
      delivery: delivery,
      child: BabylonApp(controller: controller),
    ),
  );
}
