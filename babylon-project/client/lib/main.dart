import 'package:flutter/material.dart';

import 'src/api_client.dart';
import 'src/app.dart';
import 'src/auth_controller.dart';
import 'src/native_auth.dart';
import 'src/token_store.dart';

void main() {
  const backendUrl = String.fromEnvironment(
    'BACKEND_URL',
    defaultValue: 'http://localhost:3000',
  );
  final api = BabylonApiClient(
    baseUri: Uri.parse(backendUrl),
    tokenStore: FlutterSecureTokenStore(),
  );
  final controller = AuthController(
    api: api,
    browser: SystemBrowserLauncher(),
    callbackFactory: () => LoopbackCallbackServer(),
    secureValues: FlutterSecureTokenStore(),
  );
  runApp(BabylonApp(controller: controller));
}
